#!/usr/bin/env python3
"""把 idx 型标签转成 key 型（state_hash），消除 shadow 增长导致的错位。

背景（2026-11-12 实测）：
  threshold_fit --export-sample 产出的 sample-<tag>.json 是 {idx, key, w}，
  而标注文件是 {idx, label}。idx 是【采样序号】，绑定 shadow 文件的记录顺序。
  shadow 是滚动追加的，新增 10 条后重导出，idx→key 映射整体偏移。
  本次因此错位 9 条，且不报任何错 —— 只会让 P/R 静默算错。

  key = state_hash 是内容哈希，稳定。
"""
import json, os, sys, hashlib

HOME = os.path.expanduser("~/.dsh/dsh-reflex")
tag = sys.argv[1] if len(sys.argv) > 1 else "x-timeline"

sample_f = os.path.join(HOME, "shadow", f"sample-{tag}.json")
labels_f = os.path.join(HOME, "shadow", f"labels-{tag}.jsonl")
out_f    = os.path.join(HOME, "shadow", f"labels-{tag}-bykey.jsonl")

if not os.path.exists(sample_f):
    print(f"缺 {sample_f}（先跑 threshold_fit --export-sample）", file=sys.stderr)
    sys.exit(2)

items = json.load(open(sample_f))["items"]
idx2key = {int(it["idx"]): it["key"] for it in items}

rows, missing = [], []
for line in open(labels_f, encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    k = idx2key.get(int(r.get("idx", -1)))
    if k is None:
        missing.append(r.get("idx"))
        continue
    rows.append({"key": k, "label": int(r["label"]),
                 **({k2: v for k2, v in r.items()
                     if k2 not in ("idx", "key", "label")})})

with open(out_f, "w", encoding="utf-8") as fh:
    for r in rows:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")

print(f"转换 {len(rows)}/{len(rows)+len(missing)} 条 → {out_f}")
if missing:
    print(f"  ⚠️ {len(missing)} 条 idx 在 sample 里找不到: {missing[:10]}", file=sys.stderr)
    print("  说明 sample 被重导出了，需要重新标注或从旧 sample 恢复", file=sys.stderr)
    sys.exit(1)
print("PASS: 全部 idx 已映射到稳定 key")
