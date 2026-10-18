#!/usr/bin/env python3
"""风险证书: 给"当前工作点的误报率/精度"一个有限样本置信上界。

为什么需要
  现在报告的是点估计 (precision 84.6%)，用户没法回答"这到底能不能信"。
  有限样本下, 给定 n 个观测和 k 个正解, 可以给出精确的 Clopper-Pearson 单侧界:
    误报率 ≤ U  (95% 置信)
    精度   ≥ L
  这是部署决策该看的数字 (论文用 non-inferiority 检验, 这里用 exact binomial 界)。

口径与限制 (必须写进报告)
  - 我们的 120 条标签是【分层抽样】(边界带 75%), 所以 CP 区间严格来说只对"抽样分布"成立,
    不能直接当总体指标; 想对总体下证书, 要么改成均匀随机抽样, 要么按唤醒级(自然抽样)标注。
  - 本工具同时给: ①样本内 CP 区间 (精确但口径受限) ②加权点估计 (总体估计但无保证)
  - 样本量规划: 若观测到 0 个误报, 要证明误报率 ≤ r, 需要 n ≥ ln(α)/ln(1-r)。

用法
  python3 tools/risk_certificate.py --tag x-timeline --mode replay --operating 0.93
  python3 tools/risk_certificate.py --tag x-timeline --operating 0.93 --alpha 0.05 --json
"""
import argparse
import glob
import hashlib
import json
import math
import os
import sys

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")


# ---------- 正则化不完全 Beta 函数 (Numerical Recipes 风格, 无 scipy 依赖) ----------
def _betacf(a, b, x, max_iter=300, eps=3e-12):
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1.0 / d
    h = d
    for m in range(1, max_iter + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1.0 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1.0 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h


def betainc(a, b, x):
    """正则化不完全 Beta I_x(a,b)。"""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln_beta = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
    front = math.exp(ln_beta + a * math.log(x) + b * math.log(1.0 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def beta_quantile(p, a, b, lo=0.0, hi=1.0):
    """Beta 分布分位数: 二分法求 I_x(a,b)=p。"""
    if p <= 0.0:
        return 0.0
    if p >= 1.0:
        return 1.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if betainc(a, b, mid) < p:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-10:
            break
    return (lo + hi) / 2.0


def cp_lower(k, n, alpha):
    """Clopper-Pearson 单侧下界: 真实比例的 1-alpha 置信下限。"""
    if n <= 0:
        return None
    if k <= 0:
        return 0.0
    return beta_quantile(alpha, k, n - k + 1)


def cp_upper(k, n, alpha):
    """Clopper-Pearson 单侧上界。"""
    if n <= 0:
        return None
    if k >= n:
        return 1.0
    return beta_quantile(1.0 - alpha, k + 1, n - k)


def sample_size_zero_fp(risk, alpha):
    """观测到 0 个误报时, 证明误报率 <= risk 所需样本量。"""
    if risk <= 0 or risk >= 1:
        return None
    return math.ceil(math.log(alpha) / math.log(1.0 - risk))


def sample_size_precision(p, alpha):
    """观测到 0 个误报时, 证明精度 >= p 所需样本量。"""
    if p <= 0 or p >= 1:
        return None
    return math.ceil(math.log(alpha) / math.log(p))


def load_shadow(home, tag, mode):
    rows = {}
    for f in glob.glob(os.path.join(home, "shadow", f"{tag}-*.jsonl")):
        base = os.path.basename(f)
        if base.startswith(("labels-", "sample-", "wake-", "ab-")):
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
                if r.get("tag") != tag or r.get("score") is None:
                    continue
                if mode != "both" and r.get("mode") != mode:
                    continue
                rows[r["key"]] = r
    return list(rows.values())


def load_sample(home, tag):
    path = os.path.join(home, "shadow", f"sample-{tag}.json")
    idx_map, weights = {}, {}
    if not os.path.exists(path):
        return idx_map, weights
    raw = json.load(open(path, encoding="utf-8"))
    if isinstance(raw, dict) and "items" in raw:
        for it in raw["items"]:
            idx_map[int(it["idx"])] = it["key"]
            weights[it["key"]] = float(it.get("w") or 1.0)
    else:
        for k, v in raw.items():
            idx_map[int(k)] = v
    return idx_map, weights


def load_labels(home, tag, idx_map):
    path = os.path.join(home, "shadow", f"labels-{tag}.jsonl")
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
        if lab not in (0, 1, "0", "1", True, False):
            continue
        if "idx" in o and int(o["idx"]) in idx_map:
            out[idx_map[int(o["idx"])]] = int(lab)
        elif o.get("key"):
            out[o["key"]] = int(lab)
    return out


def fmt(x, digits=1):
    return "-" if x is None else f"{x*100:.{digits}f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="x-timeline")
    ap.add_argument("--mode", default="replay", choices=["replay", "live", "both"])
    ap.add_argument("--operating", type=float, default=None, help="工作点阈值, 默认取 shadow_targets.json")
    ap.add_argument("--alpha", type=float, default=0.05, help="单侧显著性 (默认 0.05 = 95%% 置信)")
    ap.add_argument("--labels-tag", default="", help="标签来自哪个 tag (默认同 --tag; 判据变体用 state_hash 对齐)")
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--report", default="")
    a = ap.parse_args()

    labels_tag = a.labels_tag or a.tag
    items = load_shadow(a.home, a.tag, a.mode)
    idx_map, weights = load_sample(a.home, labels_tag)
    labels = load_labels(a.home, labels_tag, idx_map)
    if not items or not labels:
        print("缺 shadow 数据或标签", file=sys.stderr)
        return 2

    if labels_tag == a.tag:
        rows = [{"score": r["score"], "y": labels[r["key"]], "w": weights.get(r["key"], 1.0)}
                for r in items if r["key"] in labels]
    else:
        # 判据不同 -> key 不同, 用 state_hash 对齐 (与 shadow_ab 同法)
        def sh_of(r):
            return r.get("state_hash") or hashlib.sha1(
                str(r.get("state") or "").encode("utf-8", "replace")).hexdigest()[:16]
        base = load_shadow(a.home, labels_tag, a.mode)
        by_key = {r["key"]: r for r in base}
        hash_label = {}
        for key, y in labels.items():
            r = by_key.get(key)
            if r:
                hash_label[sh_of(r)] = (y, weights.get(key, 1.0))
        rows = []
        for r in items:
            hit = hash_label.get(sh_of(r))
            if hit:
                rows.append({"score": r["score"], "y": hit[0], "w": hit[1]})
    if not rows:
        print("标签与打分对齐后为空", file=sys.stderr)
        return 2

    tau = a.operating
    if tau is None:
        try:
            cfg = json.load(open(os.path.join(a.home, "tools", "shadow_targets.json"), encoding="utf-8"))
            tau = (cfg.get(a.tag) or {}).get("threshold")
        except Exception:
            tau = None
    if tau is None:
        print("没有工作点阈值, 用 --operating 指定", file=sys.stderr)
        return 2

    tp = sum(1 for r in rows if r["score"] >= tau and r["y"] == 1)
    fp = sum(1 for r in rows if r["score"] >= tau and r["y"] == 0)
    fn = sum(1 for r in rows if r["score"] < tau and r["y"] == 1)
    tn = sum(1 for r in rows if r["score"] < tau and r["y"] == 0)
    n_wake = tp + fp
    n_pos = tp + fn
    # 加权点估计 (总体近似, 无保证)
    w_tp = sum(r["w"] for r in rows if r["score"] >= tau and r["y"] == 1)
    w_fp = sum(r["w"] for r in rows if r["score"] >= tau and r["y"] == 0)
    w_fn = sum(r["w"] for r in rows if r["score"] < tau and r["y"] == 1)

    alpha = a.alpha
    out = {
        "tag": a.tag, "mode": a.mode, "operating": tau, "alpha": alpha, "confidence": 1 - alpha,
        "n_labeled": len(rows),
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "unweighted": {
            "precision": tp / n_wake if n_wake else None,
            "recall": tp / n_pos if n_pos else None,
        },
        "weighted_point": {
            "precision": w_tp / (w_tp + w_fp) if (w_tp + w_fp) else None,
            "recall": w_tp / (w_tp + w_fn) if (w_tp + w_fn) else None,
        },
        "certificate": {
            "precision_lower": cp_lower(tp, n_wake, alpha) if n_wake else None,
            "false_wake_rate_upper": cp_upper(fp, n_wake, alpha) if n_wake else None,
            "recall_lower": cp_lower(tp, n_pos, alpha) if n_pos else None,
        },
        "sample_size_planning": {
            "zero_fp_to_certify_false_wake_le": {
                str(r): sample_size_zero_fp(r, alpha) for r in (0.05, 0.10, 0.20)
            },
            "zero_fp_to_certify_precision_ge": {
                str(p): sample_size_precision(p, alpha) for p in (0.80, 0.90, 0.95)
            },
        },
    }

    rep = [f"# 风险证书 · {a.tag} ({a.mode}) @ τ={tau}\n",
           f"- 标注样本: {len(rows)} 条 · 唤醒集合: {n_wake} 条 (TP {tp} / FP {fp}) · 正例 {n_pos} 条 (FN {fn})",
           f"- 置信水平: {fmt(1 - alpha, 0)} (单侧)\n",
           "## 证书 (有限样本下界/上界)\n",
           "| 指标 | 点估计(未加权) | 点估计(加权) | 单侧置信界 |",
           "|---|---|---|---|",
           f"| Precision | {fmt(out['unweighted']['precision'])} | {fmt(out['weighted_point']['precision'])} | "
           f"**≥ {fmt(out['certificate']['precision_lower'])}** |",
           f"| 误报率 (FP/唤醒) | {fmt(fp/n_wake if n_wake else None)} | - | "
           f"**≤ {fmt(out['certificate']['false_wake_rate_upper'])}** |",
           f"| Recall | {fmt(out['unweighted']['recall'])} | {fmt(out['weighted_point']['recall'])} | "
           f"**≥ {fmt(out['certificate']['recall_lower'])}** |",
           "",
           "## 样本量规划 (α={:.2f}, 观测到 0 个误报时)\n".format(alpha),
           "| 目标 | 需要样本量 |",
           "|---|---|"]
    for r, n in out["sample_size_planning"]["zero_fp_to_certify_false_wake_le"].items():
        rep.append(f"| 误报率 ≤ {float(r)*100:.0f}% | {n} |")
    for p, n in out["sample_size_planning"]["zero_fp_to_certify_precision_ge"].items():
        rep.append(f"| precision ≥ {float(p)*100:.0f}% | {n} |")
    rep += ["",
            "## 口径与限制\n",
            "- 标签是**分层抽样** (边界带优先), 上表 CP 区间严格来说只对抽样分布成立, 不能直接当总体指标。",
            "- 要拿到总体证书: 改用均匀随机抽样标注, 或按**唤醒级**做自然抽样标注 (wake_ledger 已支持)。",
            "- 加权点估计是总体近似, 没有置信保证; 两者要分开读。"]
    report_path = a.report or os.path.join(a.home, "shadow", f"risk-certificate-{a.tag}.md")
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    open(report_path, "w", encoding="utf-8").write("\n".join(rep) + "\n")
    out["report"] = report_path

    if a.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print("\n".join(rep))
        print(f"\n报告已写入 {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
