#!/bin/bash
# 幂等打分器包装：跑之前自动清掉本次会生成的所有输出。
#
# 为什么需要（2026-11-12 实测）：
#   SemIf/jev 打分器是 create-only（防"以为重跑了其实没跑"），命中已存在文件就 fail。
#   upstream 的 pc_inject.py 只清 `X.jsonl.summary.md`，而 jev-score 实际生成
#   `X.summary.md`（去掉 .jsonl 后缀再拼），两者路径不一致 → 清理无效 → 每次重跑都失败。
#   本包装在调用前把所有可能的目标路径都清掉，对两种命名都兼容。
set -uo pipefail
REAL="${REFLEX_SCORER_REAL:-}"
if [ -z "$REAL" ]; then
  REAL="$(bash "$(dirname "$0")/resolve-scorer.sh")"
fi

IN=""; OUT=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[$i]}" in
    --input)  IN="${args[$((i+1))]:-}" ;;
    --output) OUT="${args[$((i+1))]:-}" ;;
  esac
done
[ -n "$OUT" ] || { echo "[scorer-resilient] 需要 --output" >&2; exit 2; }

# 清掉所有可能的产物路径（两种命名 + 全局 summary）
for f in \
  "$OUT" \
  "${OUT%.jsonl}.summary.md" \
  "$OUT.summary.md" \
  ; do
  [ -e "$f" ] && rm -f "$f"
done

exec bash "$REAL" "$@"
