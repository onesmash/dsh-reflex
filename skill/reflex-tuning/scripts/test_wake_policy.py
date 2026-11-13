#!/usr/bin/env python3
"""wake_policy 的行为测试。

接线前必须跑通。三个用例对应三个真实风险：
  T1 同一条重复到达，不能算成「第二条」（会把单条内容误判为多条目）
  T2 高置信单条必须立即发，不暂存
  T3 late_min 兜底：暂存超时后高分条目必须补发，不能吞
"""
import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("wake_policy", os.path.join(HERE, "wake_policy.py"))
wp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wp)

FAIL = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  {detail}", file=sys.stderr)
        FAIL.append(name)


def fresh_state():
    fd, p = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    os.unlink(p)                       # decide 会自己创建
    return p


def item(iid, score):
    return {"id": iid, "title": f"item {iid}", "body": "b", "score": score}


# ---- T1: 同一条重复到达 ----
print("T1 同一条重复到达，不应算成第二条")
st = fresh_state()
t0 = 1794500000000
r1 = wp.decide([item("A", 0.85)], st, t0, wait_min=60, immediate=0.98)
check("首次单条低分 → 暂存不发", r1["wake"] is False and r1["deferred"] == 1,
      f"got wake={r1['wake']} deferred={r1['deferred']}")
# 同一条 5 分钟后再来（插件侧通常已被去重，但策略层也要自保）
r2 = wp.decide([item("A", 0.85)], st, t0 + 5 * 60000, wait_min=60, immediate=0.98)
check("同一条再来 → 不应发（否则单条被当两条）",
      r2["wake"] is False,
      f"got wake={r2['wake']} reason={r2['reason']}")

# ---- T2: 高置信单条立即发 ----
print("T2 高置信单条立即发")
st = fresh_state()
r = wp.decide([item("B", 0.99)], st, t0, wait_min=60, immediate=0.98)
check("0.99 ≥ immediate(0.98) → 立即发", r["wake"] is True and len(r["items"]) == 1,
      f"got wake={r['wake']} items={len(r['items'])}")

# ---- T3: late_min 兜底 ----
print("T3 暂存超时后 late_min 补发")
st = fresh_state()
wp.decide([item("C", 0.90)], st, t0, wait_min=60, immediate=0.98)
# 61 分钟后本轮无新命中，且 late_min=0.85
r = wp.decide([], st, t0 + 61 * 60000, wait_min=60, immediate=0.98, late_min=0.85)
check("超时 + 分数≥late_min → 补发", r["wake"] is True and len(r["items"]) == 1,
      f"got wake={r['wake']} items={len(r['items'])} reason={r['reason']}")

# ---- T4: late_min=None 时超时丢弃 ----
print("T4 late_min=None 时超时丢弃（旧行为）")
st = fresh_state()
wp.decide([item("D", 0.90)], st, t0, wait_min=60, immediate=0.98)
r = wp.decide([], st, t0 + 61 * 60000, wait_min=60, immediate=0.98, late_min=None)
check("超时且无 late_min → 不发", r["wake"] is False,
      f"got wake={r['wake']} reason={r['reason']}")

print()
if FAIL:
    print(f"失败 {len(FAIL)}: {FAIL}", file=sys.stderr)
    sys.exit(1)
print("全部通过")
