#!/bin/bash
# 影子模式透明包装: 原样执行 SemIf 打分脚本, 结束后把【全部】打分(含阈值以下)落到 shadow/。
#
# 为什么要包一层
#   L1 target 只保留 p(yes) >= 阈值的条目, 阈值以下的分被丢弃。要拟合阈值, 就得先有
#   "所有条目的分" + 后续标注。包在这里的好处是: 所有 target 走同一条打分命令, 一处埋点
#   全源生效, 而且 target 的判定逻辑一行都不用动。
#
# 契约 (必须与 run_score.sh 完全一致)
#   - 参数原样透传; 退出码原样返回; stdout/stderr 原样
#   - 记录失败绝不影响判定: 记录器 `|| true`, 且不向 stdout 写任何东西
#   - 真实打分脚本由 REFLEX_SEMIF_RUN 指定 (插件注入), 未设置时用 skill 默认路径
#
# 环境
#   REFLEX_TARGET       target 名 (插件注入), 作为 shadow 文件的分类
#   REFLEX_SHADOW_MODE   live(默认) | replay
#   REFLEX_HOME         运行目录 (默认 ~/.dsh/dsh-reflex)
#   记录器与本脚本同目录 (skill/reflex-tuning/scripts/), 不依赖运行目录里的副本

set -uo pipefail

LHOME="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"
REAL="${REFLEX_SEMIF_RUN:-$HOME/.agents/skills/semif-decide/scripts/run_score.sh}"

# 防递归: 万一 REFLEX_SEMIF_RUN 指回自己, 退回 skill 默认路径
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
case "$REAL" in
  "$SELF") REAL="$HOME/.agents/skills/semif-decide/scripts/run_score.sh" ;;
esac

IN=""; OUT=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --input)  IN="${args[$((i + 1))]:-}" ;;
    --output) OUT="${args[$((i + 1))]:-}" ;;
  esac
done

bash "$REAL" "$@"
rc=$?

if [ "$rc" -eq 0 ] && [ -n "$IN" ] && [ -s "$IN" ] && [ -n "$OUT" ] && [ -s "$OUT" ]; then
  python3 "$(cd "$(dirname "$0")" && pwd)/shadow_record.py" \
    --tag "${REFLEX_TARGET:-unknown}" \
    --input "$IN" \
    --output "$OUT" \
    --mode "${REFLEX_SHADOW_MODE:-live}" \
    >/dev/null 2>&1 || true
fi

exit "$rc"
