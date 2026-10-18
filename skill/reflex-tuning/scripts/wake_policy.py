#!/usr/bin/env python3
"""通用唤醒策略: 把"这次该不该叫醒 L2"从各 target 里抽出来。

为什么需要
  回放实验(2026-10-18, x-timeline 5 天数据): 单条目唤醒只有 37% 有价值, 2 条以上 100%。
  于是有了一条与数据源无关的策略:
    - 本轮命中 >=2 条          -> 立即唤醒
    - 单条且分数 >= immediate  -> 立即唤醒(高置信不延迟)
    - 单条且分数 <  immediate  -> 暂存, 等 wait 分钟内凑到第二条再发
    - 暂存超时                 -> 丢弃
  这套逻辑不该写死在某个 target 里, 所以做成库 + CLI, 任何 target 都能调用。

目标侧用法 (target 的 decide.py 内, 假定已算出通过阈值的 items):
    import os, sys, json, time
    tuning = os.environ.get("REFLEX_TUNING_DIR") or os.path.expanduser("~/.agents/skills/reflex-tuning/scripts")
    sys.path.insert(0, tuning)
    import wake_policy
    decision = wake_policy.decide(
        items,                                   # [{"id","title","body","score"}...]
        state_file=os.path.join(lhome, "my-target-deferred.json"),
        now_ms=int(time.time() * 1000),
        wait_min=60, immediate=0.98, defer=True,
    )
    # decision = {"wake": bool, "items": [...], "reason": "...", "deferred": N}
    # items 已包含合并进来的暂存条目(去重), wake=false 时不要输出条目

CLI (便于 shell target / 调试):
    echo '{"items":[...]}' | python3 wake_policy.py decide \
        --state-file /tmp/x-deferred.json --now-ms 1792300000000 --wait-min 60 --immediate 0.98
    输出 {"wake":bool,"items":[...],"reason":"...","deferred":N}

约定
  - items 里每条必须带 "score"(通过阈值时的分数); 没有 score 视为 1.0 (硬规则 target)
  - 状态文件是 JSON 数组, 原子写 (tmp + replace); 读写失败时降级为"本轮直接发", 不吞条目
  - 不做去重窗口/冷却/安静时段 —— 那些归插件; 这里只管"单条要不要等第二条"
"""
import argparse
import json
import os
import sys
import tempfile


def _load_state(state_file):
    try:
        with open(state_file, encoding="utf-8") as fh:
            rows = json.load(fh)
        if isinstance(rows, list):
            return [r for r in rows if isinstance(r, dict) and r.get("item")]
    except FileNotFoundError:
        return []
    except Exception:
        return []
    return []


def _save_state(state_file, rows):
    if not state_file:
        return
    try:
        d = os.path.dirname(state_file) or "."
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".wake-policy-", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False)
        os.replace(tmp, state_file)
    except Exception:
        pass


def _dedupe(items):
    seen, out = set(), []
    for it in items:
        key = str(it.get("id") or "") or str(id(it))
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def decide(items, state_file, now_ms, wait_min=60.0, immediate=0.98, defer=True):
    """应用唤醒策略。返回 {wake, items, reason, deferred}。"""
    cur = _dedupe(list(items or []))
    wait_ms = float(wait_min) * 60_000
    deferred = [d for d in _load_state(state_file)
                if now_ms - int(d.get("at") or 0) <= wait_ms]

    if len(cur) >= 2:
        merged = _dedupe(cur + [d["item"] for d in deferred])
        _save_state(state_file, [])
        suffix = f" + 暂存合并 {len(deferred)} 条" if deferred else ""
        return {"wake": True, "items": merged, "reason": "多条目命中" + suffix, "deferred": 0}

    if len(cur) == 1:
        single = cur[0]
        score = float(single.get("score", 1.0))
        if not defer:
            merged = _dedupe(cur + [d["item"] for d in deferred])
            _save_state(state_file, [])
            return {"wake": True, "items": merged, "reason": "单条即发(策略关闭)", "deferred": 0}
        if deferred:
            # 已有暂存: 这一条就是"第二条"
            merged = _dedupe(cur + [d["item"] for d in deferred])
            _save_state(state_file, [])
            return {"wake": True, "items": merged,
                    "reason": f"第二条到达, 合并暂存 {len(deferred)} 条", "deferred": 0}
        if score >= float(immediate):
            return {"wake": True, "items": cur, "reason": "单条即发(高置信)", "deferred": 0}
        deferred.append({"item": single, "score": score, "at": now_ms})
        _save_state(state_file, deferred)
        return {"wake": False, "items": [],
                "reason": f"单条目暂存待第二条 (分数 {score:.2f}, 暂存 {len(deferred)} 条)",
                "deferred": len(deferred)}

    # 本轮没有新命中: 保留未过期暂存 (顺带清过期)
    _save_state(state_file, deferred)
    return {"wake": False, "items": [],
            "reason": "本轮无命中" + (f" (暂存 {len(deferred)} 条)" if deferred else ""),
            "deferred": len(deferred)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["decide"])
    ap.add_argument("--state-file", required=True)
    ap.add_argument("--now-ms", type=int, default=None)
    ap.add_argument("--wait-min", type=float, default=60.0)
    ap.add_argument("--immediate", type=float, default=0.98)
    ap.add_argument("--no-defer", action="store_true")
    a = ap.parse_args()
    payload = json.load(sys.stdin)
    items = payload.get("items") or []
    now_ms = a.now_ms if a.now_ms is not None else int(__import__("time").time() * 1000)
    out = decide(items, a.state_file, now_ms, wait_min=a.wait_min,
                 immediate=a.immediate, defer=not a.no_defer)
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
