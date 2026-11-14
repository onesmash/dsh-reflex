#!/usr/bin/env python3
"""打标进度与效果。让 L2 看到自己标的后果（否则不会持续标）。"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jl

HOME = os.path.expanduser(os.environ.get("REFLEX_HOME", "~/.dsh/dsh-reflex"))
ledger = jl.load(os.path.join(HOME, "shadow", "wake-ledger.jsonl"))
labels = {r["wake_key"]: r for r in jl.load(os.path.join(HOME, "shadow", "wake-labels.jsonl"))}

n_total = len(ledger)
n_labeled = sum(1 for r in ledger if r.get("wake_key") in labels)
pos = sum(1 for r in ledger if labels.get(r.get("wake_key"), {}).get("label") == 1)
neg = n_labeled - pos

print(f"打标进度: {n_labeled}/{n_total} ({n_labeled/n_total*100:.0f}%)" if n_total else "无台账")
if n_labeled:
    print(f"  有用 {pos} · 没用 {neg}")
    # 按 target 分
    from collections import Counter
    c = Counter()
    for r in ledger:
        k = r.get("wake_key")
        if k in labels:
            c[(r.get("target"), labels[k]["label"])] += 1
    print("  按来源:")
    for (t, l), n in sorted(c.items()):
        print(f"    {t:16} {'有用' if l==1 else '没用'} {n}")
    # 阈值变化
    tf = json.load(open(os.path.join(HOME, "tools", "shadow_targets.json")))
    print(f"\n当前阈值: {tf.get('x-timeline',{}).get('threshold')}")
else:
    print("\n还没有标注。推送尾部有提示，处理完顺手标一下即可。")
    print("命令: wake_label <wake_key> 1|0 [备注]")

# ───────── item 级打标（2026-11-14 补）─────────
# 多条目推送（jev-friction / x-timeline）的真实标注粒度是【条目】：
#   wake_key 形如 "jev-friction:i:jev-friction-sem-33857"
# 老版本只统计 wake 级台账，于是 item 级标注全看不见——今天标了 5 条仍显示 0/134。
# item 级才是「哪条判据该退役」的证据来源，所以按判据代号单独统计。
from collections import Counter, defaultdict
CODES = {"sem", "f1", "f2", "f3", "f4", "f5", "f6", "p1", "p2",
         "friction", "failure", "probe", "lower", "upper"}
item = {k: v for k, v in labels.items() if ":i:" in k}
if item:
    pos_i = sum(1 for v in item.values() if v.get("label") == 1)
    pr = pos_i / len(item) * 100
    print(f"\nitem 级打标: {len(item)} 条（有用 {pos_i} · 没用 {len(item)-pos_i} · 精准率 {pr:.0f}%）")

    def kind_of(k, v):
        ik = v.get("item_key") or k.rsplit(":", 1)[-1]
        # 从右往左扫：jev-friction-sem-33857 里的 "friction" 是源名，不是判据代号
        for seg in reversed(ik.split("-")):
            if seg in CODES:
                return seg
        return "—"

    by_target = defaultdict(lambda: [0, 0])
    by_kind = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for k, v in item.items():
        tgt = v.get("target") or k.split(":")[0]
        kind = kind_of(k, v)
        slot = 0 if v.get("label") == 1 else 1
        by_target[tgt][slot] += 1
        by_kind[tgt][kind][slot] += 1

    print("  按来源:")
    for tgt, (pi, ni) in sorted(by_target.items(), key=lambda kv: -(kv[1][0] + kv[1][1])):
        tot = pi + ni
        print(f"    {tgt:14} 有用 {pi:3} · 没用 {ni:3} · n={tot:3} · 精准 {pi/tot*100:3.0f}%")

    # 判据分解：只对「同源多判据」的源有意义（jev-friction 的 sem/f1/f2/f6…）
    for tgt, kinds in by_kind.items():
        named = {k: v for k, v in kinds.items() if k != "—"}
        if len(named) < 2:
            continue
        print(f"  {tgt} 判据分解:")
        for kind, (pi, ni) in sorted(named.items(), key=lambda kv: -(kv[1][0] + kv[1][1])):
            tot = pi + ni
            flag = "  ← 建议退役/改写" if tot >= 5 and pi / tot < 0.4 else ""
            print(f"    {kind:6} 有用 {pi:2} · 没用 {ni:2} · n={tot:2} · 精准 {pi/tot*100:3.0f}%{flag}")

# 距重拟合还差多少
NEED = 50
if n_labeled < NEED:
    print(f"\n距可重拟合还差 {NEED - n_labeled} 条（目标 {NEED}）")
else:
    print(f"\n已达 {NEED} 条，可重拟合: python3 tools/refit-from-wake-labels.py")
