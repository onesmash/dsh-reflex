#!/usr/bin/env bash
# 常驻打分器的薄调用器（由 shadow-semif.sh 调用）。
#
# 契约：
#   退出 0  → 常驻已完成打分，输出文件已就位（调用方不要再跑直调）
#   退出 3  → 常驻不可用/失败，调用方 MUST 回退到 run_score.sh 直调（行为与现在一致）
#
# 这里不写任何到 stdout 的内容；进度只写 stderr。
# 进程被 SIGKILL 会留下死 socket（文件在、没人 listen）：检测到就用退出码 3 + 清残留，
# 下一次调用重新拉起，避免一次崩溃把后续所有打分永久打回直调。

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFLEX="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"
RUN_DIR="${REFLEX_SEMIF_RUN_DIR:-$REFLEX/run}"
SOCK="$RUN_DIR/semif.sock"
SPAWN_TICKS="${REFLEX_SEMIF_SPAWN_TICKS:-125}"   # 启动等待：125 × 0.2s = 25s

ensure_server() {
  [ -S "$SOCK" ] && return 0
  mkdir -p "$RUN_DIR" 2>/dev/null
  local lock="$RUN_DIR/semif.spawn.lock"
  if mkdir "$lock" 2>/dev/null; then
    nohup bash "$SELF_DIR/serve.sh" >>"$RUN_DIR/semif-resident.out" 2>&1 &
    for _ in $(seq 1 "$SPAWN_TICKS"); do [ -S "$SOCK" ] && break; sleep 0.2; done
    rmdir "$lock" 2>/dev/null
  else
    for _ in $(seq 1 "$SPAWN_TICKS"); do [ -S "$SOCK" ] && break; sleep 0.2; done
  fi
  [ -S "$SOCK" ]
}

ensure_server || exit 3

python3 "$SELF_DIR/request.py" "$@"
rc=$?
[ "$rc" -eq 0 ] && exit 0

# 传输层失败（含死 socket）：清残留再试一次，仍失败就交给调用方回退
if [ -S "$SOCK" ]; then
  rm -f "$SOCK" 2>/dev/null
  if ensure_server; then
    python3 "$SELF_DIR/request.py" "$@"
    [ "$?" -eq 0 ] && exit 0
  fi
fi
exit 3
