#!/usr/bin/env python3
"""tune-ab — 改判据前的强制 A/B（O8）。

为什么（2026-11-14）
  凭语义直觉改了一版判据，AUC 从 0.873 掉到 0.769，真摩擦全被压到 0.28 以下——
  方向完全反，而且「跨窗集合」那条差式当时看起来还挺自洽。没有 A/B 就会上线。

做什么
  取**同一批标注样本**（`shadow/sample-<tag>.json` 的 idx→key + `labels-<tag>.jsonl`），
  用两套判据（judge JSON / options JSON，含 question + options）各打一次分，
  在同一阈值下比较 AUC 与 P/R，给出裁决：
    accept  —— AUC 提升 ≥ margin 且 P 不退化（退出码 0，可以改 target）
    reject  —— AUC 下降 ≥ margin（退出码 3，禁止改 target）
    inconclusive —— 差异在噪声内（退出码 2，需更多样本）

用法
  python3 tools/tune-ab.py --tag jev-friction \
      --a judge/jev-friction.json --b /tmp/new-rubric.json \
      [--tau 0.49] [--labels shadow/labels-jev-friction.jsonl] [--score-cmd <cmd>]

产物
  $REFLEX_HOME/shadow/ab-<tag>-<hashA>-<hashB>.md  + 同名 .meta.json（O10 口径自证）
"""
import argparse
import glob
import json
import os
import subprocess
import sys

HOME = os.path.expanduser(os.environ.get("REFLEX_HOME", "~/.dsh/dsh-reflex"))


def read_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def rubric_of(path):
    """接受 judge 文件（含 question+options）或裸 options 数组。"""
    d = read_json(path)
    if isinstance(d, list):
        return "", d
    return d.get("question") or "", d.get("options") or []


def rubric_hash(question, options):
    import hashlib
    canon = {"question": question or "",
             "options": [{"id": str(o.get("id")), "description": o.get("description") or ""}
                         for o in options]}
    blob = json.dumps(canon, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def load_shadow_states(tag):
    """key -> (state, question)。跨天合并，同 key 保留最新。"""
    out = {}
    for p in sorted(glob.glob(os.path.join(HOME, "shadow", f"{tag}-*.jsonl"))):
        if "dict-backup" in p or ".bak" in p:
            continue
        for line in open(p, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            k = d.get("key")
            if k:
                out[k] = (d.get("state") or "", d.get("question") or "", d.get("ts") or 0)
    return out


def load_labels(path):
    labs = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("label") in (0, 1) and "idx" in d:
            labs[int(d["idx"])] = int(d["label"])
    return labs


def auc(scores, labels):
    """秩统计 AUC（含并列处理）。"""
    pairs = sorted(zip(scores, labels), key=lambda t: t[0])
    n = len(pairs)
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        avg = (i + j) / 2.0 + 1
        for k in range(i, j + 1):
            ranks[k] = avg
        i = j + 1
    pos = [r for r, (_, y) in zip(ranks, pairs) if y == 1]
    neg = [r for r, (_, y) in zip(ranks, pairs) if y == 0]
    if not pos or not neg:
        return None
    return (sum(pos) - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def pr_at(scores, labels, tau):
    tp = sum(1 for s, y in zip(scores, labels) if s >= tau and y == 1)
    fp = sum(1 for s, y in zip(scores, labels) if s >= tau and y == 0)
    fn = sum(1 for s, y in zip(scores, labels) if s < tau and y == 1)
    return (tp / (tp + fp) if tp + fp else None,
            tp / (tp + fn) if tp + fn else None, tp, fp, fn)


def resolve_score_cmd():
    """打分器解析顺序：$REFLEX_SCORE_CMD → tools/resolve-scorer.sh → 报错。

    为什么不内置默认路径：本机是 jev 后端 + 源码仓里的 jev-score.mjs，
    别人装的是 npm 包 + 本地 SemIf，路径完全不同。硬编码就是换台机器必挂。
    """
    env = os.environ.get("REFLEX_SCORE_CMD")
    if env:
        return env
    cands = [os.path.join(HOME, "tools", "resolve-scorer.sh"),
             os.path.expanduser("~/.agents/skills/reflex-tuning/scripts/resolve-scorer.sh")]
    for c in cands:
        if os.path.exists(c):
            rc = subprocess.run(["bash", c], capture_output=True, text=True)
            out = [x.strip() for x in (rc.stdout or "").splitlines() if x.strip()]
            if rc.returncode == 0 and out:
                return out[-1]
    raise SystemExit("tune-ab: 无法解析打分器。用 --score-cmd 指定，或设 REFLEX_SCORE_CMD，"
                     "或确保 tools/resolve-scorer.sh 可用")


def score_rows(rows, score_cmd, out_path):
    inp = out_path + ".in.jsonl"
    with open(inp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    rc = subprocess.run([score_cmd, "--input", inp, "--output", out_path],
                        capture_output=True, text=True)
    if rc.returncode != 0:
        sys.stderr.write(rc.stderr[-800:])
        raise SystemExit(f"tune-ab: 打分器失败 rc={rc.returncode}")
    got = {}
    for line in open(out_path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        ids = d.get("option_ids") or []
        probs = d.get("probabilities") or []
        if "yes" in ids:
            got[d["id"]] = float(probs[ids.index("yes")])
    return got


def main():
    global HOME
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--a", required=True, help="旧判据（judge JSON 或 options JSON）")
    ap.add_argument("--b", required=True, help="新判据（同上）")
    ap.add_argument("--tau", type=float, default=None)
    ap.add_argument("--margin", type=float, default=0.02, help="AUC 显著性门槛（默认 0.02）")
    ap.add_argument("--labels", default=None)
    ap.add_argument("--sample", default=None)
    ap.add_argument("--score-cmd", default=None,
                    help="打分器命令；默认走 $REFLEX_SCORE_CMD 或 resolve-scorer.sh 自动解析")
    ap.add_argument("--home", default=HOME)
    a = ap.parse_args()

    HOME = os.path.expanduser(a.home)

    tau = a.tau
    if tau is None:
        reg_p = os.path.join(HOME, "tools", "shadow_targets.json")
        reg = read_json(reg_p) if os.path.exists(reg_p) else {}
        tau = (reg.get(a.tag) or {}).get("threshold")
    if tau is None:
        raise SystemExit("tune-ab: 没给 --tau，registry 里也没有该 tag 的 threshold")

    a.score_cmd = a.score_cmd or resolve_score_cmd()
    qa, oa = rubric_of(a.a)
    qb, ob = rubric_of(a.b)
    ha, hb = rubric_hash(qa, oa), rubric_hash(qb, ob)
    if ha == hb:
        raise SystemExit("tune-ab: 两套判据哈希相同，A/B 无意义")

    labels_p = a.labels or os.path.join(HOME, "shadow", f"labels-{a.tag}.jsonl")
    sample_p = a.sample or os.path.join(HOME, "shadow", f"sample-{a.tag}.json")
    if not os.path.exists(labels_p):
        raise SystemExit(f"tune-ab: 缺标签文件 {labels_p}")
    if not os.path.exists(sample_p):
        raise SystemExit(f"tune-ab: 缺抽样映射 {sample_p}（先 threshold_fit --export-sample）")
    items = read_json(sample_p).get("items") or []
    labs = load_labels(labels_p)
    states = load_shadow_states(a.tag)

    rows, ys, used = [], [], 0
    for it in items:
        idx, key = int(it.get("idx")), it.get("key")
        if idx not in labs or key not in states:
            continue
        state, question, _ = states[key]
        rows.append({"id": f"i{idx}", "state": state, "question": qa or question,
                     "options": oa, "createdMs": 0})
        ys.append(labs[idx])
        used += 1
    if used < 10:
        raise SystemExit(f"tune-ab: 可对齐样本只有 {used} 条，A/B 不可信（需要 ≥10）")

    sa = score_rows(rows, a.score_cmd, os.path.join("/tmp", f"ab-{os.getpid()}-a.jsonl"))
    rows_b = [dict(r, question=qb or r["question"], options=ob) for r in rows]
    sb = score_rows(rows_b, a.score_cmd, os.path.join("/tmp", f"ab-{os.getpid()}-b.jsonl"))

    score_a = [sa[r["id"]] for r in rows]
    score_b = [sb[r["id"]] for r in rows]
    auc_a, auc_b = auc(score_a, ys), auc(score_b, ys)
    pa, ra, tpa, fpa, _ = pr_at(score_a, ys, tau)
    pb, rb, tpb, fpb, _ = pr_at(score_b, ys, tau)

    delta = (auc_b or 0) - (auc_a or 0)
    if delta >= a.margin and (pa is None or pb is None or pb >= pa - 0.02):
        verdict, code = "accept", 0
    elif delta <= -a.margin:
        verdict, code = "reject", 3
    else:
        verdict, code = "inconclusive", 2

    meta = {"tag": a.tag, "n": used, "positives": sum(ys), "tau": tau,
            "auc_a": auc_a, "auc_b": auc_b, "delta_auc": delta,
            "margin": a.margin, "verdict": verdict,
            "rubricA": {"hash": ha, "path": a.a}, "rubricB": {"hash": hb, "path": a.b},
            "precision": {"a": pa, "b": pb}, "recall": {"a": ra, "b": rb},
            "confusion": {"a": [tpa, fpa], "b": [tpb, fpb]},
            "scoreCmd": a.score_cmd}

    rep = [f"# 判据 A/B · {a.tag}\n",
           f"- 样本 {used} 条（正例 {sum(ys)}）· 阈值 τ={tau} · 显著性门槛 Δ AUC ≥ {a.margin}",
           f"- A `{ha}`: {a.a}",
           f"- B `{hb}`: {a.b}",
           "",
           "| 指标 | A（旧） | B（新） | Δ |",
           "|---|---|---|---|",
           f"| AUC | {auc_a:.4f} | {auc_b:.4f} | {delta:+.4f} |",
           f"| Precision @τ | {pa if pa is None else f'{pa:.1%}'} | {pb if pb is None else f'{pb:.1%}'} | — |",
           f"| Recall @τ | {ra if ra is None else f'{ra:.1%}'} | {rb if rb is None else f'{rb:.1%}'} | — |",
           "",
           f"## 裁决：**{verdict}**",
           {"accept": "→ AUC 显著提升且精确率不退化，可以改 target。",
            "reject": "→ AUC 显著变差，**禁止**改 target（今天凭直觉改反的那版就属于这一类）。",
            "inconclusive": "→ 差异在噪声内：要么样本不够，要么改动无实质影响，别据此改判据。"}[verdict],
           "",
           "> 口径：同一批标注样本、同一打分器、同一阈值；只换判据。AUC 为未加权秩统计。"]
    out = os.path.join(HOME, "shadow", f"ab-{a.tag}-{ha}-{hb}.md")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf-8").write("\n".join(rep) + "\n")
    json.dump(meta, open(out + ".meta.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("\n".join(rep))
    print(f"\n报告: {out}")
    print(f"meta: {out}.meta.json")
    return code


if __name__ == "__main__":
    sys.exit(main())
