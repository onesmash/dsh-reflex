#!/bin/bash
# 统一解析打分器路径，供 reflex-tuning 各工具调用。
#
# 为什么需要（2026-11-12 实测）：
#   pc_inject.py 默认硬编码 ~/.agents/skills/semif-decide/scripts/run_score.sh，
#   而本机实际走 jev 后端。结果是生产路径能打分、分析路径跑不通。
#   同一个 skill 内部两种后端知识不一致 → 抽出本脚本作为唯一真相来源。
#
# 解析顺序（先命中先用）:
#   1. $REFLEX_SCORE_CMD            —— 显式指定，最高优先
#   2. $REFLEX_DECIDE_BACKEND=jev   —— 需要 JEV_API_KEY + jev-score.mjs，生成权限 700 的包装器
#   3. semif-decide 默认路径
#
# 环境变量:
#   REFLEX_SCORE_CMD      完整命令，直接返回
#   REFLEX_JEV_SCORE      jev 打分器路径（默认 $HOME/SourceCode/dsh-reflex/jev-score.mjs）
#   REFLEX_CREDENTIALS    凭据文件（默认 $HOME/.dsh/.credentials.yaml）
#   REFLEX_SCORER_CACHE   包装器输出路径（默认 $REFLEX_HOME/runtime/jev-score-wrap.sh）
#   JEV_BASE_URL / JEV_MODEL
set -uo pipefail

HOME_DIR="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"
CRED="${REFLEX_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
JEV_SCORE="${REFLEX_JEV_SCORE:-$HOME/SourceCode/dsh-reflex/jev-score.mjs}"
WRAP="${REFLEX_SCORER_CACHE:-$HOME_DIR/runtime/jev-score-wrap.sh}"

_read_cred() {   # $1 = key 名；支持嵌套 yaml
  [ -f "$CRED" ] || return 1
  python3 - "$CRED" "$1" <<'PY'
import sys
try:
    import yaml
except ImportError:
    sys.exit(1)
path, key = sys.argv[1], sys.argv[2]
try:
    d = yaml.safe_load(open(path))
except Exception:
    sys.exit(1)
def find(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                return v
            r = find(v)
            if r:
                return r
    return None
v = find(d)
print(v if v else "")
PY
}

# 1) 显式指定
if [ -n "${REFLEX_SCORE_CMD:-}" ]; then
  echo "$REFLEX_SCORE_CMD"; exit 0
fi

# 2) jev
KEY="$(_read_cred JEV_API_KEY)"
if [ -n "$KEY" ] && [ -f "$JEV_SCORE" ]; then
  mkdir -p "$(dirname "$WRAP")"
  JEV_URL_RESOLVED="${JEV_BASE_URL:-https://llm-ei7x74obik76ddkb.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone}"
  JEV_MODEL_RESOLVED="${JEV_MODEL:-decision-model-preview}"
  cat > "$WRAP" <<WRAPEOF
#!/bin/bash
# 自动生成，勿手改（由 tools/resolve-scorer.sh 产生）
export JEV_API_KEY="$KEY"
export JEV_MODEL="$JEV_MODEL_RESOLVED"
export JEV_BASE_URL="$JEV_URL_RESOLVED"
exec node "$JEV_SCORE" "\$@"
WRAPEOF
  chmod 700 "$WRAP"
  echo "$WRAP"; exit 0
fi

# 3) semif-decide
echo "$HOME/.agents/skills/semif-decide/scripts/run_score.sh"
