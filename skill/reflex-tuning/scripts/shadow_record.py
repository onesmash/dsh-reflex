#!/usr/bin/env python3
"""Shadow 记录器: 把一次 SemIf 批量打分的【全部】条目落盘, 供阈值拟合使用。

为什么需要它
  L1 target 只在 p(yes) >= 阈值时输出条目, 阈值以下的分被直接丢弃 —— 于是
  "阈值定得对不对"只能靠事后回忆, 没法量化。这个记录器不改判定, 只旁路复制一份
  打分数据: 影子策略照常打分, 只是不执行动作 (论文里的 shadow mode)。

契约
  target 不要直接调它, 走 tools/shadow-semif.sh 透明包装:
    --input  rows.jsonl   SemIf 输入 {id,state,question,options}
    --output out.jsonl    SemIf 输出 {id,option_ids[],probabilities[]}
                          或适配层格式 {id,decision,probability,confidence}
    --tag    <target 名>  取自插件注入的 REFLEX_TARGET
    --mode   live|replay  回放产生的数据要和线上数据分开统计

落盘
  $REFLEX_HOME/shadow/<tag>-<YYYY-MM-DD>.jsonl, 一行一条, 只追加。
  阈值来自 tools/shadow_targets.json (tag -> threshold), 没有就记 null。
  同一份输入重复回放会产生重复记录 —— 分析端用 key 去重, 这里不做状态。

失败绝不外溢: 调用方已把本程序包在 `|| true` 里, 它自身也不写 stdout。
"""
import argparse
import hashlib
import json
import os
import sys
import time

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")


def read_jsonl(path):
    rows = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
    except FileNotFoundError:
        return []
    return rows


def score_of(out_row):
    """从两种打分格式里取 p(yes)。返回 (p_yes, probs_map)。"""
    ids = out_row.get("option_ids") or []
    probs = out_row.get("probabilities") or []
    pmap = {str(ids[i]): float(probs[i]) for i in range(min(len(ids), len(probs)))}
    if "yes" in pmap:
        return pmap["yes"], pmap
    if "probability" in out_row:                    # 适配层
        try:
            return float(out_row.get("probability") or 0.0), pmap
        except Exception:
            return 0.0, pmap
    return (max(pmap.values()) if pmap else 0.0), pmap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--mode", default="live")
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--state-chars", type=int, default=1200)
    ap.add_argument("--question-chars", type=int, default=600)
    a = ap.parse_args()

    rows = read_jsonl(a.input)
    outs = {}
    for o in read_jsonl(a.output):
        try:
            outs[str(o.get("id"))] = o
        except Exception:
            continue
    if not rows:
        return 0

    threshold = None
    try:
        cfg = json.load(open(os.path.join(a.home, "tools", "shadow_targets.json"), encoding="utf-8"))
        threshold = (cfg.get(a.tag) or {}).get("threshold")
    except Exception:
        pass

    ts = int(time.time() * 1000)
    date = time.strftime("%Y-%m-%d", time.localtime(ts / 1000))
    outdir = os.path.join(a.home, "shadow")
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"{a.tag}-{date}.jsonl")

    lines = []
    missing = 0
    for row in rows:
        rid = str(row.get("id"))
        o = outs.get(rid)
        if o is None:
            missing += 1
            continue
        score, pmap = score_of(o)
        state = str(row.get("state") or "")
        question = str(row.get("question") or "")
        key = hashlib.sha1(
            (a.tag + "\x00" + question + "\x00" + state).encode("utf-8", "replace")
        ).hexdigest()[:16]
        # 同一 state 在不同判据/不同 tag 下的记录用 state_hash 对齐 (判据 A/B 用)
        state_hash = hashlib.sha1(state.encode("utf-8", "replace")).hexdigest()[:16]
        passed = None if threshold is None else bool(score >= float(threshold))
        rec = {
            "ts": ts,
            "mode": a.mode,
            "tag": a.tag,
            "key": key,
            "state_hash": state_hash,
            "id": rid,
            "score": round(float(score), 6),
            "threshold": threshold,
            "passed": passed,
            "p_yes": round(float(pmap.get("yes", score)), 6),
            "question": question[: a.question_chars],
            "state": state[: a.state_chars],
        }
        lines.append(json.dumps(rec, ensure_ascii=False))
    if not lines:
        return 0
    # 单次 O_APPEND write: 多个 target 并发写同一个文件时不会互相截断
    data = ("\n".join(lines) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    if missing:
        print(f"shadow_record: {missing}/{len(rows)} 条无打分结果", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
