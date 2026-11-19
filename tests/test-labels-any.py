#!/usr/bin/env python3
"""labels_any 的行为测试（2026-11-19）。

按 ub-mode：先写测试，看它因预期的原因失败，再做最小改动让它过。
测的是**用户看到的行为**：给一份标签文件，我能不能拿到正确的 key→label，
以及读不懂的时候是不是明确报错（而不是静默返回空）。

跑法：python3 tests/test-labels-any.py
"""

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_SCRIPTS = os.path.join(HERE, "..", "skill", "reflex-tuning", "scripts")
sys.path.insert(0, os.path.abspath(SKILL_SCRIPTS))

import labels_any as LA  # noqa: E402

FAIL = []


def check(name, cond, detail=""):
    if cond:
        print(f"PASS  {name}")
    else:
        print(f"FAIL  {name}  {detail}")
        FAIL.append(name)


def write(tmp, rows):
    p = os.path.join(tmp, "labels.jsonl")
    with open(p, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return p


def main():
    tmp = tempfile.mkdtemp(prefix="labels-any-")

    # 1) idx 方言
    p = write(tmp, [{"idx": 1, "label": 1}, {"idx": 2, "label": 0}])
    L = LA.load(p)
    check("idx 方言被识别", L.dialect == "idx", L.dialect)
    check("idx 方言取值正确", L.labs == {1: 1, 2: 0}, L.labs)
    check("idx 方言可用数", L.usable == 2, L.usable)

    # 2) key 方言
    p = write(tmp, [{"key": "aaa", "label": 1}, {"key": "bbb", "label": 0}])
    L = LA.load(p)
    check("key 方言被识别", L.dialect == "key", L.dialect)
    check("key 方言取值正确", L.labs == {"aaa": 1, "bbb": 0}, L.labs)

    # 3) item 方言（带 scope 标记）
    p = write(tmp, [{"scope": "item", "id": "111", "label": 1},
                    {"scope": "item", "id": "222", "label": 0}])
    L = LA.load(p)
    check("item 方言被识别", L.dialect == "item", L.dialect)
    check("item 方言取值正确", L.labs == {"111": 1, "222": 0}, L.labs)

    # 4) item 优先于 idx（同一行同时带 idx 时必须走 item —— 历史上错配过 46 条 45 条）
    p = write(tmp, [{"scope": "item", "id": "111", "idx": 99, "label": 1}])
    L = LA.load(p)
    check("同一行带 idx 时仍判为 item", L.dialect == "item", L.dialect)
    check("不把 item 标签错配到 idx 键", 99 not in L.labs, L.labs)

    # 5) 文件非空但 0 条可用 → 必须报错（旧的静默行为是最贵的那个 bug）
    p = write(tmp, [{"label": 1}, {"label": 0}])
    try:
        LA.load(p)
        check("零可用必须报错", False, "没有抛异常")
    except LA.LabelsError as e:
        msg = str(e)
        check("零可用必须报错", True)
        check("报错带各方言计数", "idx 0" in msg and "item 0" in msg, msg[:80])

    # 6) 空文件允许（usable=0，由调用方决定）
    p = os.path.join(tmp, "empty.jsonl")
    open(p, "w").close()
    L = LA.load(p)
    check("空文件不抛异常", L.usable == 0 and L.dialect == "empty", f"{L.usable}/{L.dialect}")

    # 7) 不存在的文件 → 报错，不静默
    try:
        LA.load(os.path.join(tmp, "nope.jsonl"))
        check("缺文件必须报错", False, "没有抛异常")
    except LA.LabelsError:
        check("缺文件必须报错", True)

    # 8) 真实文件：这是每天的活台账，行数随打标增长（2026-11-19 486 行 → 11-20 531 行）。
    #    写死绝对数会让这条测试随数据长大而假红，所以只锁定可复算的不变量。
    real = os.path.expanduser("~/.dsh/dsh-reflex/shadow/item-labels-x-timeline-20261119.jsonl")
    if os.path.exists(real):
        L = LA.load(real)
        check("真实文件方言=item", L.dialect == "item", L.dialect)
        check("行数 = 唯一 + 重复", L.lines == L.usable + L.duplicates, (L.lines, L.usable, L.duplicates))
        check("真实文件有可用标签", L.usable > 0, L.usable)
        check("正例数不超过唯一条数", sum(L.labs.values()) <= L.usable, sum(L.labs.values()))
        check("无标签冲突", L.conflicts == 0, L.conflicts)
    else:
        print("SKIP  真实文件不存在（换了机器属正常）")

    # 9) resolve：把任意方言对齐成 key → label（这是四个分析工具共用的那一层）
    if not hasattr(LA, "resolve"):
        print("FAIL  labels_any.resolve 不存在（P1 尚未抽公共层）")
        FAIL.append("resolve 缺失")
    else:
        home = os.path.expanduser("~/.dsh/dsh-reflex")
        if os.path.exists(real):
            labs, weights, dialect = LA.resolve(home, "x-timeline", path=real)
            check("resolve(item) 方言", dialect == "item", dialect)
            # 与 load() 的结果对齐，而不是与某一天的绝对数对齐
            check("resolve(item) 对齐到全部唯一条", len(labs) == L.usable, (len(labs), L.usable))
            check("resolve(item) 权重全 1（无分层抽样语义）",
                  all(w == 1.0 for w in weights.values()) or not weights, weights)
            check("resolve(item) 正例与 load 一致",
                  sum(labs.values()) == sum(L.labs.values()), (sum(labs.values()), sum(L.labs.values())))
        else:
            print("SKIP  resolve 真实数据检查")

    print()
    if FAIL:
        print(f"FAILED {len(FAIL)}: {FAIL}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
