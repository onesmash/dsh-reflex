#!/usr/bin/env python3
"""判据 A/B: 同一批 state、两套判据 (tag A / tag B), 在标注样本上比 Precision/Recall 与拟合阈值。

用途
  想验证"改判据措辞"是否比"调阈值"更有效时: 用 shadow 回放把历史 facts 分别跑两套判据
  (两套判据写在不同 target 脚本里, shadow 记录落在不同 tag), 再用同一份人工标签对比。

对齐方式
  两套判据的 question 不同 → key 不同; 但 state 构造相同 → 用 state_hash 对齐。
  标签文件是 idx 形式, 经 sample-<labels-tag>.json (idx→key) 映射到 A 的 key, 再折算成 state_hash。

用法
  python3 tools/shadow_ab.py --tag-a x-timeline --tag-b xtl-v2 \
      --labels-tag x-timeline --mode replay --current-threshold 0.88
"""
import argparse
import glob
import hashlib
import json
import os
import statistics
import sys

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")


def load_tag(home, tag, mode):
    by_state = {}
    for f in sorted(glob.glob(os.path.join(home, "shadow", f"{tag}-*.jsonl"))):
        base = os.path.basename(f)
        if base.startswith(("labels-", "sample-", "ab-")):
            continue
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if mode != "both" and r.get("mode") != mode:
                    continue
                if r.get("tag") != tag or r.get("score") is None:
                    continue
                sh = r.get("state_hash") or hashlib.sha1(
                    str(r.get("state") or "").encode("utf-8", "replace")
                ).hexdigest()[:16]
                r["state_hash"] = sh
                by_state[sh] = r          # 同 state 保留最后一次
    return by_state


def load_labels(home, labels_tag):
    path = os.path.join(home, "shadow", f"labels-{labels_tag}.jsonl")
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        lab = o.get("label")
        if lab in (0, 1, "0", "1", True, False):
            out[int(o["idx"])] = int(lab)
    return out


def load_manifest(home, labels_tag):
    path = os.path.join(home, "shadow", f"sample-{labels_tag}.json")
    if not os.path.exists(path):
        return []
    raw = json.load(open(path))
    if isinstance(raw, dict) and "items" in raw:
        return raw["items"]
    return [{"idx": int(k), "key": v, "w": 1.0} for k, v in raw.items()]


def weighted_metrics(scores, labels, weights, tau):
    tp = fp = fn = tn = 0.0
    for s, y, w in zip(scores, labels, weights):
        if s >= tau:
            if y:
                tp += w
            else:
                fp += w
        elif y:
            fn += w
        else:
            tn += w
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
    }


def fit_tau(scores, labels, weights, R):
    pts = sorted(zip(scores, labels, weights), key=lambda t: t[0])
    best_t, best_u = pts[0][0], None
    for tau in sorted({s for s, _, _ in pts}):
        u = sum(w * ((R if y else 0.0) - 1.0) for s, y, w in pts if s >= tau)
        if best_u is None or u > best_u:
            best_t, best_u = tau, u
    return best_t, best_u


def fmt(x):
    return "-" if x is None else f"{x*100:.1f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag-a", required=True)
    ap.add_argument("--tag-b", required=True)
    ap.add_argument("--labels-tag", default="", help="标签来自哪个 tag 的 sample 清单 (默认 = tag-a)")
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--mode", default="replay", choices=["replay", "live", "both"])
    ap.add_argument("--ratios", default="1,2,4")
    ap.add_argument("--current-threshold", type=float, default=None)
    a = ap.parse_args()

    labels_tag = a.labels_tag or a.tag_a
    A = load_tag(a.home, a.tag_a, a.mode)
    B = load_tag(a.home, a.tag_b, a.mode)
    labels = load_labels(a.home, labels_tag)
    manifest = load_manifest(a.home, labels_tag)
    if not labels or not manifest:
        print("没有标签或 sample 清单", file=sys.stderr)
        return 2

    rows, miss_a, miss_b = [], 0, 0
    if labels_tag == a.tag_a:
        A_by_key = {r["key"]: r for r in A.values()}
        for it in manifest:
            idx = int(it["idx"])
            if idx not in labels:
                continue
            ra = A_by_key.get(it["key"])
            if ra is None:
                miss_a += 1
                continue
            rb = B.get(ra["state_hash"])
            if rb is None:
                miss_b += 1
                continue
            rows.append({"idx": idx, "y": labels[idx], "w": float(it.get("w") or 1.0),
                         "sa": ra["score"], "sb": rb["score"], "state": ra.get("state") or ""})
    else:
        # 标签来自另一个 tag (如 v1), 两个 tag 的判据都不同 -> 统一用 state_hash 对齐
        L = load_tag(a.home, labels_tag, a.mode)
        L_by_key = {r["key"]: r for r in L.values()}
        label_by_hash = {}
        for it in manifest:
            idx = int(it["idx"])
            if idx not in labels:
                continue
            rl = L_by_key.get(it["key"])
            if rl is None:
                miss_a += 1
                continue
            label_by_hash[rl["state_hash"]] = (labels[idx], float(it.get("w") or 1.0), idx)
        for r in A.values():
            hit = label_by_hash.get(r["state_hash"])
            if hit is None:
                continue
            rb = B.get(r["state_hash"])
            if rb is None:
                miss_b += 1
                continue
            rows.append({"idx": hit[2], "y": hit[0], "w": hit[1],
                         "sa": r["score"], "sb": rb["score"], "state": r.get("state") or ""})
    if not rows:
        print("A/B 对齐后没有重叠样本", file=sys.stderr)
        return 2

    scores_a = [r["sa"] for r in rows]
    scores_b = [r["sb"] for r in rows]
    ys = [r["y"] for r in rows]
    ws = [r["w"] for r in rows]
    ratios = [float(x) for x in a.ratios.split(",") if x.strip()]

    report = [f"# 判据 A/B: {a.tag_a} vs {a.tag_b} ({a.mode})\n",
              f"- 对齐样本: **{len(rows)}** 条 (A 缺 {miss_a}, B 缺 {miss_b})",
              f"- 正例率: {fmt(sum(ys) / len(ys))}",
              f"- 分数中位数: A {statistics.median(scores_a):.3f} / B {statistics.median(scores_b):.3f}",
              ""]

    taus = sorted({t for t in
                   ([a.current_threshold] if a.current_threshold is not None else []) +
                   [fit_tau(scores_a, ys, ws, R)[0] for R in ratios] +
                   [fit_tau(scores_b, ys, ws, R)[0] for R in ratios]})
    report.append("## 同一阈值下的 P/R\n")
    report.append("| 阈值 | A Precision | A Recall | B Precision | B Recall |")
    report.append("|---|---|---|---|---|")
    for tau in taus:
        ma = weighted_metrics(scores_a, ys, ws, tau)
        mb = weighted_metrics(scores_b, ys, ws, tau)
        mark = " **(当前)**" if a.current_threshold is not None and abs(tau - a.current_threshold) < 1e-9 else ""
        report.append(f"| {tau:.3f}{mark} | {fmt(ma['precision'])} | {fmt(ma['recall'])} | "
                      f"{fmt(mb['precision'])} | {fmt(mb['recall'])} |")
    report.append("")

    base_rate = sum(ys) / len(ys)
    report.append("## 固定基线 (同一标注样本, 未加权)\n")
    report.append(f"- 全唤醒 always-wake: Precision {fmt(base_rate)} / Recall 100.0%")
    report.append(f"- 全压制 always-suppress: Precision - / Recall 0.0%")
    report.append(f"- 同量随机: 期望 Precision {fmt(base_rate)}, Recall = 唤醒量/N\n")
    report.append("## 各自拟合阈值\n")
    report.append("| R | A 阈值 | A 效用 | B 阈值 | B 效用 |")
    report.append("|---|---|---|---|---|")
    for R in ratios:
        ta, ua = fit_tau(scores_a, ys, ws, R)
        tb, ub = fit_tau(scores_b, ys, ws, R)
        report.append(f"| {R:g} | {ta:.3f} | {ua:.1f} | {tb:.3f} | {ub:.1f} |")
    report.append("")

    report.append("## 分数变化最大 (B − A)\n")
    report.append("| idx | 标签 | A | B | Δ | state 摘要 |")
    report.append("|---|---|---|---|---|---|")
    ranked = sorted(rows, key=lambda r: r["sb"] - r["sa"])
    shown = ranked[:8] + ranked[-8:]
    seen = set()
    for r in shown:
        if r["idx"] in seen:
            continue
        seen.add(r["idx"])
        body = r["state"].split("\n\n", 1)[-1].replace("\n", " ")[:80]
        report.append(f"| {r['idx']} | {r['y']} | {r['sa']:.3f} | {r['sb']:.3f} | {r['sb']-r['sa']:+.3f} | {body} |")
    report.append("")

    out = os.path.join(a.home, "shadow", f"ab-{a.tag_a}-vs-{a.tag_b}.md")
    open(out, "w", encoding="utf-8").write("\n".join(report) + "\n")
    print("\n".join(report))
    print(f"\n报告已写入 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
