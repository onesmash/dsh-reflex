#!/bin/bash
# 登记表派生值一致性模型检查（只需要 Java，不需要 statechart）。
#
# 两个判定都要对上才算通过：
#   two-step.cfg       复制品方案（计数与派生分两步写）→ ReadConsistent 必须被违反，TLC 退出 12
#   single-source.cfg  单一真值源（派生在读时现算）    → 必须无错，TLC 退出 0
#
# 退出码三态：0 = 两个都对上；1 = 结论与预期不符；2 = 未判定（找不到 Java / tla2tools.jar）
# 用法： bash docs/verification/registry-consistency/check.sh
#   RVC_JAVA / RVC_TLA2TOOLS 可覆盖；不读调用方 shell 里别的变量。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
JAVA_BIN="${RVC_JAVA:-java}"
TLA_JAR="${RVC_TLA2TOOLS:-$HOME/tools/tla/tla2tools.jar}"

command -v "$JAVA_BIN" >/dev/null 2>&1 || { echo "未判定：找不到 Java（设 RVC_JAVA=<路径>）" >&2; exit 2; }
[ -f "$TLA_JAR" ] || { echo "未判定：找不到 tla2tools.jar（设 RVC_TLA2TOOLS=<路径>）" >&2; exit 2; }
[ -f "$HERE/Registry.tla" ] || { echo "未判定：模型文件不在预期位置（$HERE/Registry.tla 不存在）" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/reflex-registry.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

run() { # $1=cfg  $2=out ; 回显 TLC 退出码
  "$JAVA_BIN" -XX:+UseParallelGC -cp "$TLA_JAR" tlc2.TLC -workers auto \
    -config "$HERE/$1" "$HERE/Registry.tla" > "$2" 2>&1
  echo $?
}

rc_two="$(run two-step.cfg "$WORK/two.txt")"
rc_one="$(run single-source.cfg "$WORK/single.txt")"

echo "two-step      exit=$rc_two   （期望 12 = 不变量被违反）"
echo "single-source exit=$rc_one  （期望 0  = 无错）"

fail=0
[ "$rc_two" = "12" ] || { echo "不符：two-step 未按预期报红。最后几行：" >&2; tail -5 "$WORK/two.txt" >&2; fail=1; }
[ "$rc_one" = "0" ] || { echo "不符：single-source 未按预期通过。最后几行：" >&2; tail -5 "$WORK/single.txt" >&2; fail=1; }

if [ "$fail" = "0" ]; then
  echo "结论：两张卡都对上——复制品方案存在可读窗口，单一真值源没有。"
  exit 0
fi
exit 1
