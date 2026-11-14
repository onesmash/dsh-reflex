#!/usr/bin/env python3
"""stamp-targets — 已并入 tune-preflight.py（保留本文件只做转调，避免两份哈希算法）。

背景（2026-11-12）：落地文件记 P=92.0%/R=95.8%，同口径实测只有 P=66.2%/R=22.7%，
根因是记录没绑定「用的是哪份标签、哪版判据」。
背景（2026-11-14）：本脚本原来只认 `OPTIONS = [` 写法，对 `SHADOW_YES/NO` 风格的 target
静默返回 None，registry 缺字段也不报错 —— 于是「判据未登记」这类问题查不出来。

现在判据指纹的唯一算法在 tools/judge-sync.py（canonical_hash：question + options），
登记入口是 tools/tune-preflight.py --stamp。本文件仅转调，保证没有第二份实现。
"""
import os
import subprocess
import sys

HOME = os.path.expanduser(os.environ.get("REFLEX_HOME", "~/.dsh/dsh-reflex"))
TOOL = os.path.join(HOME, "tools", "tune-preflight.py")

if not os.path.exists(TOOL):
    sys.exit(f"stamp-targets: 找不到 {TOOL}（新版把登记并入 tune-preflight.py）")
print("stamp-targets 已并入 tune-preflight.py，转调 --stamp …", file=sys.stderr)
sys.exit(subprocess.call([sys.executable, TOOL, "--tag", "all", "--stamp"]))
