#!/usr/bin/env bash
# 常驻 SemIf 打分器 · 启动器
#
# 随插件分发 (defaults/semif-resident/)，插件启动时同步到
#   $REFLEX_HOME/runtime/semif-resident/
# 由 call.sh 按需拉起；setup_env.sh 的依赖探测只在这里跑一次（原本每次打分都要付）。
#
# 环境：
#   REFLEX_HOME            运行目录（插件注入；默认 ~/.dsh/dsh-reflex）
#   REFLEX_SEMIF_BACKEND   默认 mlx；非 mlx 直接退出，由上层回退直调
#   REFLEX_SEMIF_SETUP     setup_env.sh 路径（默认 ~/.agents/skills/semif-decide/scripts/setup_env.sh）

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVE_PY="$SELF_DIR/serve.py"
BACKEND="${REFLEX_SEMIF_BACKEND:-mlx}"
SETUP="${REFLEX_SEMIF_SETUP:-$HOME/.agents/skills/semif-decide/scripts/setup_env.sh}"

[ -f "$SERVE_PY" ] || { echo "[semif-resident] serve.py missing: $SERVE_PY" >&2; exit 1; }
[ -f "$SETUP" ] || { echo "[semif-resident] setup_env.sh missing: $SETUP" >&2; exit 1; }
# 目前只实现 MLX（Apple Silicon）。其它后端不算错，只是不常驻 —— 让上层回退直调。
[ "$BACKEND" = "mlx" ] || { echo "[semif-resident] backend=$BACKEND unsupported, exiting" >&2; exit 1; }

resolved=$(bash "$SETUP" --backend "$BACKEND" 2>/dev/null) || {
  echo "[semif-resident] setup_env failed" >&2
  exit 1
}

SEMIF_REPO=$(printf '%s\n' "$resolved" | sed -n 's/^SEMIF_REPO=//p' | head -1)
SEMIF_VENV=$(printf '%s\n' "$resolved" | sed -n 's/^SEMIF_VENV=//p' | head -1)
[ -n "$SEMIF_REPO" ] && [ -n "$SEMIF_VENV" ] || {
  echo "[semif-resident] cannot resolve SEMIF_REPO/SEMIF_VENV" >&2
  exit 1
}

export SEMIF_REPO SEMIF_VENV
exec "$SEMIF_VENV/bin/python" "$SERVE_PY"
