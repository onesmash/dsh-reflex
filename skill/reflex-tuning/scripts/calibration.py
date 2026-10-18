#!/usr/bin/env python3
"""校准评估: 我们的 p(yes) 到底是不是"概率"？

问题
  L1 的分数是 SemIf 读答案槽 logits 得到的 p(yes)。实测它不是校准概率:
  0.88-0.93 区间只有约一半正例, 0.93+ 才是 92%。如果直接把它当概率用
  (比如"p≥0.93 就代表 93% 会值得看"), 阈值语义是错的。

做法
  1. 三种映射: 恒等(原始分) / Platt(sigmoid 拟合) / Isotonic(保序回归 PAV)
  2. 指标: ECE (10 桶), Brier, LogLoss; 5 折交叉验证防过拟合 (isotonic 特别容易)
  3. 工作点换算: 校准后阈值概率 p* 与代价比 R 的关系 —— 唤醒当且仅当
        p*(x) ≥ 1/R,   R = (真阳价值 + 漏报代价) / 误报代价
     报告当前阈值 τ 对应的校准概率, 以及 R=2/4/8 时应取的概率阈值与对应原始分。
  说明: Platt/Isotonic 都是单调变换, 不改变排序, 所以同一"唤醒量"下 P/R 不变;
        校准的价值在于**概率语义** (固定阈值对应多少误报率、阈值可由代价比直接算)。

用法
  python3 tools/calibration.py --tag xtl-v2b --labels-tag x-timeline --mode replay --operating 0.93
  python3 tools/calibration.py --tag x-timeline --mode replay --json
"""
import argparse
import glob
import hashlib
import json
import math
import os
import random
import sys

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")


# ---------- 基础 ----------
def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def logloss(p, y):
    p = min(max(p, 1e-9), 1 - 1e-9)
    return -(y * math.log(p) + (1 - y) * math.log(1 - p))


def ece(preds, ys, bins=10):
    """等宽分桶 ECE (按预测概率分桶)。"""
    n = len(preds)
    if not n:
        return None
    buckets = [[] for _ in range(bins)]
    for p, y in zip(preds, ys):
        b = min(int(p * bins), bins - 1)
        buckets[b].append((p, y))
    total = 0.0
    for b in buckets:
        if not b:
            continue
        mp = sum(p for p, _ in b) / len(b)
        my = sum(y for _, y in b) / len(b)
        total += len(b) / n * abs(mp - my)
    return total


def brier(preds, ys):
    return sum((p - y) ** 2 for p, y in zip(preds, ys)) / len(ys) if ys else None


def reliability_table(preds, ys, bins=10):
    rows = []
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [(p, y) for p, y in zip(preds, ys) if (lo <= p < hi or (b == bins - 1 and p == 1.0))]
        if not sel:
            continue
        rows.append((lo, hi, len(sel), sum(p for p, _ in sel) / len(sel), sum(y for _, y in sel) / len(sel)))
    return rows


# ---------- Platt scaling ----------
def fit_platt(xs, ys, iters=100, l2=1e-6):
    """加权? 这里样本量小, 用普通对数损失 + 轻微 L2。返回 (a,b)。"""
    a, b = 1.0, 0.0
    for _ in range(iters):
        g_a = g_b = h_aa = h_ab = h_bb = 0.0
        for x, y in zip(xs, ys):
            p = sigmoid(a * x + b)
            d = p - y
            g_a += d * x
            g_b += d
            w = p * (1 - p)
            h_aa += w * x * x
            h_ab += w * x
            h_bb += w
        g_a += l2 * a
        h_aa += l2
        det = h_aa * h_bb - h_ab * h_ab
        if abs(det) < 1e-12:
            break
        da = (h_bb * g_a - h_ab * g_b) / det
        db = (h_aa * g_b - h_ab * g_a) / det
        a -= da
        b -= db
        if abs(da) + abs(db) < 1e-9:
            break
    return a, b


# ---------- Isotonic (PAV) ----------
def fit_isotonic(xs, ys, weights=None):
    """Pool Adjacent Violators。返回 [(x_hi, y_hat)] 分段 (按 x 升序)。"""
    n = len(xs)
    if not n:
        return []
    w = weights or [1.0] * n
    order = sorted(range(n), key=lambda i: xs[i])
    blocks = []  # [sum_w, sum_wy, max_x]
    for i in order:
        bw, bwy = w[i], w[i] * ys[i]
        blocks.append([bw, bwy, xs[i]])
        while len(blocks) >= 2:
            m1 = blocks[-2][1] / blocks[-2][0]
            m2 = blocks[-1][1] / blocks[-1][0]
            if m1 <= m2 + 1e-12:
                break
            b2 = blocks.pop()
            blocks[-1][0] += b2[0]
            blocks[-1][1] += b2[1]
            blocks[-1][2] = max(blocks[-1][2], b2[2])
    return [(b[2], b[1] / b[0]) for b in blocks]


def predict_isotonic(points, x):
    """单调分段常值映射: 取最后一个 x_hi <= x 的块; 小于最小块用第一块。"""
    if not points:
        return 0.0
    val = points[0][1]
    for x_hi, y_hat in points:
        if x <= x_hi:
            val = y_hat
            break
        val = y_hat
    return val


# ---------- 数据装载 ----------
def load_shadow(home, tag, mode):
    rows = {}
    for f in glob.glob(os.path.join(home, "shadow", f"{tag}-*.jsonl")):
        base = os.path.basename(f)
        if base.startswith(("labels-", "sample-", "wake-", "ab-")):
            continue
        for line in open(f, encoding="utf-8", errors="replace"):
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


def resolve_rows(home, tag, labels_tag, mode):
    items = load_shadow(home, tag, mode)
    idx_map, weights = load_sample(home, labels_tag)
    labels = load_labels(home, labels_tag, idx_map)
    if labels_tag == tag:
        return [{"x": r["score"], "y": labels[r["key"]], "w": weights.get(r["key"], 1.0)}
                for r in items if r["key"] in labels]
    def sh_of(r):
        return r.get("state_hash") or hashlib.sha1(
            str(r.get("state") or "").encode("utf-8", "replace")).hexdigest()[:16]
    by_key = {r["key"]: r for r in load_shadow(home, labels_tag, mode)}
    hash_lab = {}
    for key, y in labels.items():
        r = by_key.get(key)
        if r:
            hash_lab[sh_of(r)] = (y, weights.get(key, 1.0))
    rows = []
    for r in items:
        hit = hash_lab.get(sh_of(r))
        if hit:
            rows.append({"x": r["score"], "y": hit[0], "w": hit[1]})
    return rows


def kfold_indices(n, k, seed=13):
    idx = list(range(n))
    random.Random(seed).shuffle(idx)
    folds = [idx[i::k] for i in range(k)]
    return folds


def eval_map(predict, rows):
    preds = [predict(r["x"]) for r in rows]
    ys = [r["y"] for r in rows]
    return {"ece": ece(preds, ys), "brier": brier(preds, ys),
            "logloss": sum(logloss(p, y) for p, y in zip(preds, ys)) / len(ys)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="xtl-v2b")
    ap.add_argument("--labels-tag", default="x-timeline")
    ap.add_argument("--mode", default="replay", choices=["replay", "live", "both"])
    ap.add_argument("--operating", type=float, default=0.93)
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--report", default="")
    a = ap.parse_args()

    rows = resolve_rows(a.home, a.tag, a.labels_tag, a.mode)
    if not rows:
        print("没有对齐的标注数据", file=sys.stderr)
        return 2
    xs = [r["x"] for r in rows]
    ys = [r["y"] for r in rows]
    ws = [r["w"] for r in rows]
    n = len(rows)
    base_rate = sum(ys) / n

    # 拟合
    iso_pts = fit_isotonic(xs, ys, ws)
    pa, pb = fit_platt(xs, ys)
    maps = {
        "identity": lambda x: min(max(x, 0.0), 1.0),
        "platt": lambda x: sigmoid(pa * x + pb),
        "isotonic": lambda x: predict_isotonic(iso_pts, x),
    }

    # 训练集指标 + 5 折 CV 指标
    res = {}
    for name, fn in maps.items():
        tr = eval_map(fn, rows)
        cv_pred = [0.0] * n
        for fold in kfold_indices(n, 5):
            test = set(fold)
            train = [rows[i] for i in range(n) if i not in test]
            if name == "isotonic":
                pts = fit_isotonic([r["x"] for r in train], [r["y"] for r in train], [r["w"] for r in train])
                f = lambda x: predict_isotonic(pts, x)
            elif name == "platt":
                aa, bb = fit_platt([r["x"] for r in train], [r["y"] for r in train])
                f = lambda x, aa=aa, bb=bb: sigmoid(aa * x + bb)
            else:
                f = maps["identity"]
            for i in fold:
                cv_pred[i] = f(rows[i]["x"])
        cv = {"ece": ece(cv_pred, ys), "brier": brier(cv_pred, ys),
              "logloss": sum(logloss(p, y) for p, y in zip(cv_pred, ys)) / n}
        res[name] = {"train": tr, "cv": cv}

    # 工作点换算
    p_cur = maps["isotonic"](a.operating)          # 用 isotonic 概率语义 (更贴近实际 P/R)
    p_platt = maps["platt"](a.operating)
    # 反查: 概率阈值 1/R 对应的原始分数 (在保序映射上二分)
    def score_at_prob(target):
        lo, hi = min(xs), max(xs)
        if maps["isotonic"](lo) >= target:
            return lo
        if maps["isotonic"](hi) <= target:
            return hi
        for _ in range(80):
            mid = (lo + hi) / 2
            if maps["isotonic"](mid) < target:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2
    operating = {}
    for R in (2, 4, 8):
        target = 1.0 / R
        operating[R] = {"target_prob": target, "score_threshold": score_at_prob(target)}

    out = {
        "tag": a.tag, "labels_tag": a.labels_tag, "mode": a.mode, "n": n,
        "base_rate": base_rate, "operating_raw": a.operating,
        "calibrated_prob_at_operating": {"isotonic": p_cur, "platt": p_platt},
        "metrics": res,
        "operating_from_costs": operating,
        "isotonic_points": iso_pts,
        "platt": {"a": pa, "b": pb},
    }

    rep = [f"# 校准评估 · {a.tag} (labels={a.labels_tag}, {a.mode})\n",
           f"- 样本 {n} 条 · 正例率 {base_rate*100:.1f}% · 当前工作点原始分 τ={a.operating}",
           f"- 当前工作点的校准概率: isotonic **{p_cur*100:.1f}%** / platt {p_platt*100:.1f}%",
           "",
           "## 校准指标 (5 折交叉验证, 防 isotonic 过拟合)\n",
           "| 映射 | ECE(train) | ECE(CV) | Brier(CV) | LogLoss(CV) |",
           "|---|---|---|---|---|"]
    for name, r in res.items():
        rep.append(f"| {name} | {r['train']['ece']*100:.1f}% | {r['cv']['ece']*100:.1f}% | "
                   f"{r['cv']['brier']:.3f} | {r['cv']['logloss']:.3f} |")
    rep += ["", "## 可靠性 (isotonic 映射后, 10 桶)\n",
            "| 预测概率区间 | n | 预测均值 | 实际正例率 |", "|---|---|---|---|"]
    iso_rows = [{"x": r["x"], "y": r["y"], "w": r["w"]} for r in rows]
    preds = [maps["isotonic"](r["x"]) for r in rows]
    for lo, hi, cnt, mp, my in reliability_table(preds, ys):
        rep.append(f"| {lo:.2f}–{hi:.2f} | {cnt} | {mp*100:.1f}% | {my*100:.1f}% |")
    rep += ["", "## 按代价比反推工作点 (唤醒 iff p* ≥ 1/R)\n",
            "| R=(真阳价值+漏报代价)/误报代价 | 目标概率 | 对应原始分 |", "|---|---|---|"]
    for R, v in operating.items():
        rep.append(f"| {R:g} | {v['target_prob']*100:.0f}% | {v['score_threshold']:.3f} |")
    rep += ["", "## 读法与限制\n",
            "- 三种映射都是单调的, **不改变排序**, 所以「同一唤醒量下的 P/R 不变」；校准改变的是概率语义。",
            "- ECE 用 5 折 CV 读, isotonic 在 n=120 上训练集 ECE 会严重低估。",
            "- 概率阈值换算依赖标签质量; 标签是 L2 代理标注时, 校准出的概率也只是「代理概率」。",
            "- 若模型置信度长期 >0.5 而准确率 <0.5, 温度缩放类方法有理论上限 (arXiv 2608.05064)。"]
    report_path = a.report or os.path.join(a.home, "shadow", f"calibration-{a.tag}.md")
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
