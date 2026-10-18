#!/usr/bin/env python3
"""唤醒策略回放模拟: 比较"单条目唤醒"的不同处理方式。

背景
  回放构造的 34 次唤醒里, 单条目唤醒只有 37% 有价值, 2 条以上是 100%。
  于是候选策略: 单条目要么等第二条 (wait), 要么要求更高分 (threshold), 或者两者结合。

模型
  输入是"已通过基线的条目" [{posted, score, label}], 按发布时间排序。
  - baseline: 间隔 >gap 分钟就切成新唤醒, 每个唤醒都发出。
  - wait(W): 间隔 >W 分钟才切组; 组内 <2 条 → 不发 (继续等); ≥2 条 → 发。
  - thresh(T): 分组同 baseline; 单条组要求 score>=T, 多条组直接发。
  - combo(W,T): 分组用 W; 单条组要求 score>=T; 多条组发。
  指标: 发出唤醒数、其中"至少一条值得"的比例 (precision)、
        被错过的正例条目数 (漏报)、正例条目覆盖率、每天唤醒量。

用法
  python3 tools/wake_policy_sim.py --items /tmp/passed-items-labeled.json --gap-min 30 --days 5
"""
import argparse
import calendar
import json
import sys
import time


def parse_ms(iso):
    try:
        base = calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
        frac = "0"
        if len(iso) > 20 and iso[19] == ".":
            frac = iso[20:23]
        return base + int((frac or "0").ljust(3, "0"))
    except Exception:
        return None


def group(items, gap_min):
    out, cur = [], []
    for it in items:
        if cur and it["ms"] - cur[-1]["ms"] > gap_min * 60_000:
            out.append(cur)
            cur = []
        cur.append(it)
    if cur:
        out.append(cur)
    return out


def emit_stats(wakes, n_items, n_pos, days):
    emitted = [w for w in wakes if w]
    good = sum(1 for w in emitted if any(it["label"] == 1 for it in w))
    emitted_pos = sum(1 for w in emitted for it in w if it["label"] == 1)
    return {
        "wakes": len(emitted),
        "good": good,
        "precision": good / len(emitted) if emitted else None,
        "pos_covered": emitted_pos,
        "pos_total": n_pos,
        "recall_items": emitted_pos / n_pos if n_pos else None,
        "per_day": len(emitted) / days if days else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", required=True)
    ap.add_argument("--gap-min", type=float, default=30.0)
    ap.add_argument("--days", type=float, default=5.0)
    ap.add_argument("--wait", default="60,180,360,720", help="wait 策略的等待窗口 (分钟), 逗号分隔")
    ap.add_argument("--thresh", default="0.95,0.96,0.97,0.98", help="单条目阈值")
    a = ap.parse_args()

    raw = json.load(open(a.items))
    items = []
    for r in raw:
        ms = parse_ms(r["posted"])
        if ms is None:
            continue
        items.append({"ms": ms, "score": r["score"], "label": r["label"]})
    items.sort(key=lambda x: x["ms"])
    n_pos = sum(1 for it in items if it["label"] == 1)
    print(f"通过条目 {len(items)} 条 (正例 {n_pos}) · 时间跨度 {a.days:g} 天 · 基线间隔 {a.gap_min:g} 分钟\n")

    rows = []
    base_groups = group(items, a.gap_min)
    rows.append(("baseline (现状)", emit_stats(base_groups, len(items), n_pos, a.days)))
    rows.append(("全部压制", emit_stats([[]], len(items), n_pos, a.days)))

    for w in [float(x) for x in a.wait.split(",") if x.strip()]:
        g = group(items, w)
        kept = [x if len(x) >= 2 else [] for x in g]
        rows.append((f"wait: 单条等 {w:g} 分钟", emit_stats(kept, len(items), n_pos, a.days)))

    for t in [float(x) for x in a.thresh.split(",") if x.strip()]:
        g = group(items, a.gap_min)
        kept = [x if (len(x) >= 2 or max(it["score"] for it in x) >= t) else [] for x in g]
        rows.append((f"thresh: 单条要求 ≥{t:g}", emit_stats(kept, len(items), n_pos, a.days)))

    # combo: wait 窗口 180 + 单条高阈值
    for w in (180.0, 360.0):
        for t in (0.96, 0.97):
            g = group(items, w)
            kept = [x if (len(x) >= 2 or max(it["score"] for it in x) >= t) else [] for x in g]
            rows.append((f"combo: 等 {w:g} 分钟 + 单条≥{t:g}", emit_stats(kept, len(items), n_pos, a.days)))

    print(f"{'策略':<30} {'唤醒':>4} {'好唤醒':>5} {'precision':>9} {'正例覆盖':>8} {'每天':>5}")
    print("-" * 72)
    for name, s in rows:
        p = f"{s['precision']*100:.0f}%" if s['precision'] is not None else "-"
        rc = f"{s['recall_items']*100:.0f}%" if s['recall_items'] is not None else "-"
        print(f"{name:<30} {s['wakes']:>4} {s['good']:>5} {p:>9} {rc:>8} {s['per_day']:>5.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
