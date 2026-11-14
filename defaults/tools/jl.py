#!/usr/bin/env python3
"""reflex jsonl 读写helper。存在的理由：本会话内 json.load 误用于 jsonl 达 3 次。"""
import json, os, sys

def load(path):
    """读 jsonl → list[dict]。自动兼容被误写成 JSON 数组的旧文件。

    文件不存在时返回空列表（而不是抛异常）——调用方多半是"有就用，没有就当空"。
    """
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
    dec = json.JSONDecoder()
    i = 0
    n = len(raw)
    while i < n:
        while i < n and raw[i] in " \n\r\t":
            i += 1
        if i >= n:
            break
        try:
            obj, j = dec.raw_decode(raw, i)
        except json.JSONDecodeError:
            # 跳过坏行
            nl = raw.find("\n", i)
            if nl < 0:
                break
            i = nl + 1
            continue
        i = j
        if isinstance(obj, list):
            out.extend(x for x in obj if isinstance(x, dict))
        elif isinstance(obj, dict):
            out.append(obj)
    return out

def dump(path, rows):
    with open(path, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

def p_yes(rec):
    """从打分记录取 yes 概率。兼容 probabilities 缺失。"""
    ids = rec.get("option_ids") or []
    probs = rec.get("probabilities") or []
    if "yes" in ids and len(probs) == len(ids):
        return float(probs[ids.index("yes")])
    return float(rec.get("p_yes") or rec.get("score") or 0.0)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: jl.py <file.jsonl>  → 打印条数与字段", file=sys.stderr)
        sys.exit(2)
    rows = load(sys.argv[1])
    print(f"{len(rows)} 条")
    if rows:
        print("字段:", list(rows[0].keys()))
