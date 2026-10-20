#!/usr/bin/env python3
"""通用唤醒策略: 把"这次该不该叫醒 L2"从各 target 里抽出来。

为什么需要
  回放实验(2026-10-18, x-timeline 5 天数据): 单条目唤醒只有 37% 有价值, 2 条以上 100%。
  于是有了一条与数据源无关的策略:
    - 本轮命中 >=2 条          -> 立即唤醒
    - 单条且分数 >= immediate  -> 立即唤醒(高置信不延迟)
    - 单条且分数 <  immediate  -> 暂存, 等 wait 分钟内凑到第二条再发
    - 暂存超时                 -> 分数 >= late_min 则补发, 否则丢弃 (late_min=None 退回旧行为: 全部丢弃)
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


def decide(items, state_file, now_ms, wait_min=60.0, immediate=0.98, defer=True, late_min=None):
    """应用唤醒策略。返回 {wake, items, reason, deferred}。

    late_min: 暂存超时后仍值得单独发的分数下限; None = 超时即丢弃 (旧行为)。
    """
    cur = _dedupe(list(items or []))
    wait_ms = float(wait_min) * 60_000
    stored = _load_state(state_file)
    fresh, late = [], []
    for d in stored:
        age = now_ms - int(d.get("at") or 0)
        (fresh if age <= wait_ms else late).append(d)
    late_items = []
    if late_min is not None:
        for d in late:
            sc = d.get("score")
            if sc is None:
                sc = (d.get("item") or {}).get("score", 0)
            if float(sc or 0) >= float(late_min):
                late_items.append(d["item"])
    late_suffix = f" + 超时补发 {len(late_items)} 条" if late_items else ""

    def out(items_out, reason, deferred, wake=True):
        merged = _dedupe(items_out)
        _save_state(state_file, deferred)
        return {"wake": wake, "items": merged if wake else [],
                "reason": reason, "deferred": len(deferred)}

    if len(cur) >= 2:
        suffix = f" + 暂存合并 {len(fresh)} 条" if fresh else ""
        return out(cur + [d["item"] for d in fresh] + late_items,
                   "多条目命中" + suffix + late_suffix, [])

    if len(cur) == 1:
        single = cur[0]
        score = float(single.get("score", 1.0))
        if not defer:
            return out(cur + [d["item"] for d in fresh] + late_items, "单条即发(策略关闭)", [])
        if fresh:
            return out(cur + [d["item"] for d in fresh] + late_items,
                       f"第二条到达, 合并暂存 {len(fresh)} 条" + late_suffix, [])
        if score >= float(immediate):
            return out(cur + late_items, "单条即发(高置信)" + late_suffix, [])
        # 本条进暂存; 若手里正好有超时高分条目, 先把它们发出去 (不吞)
        if late_items:
            return out(late_items, f"暂存超时补发 {len(late_items)} 条",
                       fresh + [{"item": single, "score": score, "at": now_ms}])
        fresh.append({"item": single, "score": score, "at": now_ms})
        return out([], f"单条目暂存待第二条 (分数 {score:.2f}, 暂存 {len(fresh)} 条)", fresh, wake=False)

    # 本轮没有新命中: 过期暂存按 late_min 补发或丢弃
    if late_items:
        return out(late_items, f"暂存超时补发 {len(late_items)} 条", fresh)
    return out([], "本轮无命中" + (f" (暂存 {len(fresh)} 条)" if fresh else ""), fresh, wake=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["decide"])
    ap.add_argument("--state-file", required=True)
    ap.add_argument("--now-ms", type=int, default=None)
    ap.add_argument("--wait-min", type=float, default=60.0)
    ap.add_argument("--immediate", type=float, default=0.98)
    ap.add_argument("--late-min", type=float, default=None, help="暂存超时后仍可单独发的分数下限 (不设=丢弃)")
    ap.add_argument("--no-defer", action="store_true")
    a = ap.parse_args()
    payload = json.load(sys.stdin)
    items = payload.get("items") or []
    now_ms = a.now_ms if a.now_ms is not None else int(__import__("time").time() * 1000)
    out = decide(items, a.state_file, now_ms, wait_min=a.wait_min,
                 immediate=a.immediate, defer=not a.no_defer, late_min=a.late_min)
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
