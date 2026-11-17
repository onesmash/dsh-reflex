#!/bin/bash
# 运行时解析 JEV_API_KEY —— 不把值写进任何生成物。
#
# 背景（2026-11-17）：旧版 resolve-scorer.sh 把 key 明文写进 runtime/jev-score-wrap.sh，
# 那个文件虽然 700，但同 UID 的任何 bot 都能读，而且它的内容进了会话索引（4 处 + WAL 1 处）。
# 现在改为运行时解析，生成物里只留「去哪儿找」。
#
# 解析顺序（先命中先用）：
#   1. 已有 $JEV_API_KEY（调用方注入）
#   2. $DSH_SECRET_JEV_API_KEY（DSH 密钥卡）
#   3. ~/.dsh/.credentials.yaml 里的 JEV_API_KEY（嵌套 yaml 也找）
#
# 用法：. jev-key-env.sh    （可在 source 或 exec 两种上下文下用；失败退出 78）

if [ -n "${JEV_API_KEY:-}" ]; then
  export JEV_API_KEY
  return 0 2>/dev/null || exit 0
fi

if [ -n "${DSH_SECRET_JEV_API_KEY:-}" ]; then
  JEV_API_KEY="$DSH_SECRET_JEV_API_KEY"
  export JEV_API_KEY
  return 0 2>/dev/null || exit 0
fi

_jev_key="$(python3 - <<'PY' 2>/dev/null
import os, sys
try:
    import yaml
except ImportError:
    sys.exit(0)
p = os.path.expanduser(os.environ.get("REFLEX_CREDENTIALS") or "~/.dsh/.credentials.yaml")

def find(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "JEV_API_KEY" and v:
                return v
            r = find(v)
            if r:
                return r
    return None

try:
    print(find(yaml.safe_load(open(p))) or "")
except Exception:
    pass
PY
)"

if [ -z "${_jev_key:-}" ]; then
  echo "[jev-key-env] 解析不到 JEV_API_KEY（环境变量与凭据文件都没有）" >&2
  unset _jev_key 2>/dev/null || true
  return 78 2>/dev/null || exit 78
fi

JEV_API_KEY="$_jev_key"
export JEV_API_KEY
unset _jev_key
return 0 2>/dev/null || exit 0
