#!/usr/bin/env python3
"""给 shadow_targets.json 的每条记录加 labelsFile/optionsHash，防止用旧结论下判断。

背景（2026-11-12）：落地文件记 P=92.0%/R=95.8%，同口径实测只有 P=66.2%/R=22.7%。
根因是记录没绑定"用的是哪份标签、哪版判据"，标签一换数字就失去意义。
"""
import hashlib, json, os, re, sys

HOME = os.path.expanduser("~/.dsh/dsh-reflex")
TF = os.path.join(HOME, "tools", "shadow_targets.json")

def sha(p):
    if not os.path.exists(p): return None
    return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]

def options_hash(tag):
    """从 target 脚本提取 OPTIONS 段做哈希。改判据 → 哈希变。"""
    p = os.path.join(HOME, "targets", f"{tag}.sh")
    if not os.path.exists(p): return None
    s = open(p, encoding="utf-8").read()
    i = s.find("OPTIONS = [")
    if i < 0: return None
    j = s.find("\n]\n", i)
    seg = s[i:j + 2] if j > 0 else s[i:]
    return hashlib.sha256(seg.encode()).hexdigest()[:16]

d = json.load(open(TF))
for tag, meta in d.items():
    if not isinstance(meta, dict): continue
    base = tag.replace("-replay2", "").replace("-replay", "")
    meta["labelsFile"] = f"shadow/labels-{base}.jsonl"
    meta["labelsHash"] = sha(os.path.join(HOME, "shadow", f"labels-{base}.jsonl"))
    meta["optionsHash"] = options_hash(base)
    meta["stampedAt"] = "2026-11-12T22:30+08:00"
json.dump(d, open(TF, "w"), ensure_ascii=False, indent=2)
print("已加 labelsHash / optionsHash")
for tag, m in d.items():
    if isinstance(m, dict) and m.get("labelsHash"):
        print(f"  {tag}: labels={m['labelsHash']} options={m['optionsHash']}")
