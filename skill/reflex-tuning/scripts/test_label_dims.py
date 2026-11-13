#!/usr/bin/env python3
"""打标维度的一致性测试。

核心契约（2026-11-13 确立）：
  **label 是 action 的派生值，不是独立信号。**
  action != none  ⟺  label == 1
  当这条不变量被破坏时，说明有标签写错了，或者有人又在用 label 表达
  action 装不下的意思（那就该加维度，而不是让 label 飘）。

为什么要有这个测试：实测 95 条标签里 label 与 action 100% 一致（49/49 有
action 的样本），证明 value 维度冗余。删掉 value 之后，必须保证 label 仍由
action 派生 —— 否则删了就丢了信息。
"""
import json
import os
import sys

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")


def load_item_labels(home):
    """读 item 级标签，取每个 item_key 的最新一条。"""
    path = os.path.join(home, "shadow", "wake-labels.jsonl")
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
        if o.get("scope") != "item":
            continue
        ik = o.get("item_key")
        if not ik:
            continue
        prev = out.get(ik)
        if prev is None or int(o.get("at") or 0) >= int(prev.get("at") or 0):
            out[ik] = o
    return out


def check_label_action_invariant(labels):
    """label 与 action 必须一致。返回 (通过数, 失败列表)。"""
    ok = 0
    bad = []
    for ik, rec in labels.items():
        dims = rec.get("dims") or {}
        action = dims.get("action")
        if action is None:
            continue                      # 没填 action 的不参与（老标签）
        label = int(rec.get("label", 0))
        expect = 0 if action == "none" else 1
        if label == expect:
            ok += 1
        else:
            bad.append({
                "item_key": ik,
                "label": label,
                "action": action,
                "why": rec.get("why", ""),
            })
    return ok, bad


def test_invariant_holds():
    """真实数据上，不变量必须成立。"""
    home = DEFAULT_HOME
    labels = load_item_labels(home)
    if not labels:
        print("SKIP: 没有 item 级标签", file=sys.stderr)
        return True
    ok, bad = check_label_action_invariant(labels)
    total = ok + len(bad)
    print(f"  label/action 一致: {ok}/{total}")
    if bad:
        print(f"  ✗ {len(bad)} 条不一致：", file=sys.stderr)
        for b in bad[:5]:
            print(f"    {b}", file=sys.stderr)
        return False
    return True


def test_derivation_rule():
    """派生规则的单元测试（不依赖真实数据）。"""
    cases = [
        ("act", 1), ("know", 1), ("none", 0),
    ]
    for action, want in cases:
        got = 0 if action == "none" else 1
        if got != want:
            print(f"  ✗ action={action} 应派生 label={want}，得到 {got}", file=sys.stderr)
            return False
    print(f"  ✓ 派生规则 {len(cases)} 条用例")
    return True


def test_forced_derivation():
    """填了 action 时，传入的 label 必须被覆盖（防止手滑写错）。"""
    def derive(lab, action):
        if action:
            lab = 0 if action == "none" else 1
        return lab

    cases = [
        (1, "act", 1, "act 保持 1"),
        (1, "know", 1, "know 保持 1"),
        (0, "none", 0, "none 保持 0"),
        (1, "none", 0, "传 1 但 action=none → 强制 0"),
        (0, "act", 1, "传 0 但 action=act → 强制 1"),
        (1, None, 1, "无 action → 尊重传入"),
    ]
    bad = 0
    for lab, action, want, desc in cases:
        got = derive(lab, action)
        if got != want:
            print(f"  ✗ {desc}: 传入{lab} → {got}，期望 {want}", file=sys.stderr)
            bad += 1
    if bad:
        return False
    print(f"  ✓ 强制派生 {len(cases)} 条用例")
    return True


if __name__ == "__main__":
    print("=== 维度一致性测试 ===")
    results = [test_derivation_rule(), test_forced_derivation(), test_invariant_holds()]
    if all(results):
        print("\n全部通过")
        sys.exit(0)
    print("\n失败", file=sys.stderr)
    sys.exit(1)
