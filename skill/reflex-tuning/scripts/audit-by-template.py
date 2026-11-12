#!/usr/bin/env python3
"""按 state 模板分轨统计审计结果，避免把两种模板混在一起算符合率。

背景（2026-11-12）：shadow 里 dict 模板 1762 条 + fielded 643 条共存。
pc_inject 按 '正文: ' 判断模板，dict 批走 blob 算子族（无 shuffle_fields）。
混在一起报总符合率会误导：shuffle_fields 100% 只覆盖了 fielded 那批。

结论：**不要迁移历史模板**。实测把 1762 条 dict 迁到三段式后，
正负例间距从 0.254 掉到 0.130，F1 从 58% 掉到 42%（规范坑 8：模板即判据）。
正确做法是保留双轨，但在报告里分轨呈现。
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jl

HOME = os.path.expanduser("~/.dsh/dsh-reflex")
TAG = sys.argv[1] if len(sys.argv) > 1 else "x-timeline"
DAYS = sys.argv[2] if len(sys.argv) > 2 else "all"
raw_f = os.path.join(HOME, "shadow", "pc", f"pc-raw-{TAG}-{DAYS}.jsonl")
snap_glob_dir = os.path.join(HOME, "shadow", "pc", "snapshots")

if not os.path.exists(raw_f):
    print(f"缺 {raw_f}（先跑 pc_inject.py）", file=sys.stderr)
    sys.exit(2)

rows = jl.load(raw_f)

# 从 snapshot 里取 state 判断模板
tmpl = {}
for fn in sorted(os.listdir(snap_glob_dir)):
    if not fn.startswith("pc-snapshot-"):
        continue
    for s in jl.load(os.path.join(snap_glob_dir, fn)):
        h = s.get("state_hash")
        if h:
            st = s.get("state") or ""
            tmpl[h] = "fielded" if "正文: " in st else "blob"

from collections import defaultdict
buckets = defaultdict(lambda: defaultdict(list))
for r in rows:
    t = tmpl.get(r.get("state_hash"), "unknown")
    buckets[t][r["op"]].append(r)

print(f"# 分模板审计 · 共 {len(rows)} 条记录\n")
for t in ("fielded", "blob", "unknown"):
    if t not in buckets:
        continue
    n_states = len({r["state_hash"] for op in buckets[t] for r in buckets[t][op]})
    print(f"## {t} 模板 ({n_states} 个 state)")
    print("| 算子 | 类型 | 符合率 | 平均 Δp | n |")
    print("|---|---|---|---|---|")
    for op in ("strip_signal", "swap_irrelevant", "noise_append", "shuffle_fields"):
        rs = buckets[t].get(op)
        if not rs:
            print(f"| {op} | — | n/a | — | 0 |")
            continue
        ok = sum(1 for r in rs if r.get("ok")) / len(rs)
        dp = sum(r.get("delta_p", 0) for r in rs) / len(rs)
        kind = rs[0].get("kind", "?")
        print(f"| {op} | {kind} | **{ok*100:.1f}%** | {dp:+.4f} | {len(rs)} |")
    print()

print("**读法**：blob 模板没有字段可打乱，`shuffle_fields` 天然 n/a。")
print("两轨的符合率不能相加，也不能互相代表。")
