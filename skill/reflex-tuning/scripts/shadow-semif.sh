#!/bin/bash
# 影子模式透明包装: 原样执行 SemIf 打分脚本, 结束后把【全部】打分(含阈值以下)落到 shadow/。
#
# 为什么要包一层
#   L1 target 只保留 p(yes) >= 阈值的条目, 阈值以下的分被丢弃。要拟合阈值, 就得先有
#   "所有条目的分" + 后续标注。包在这里的好处是: 所有 target 走同一条打分命令, 一处埋点
#   全源生效, 而且 target 的判定逻辑一行都不用动。
#
# 契约 (必须与 run_score.sh 完全一致)
#   - 参数原样透传; 退出码原样返回; stdout 为空
#   - 记录失败绝不影响判定: 记录器 `|| true`, 且不向 stdout 写任何东西
#   - 真实打分脚本由 REFLEX_SEMIF_RUN 指定 (插件注入), 未设置时用 skill 默认路径
#   - 打分优先走常驻服务 ($REFLEX_HOME/runtime/semif-resident/call.sh), 不可用则原样
#     回退直调 bash "$REAL"; 两条路径的产物与退出码一致, 影子记录照旧
#
# 环境
#   REFLEX_TARGET       target 名 (插件注入), 作为 shadow 文件的分类
#   REFLEX_SHADOW_MODE   live(默认) | replay
#   REFLEX_HOME         运行目录 (默认 ~/.dsh/dsh-reflex)
#   REFLEX_SEMIF_RESIDENT 0=关闭常驻, 直调 (插件配置 l1.semifResident=false 时注入)
#   记录器与本脚本同目录 (skill/reflex-tuning/scripts/), 不依赖运行目录里的副本

set -uo pipefail

LHOME="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"
# 真实打分脚本: REFLEX_SHADOW_REAL(插件注入, 支持自定义 semif 安装位置)优先;
# 兼容旧的 REFLEX_SEMIF_RUN; 都没有时用 skill 默认。
REAL="${REFLEX_SHADOW_REAL:-${REFLEX_SEMIF_RUN:-$HOME/.agents/skills/semif-decide/scripts/run_score.sh}}"

# 防递归: 万一真实路径指回自己(插件默认注入 shadow wrapper 时会发生), 退回 skill 默认路径
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

# ---------- 常驻优先（2026-11-02） ----------
# 组件随插件分发到 $REFLEX_HOME/runtime/semif-resident/（defaults/semif-resident/）。
# 为什么挂在这里: 所有脚本 target 的打分都经过本 wrapper, 一处接入全源生效。
# 契约不变: 常驻只负责"更便宜地跑出同样的打分文件"; 失败(非 0)一律回退直调。
# 关闭: REFLEX_SEMIF_RESIDENT=0（插件配置 l1.semifResident=false 时注入）。
# 注意: 常驻命中时不会出现 run_score.sh 的 [semif-run] 进度行, 但 stdout 仍然为空、
#       产物与退出码与直调一致 —— target 只依赖产物与退出码。
RESIDENT_CALL="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}/runtime/semif-resident/call.sh"
# ---------- 决策后端分流（2026-11-11 本机补丁） ----------
# jev/jevlocal: 改调 SystemOne CLI，既不碰本地 MLX 也不异常驻。
# 为什么必须在这里分：shadow 记录 / 历史回放 / 判据 A/B / 新判据打分四条链都经过本
# wrapper，只在这一处分流，四条链一起恢复。CLI 输出仍是 SemIf 格式，
# 所以下面的 shadow_record.py 与所有下游消费者都不用改。
DECIDE_BACKEND="${REFLEX_DECIDE_BACKEND:-}"
JEV_SCORE="${REFLEX_JEV_SCORE:-}"
rc=3
case "$DECIDE_BACKEND" in
  jev|jevlocal)
    if [ -n "$JEV_SCORE" ] && [ -f "$JEV_SCORE" ] && command -v node >/dev/null 2>&1; then
      # 插件把 SSL_CERT_FILE 等设成【空字符串】(process.env.X || '')。
      # Homebrew 的 node 23 见到空 SSL_CERT_FILE 会把信任库清空 →
      # fetch 报 "unable to get local issuer certificate"（nvm 的 node 26 不这样，所以手工跑能通）。
      # 空值一律 unset，让它回落到内置根证书。
      for v in SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE; do
        [ -z "${!v:-}" ] && unset "$v"
      done
      node "$JEV_SCORE" "$@"
      rc=$?
    else
      echo "[shadow-semif] backend=$DECIDE_BACKEND 但 jev 打分器不可用 (REFLEX_JEV_SCORE=$JEV_SCORE)" >&2
      rc=3
    fi
    ;;
  *)
    if [ "${REFLEX_SEMIF_RESIDENT:-1}" != "0" ] && [ -n "$IN" ] && [ -n "$OUT" ] && [ -f "$RESIDENT_CALL" ]; then
      bash "$RESIDENT_CALL" "$@"
      rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
      bash "$REAL" "$@"
      rc=$?
    fi
    ;;
esac

if [ "$rc" -eq 0 ] && [ -n "$IN" ] && [ -s "$IN" ] && [ -n "$OUT" ] && [ -s "$OUT" ]; then
  python3 "$(cd "$(dirname "$0")" && pwd)/shadow_record.py" \
    --tag "${REFLEX_TARGET:-unknown}" \
    --input "$IN" \
    --output "$OUT" \
    --mode "${REFLEX_SHADOW_MODE:-live}" \
    >/dev/null 2>&1 || true
fi

exit "$rc"
