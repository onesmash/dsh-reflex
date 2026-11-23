#!/bin/bash
# 重跑「新增数据源」这件事的崩溃原子性模型检查（statechart 的原生替代品，只要有 Java 就能跑）。
#
# 两个判定都要对上才算通过：
#   现顺序  current.cfg（采集器最先落盘）→ Atomic 必须被违反，TLC 退出 12
#   修法顺序 fixed.cfg（采集器最后落盘）  → 必须无错，TLC 退出 0
#
# 退出码三态：0 = 两个都对上；1 = 结论与预期不符；2 = 未判定（找不到 Java / tla2tools.jar）
# 用法： bash docs/verification/create-source/check.sh
#   JAVA / TLA2TOOLS 可用环境变量覆盖，默认见下；不依赖调用方 shell 里已有的别的变量。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
JAVA_BIN="${JAVA:-java}"
TLA_JAR="${TLA2TOOLS:-$HOME/tools/tla/tla2tools.jar}"

command -v "$JAVA_BIN" >/dev/null 2>&1 || { echo "未判定：找不到 Java（设 JAVA=<路径>）" >&2; exit 2; }
[ -f "$TLA_JAR" ] || { echo "未判定：找不到 tla2tools.jar（设 TLA2TOOLS=<路径>）" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/reflex-create-atomic.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

run() { # $1=cfg  $2=out ; 回显 TLC 退出码
  "$JAVA_BIN" -XX:+UseParallelGC -cp "$TLA_JAR" tlc2.TLC -workers auto \
    -config "$1" "$HERE/Order.tla" > "$2" 2>&1
  echo $?
}

rc_cur="$(run "$HERE/current.cfg" "$WORK/current.out")"
rc_fix="$(run "$HERE/fixed.cfg" "$WORK/fixed.out")"

broke_cur=0; grep -q "Invariant Atomic is violated" "$WORK/current.out" && broke_cur=1
clean_fix=0; grep -q "No error has been found" "$WORK/fixed.out" && clean_fix=1

printf '现顺序（采集器最先）：TLC rc=%s，违例=%s\n' "$rc_cur" "$broke_cur"
printf '修法顺序（采集器最后）：TLC rc=%s，无错=%s\n' "$rc_fix" "$clean_fix"

if [ "$rc_cur" = "12" ] && [ "$broke_cur" = "1" ] && [ "$rc_fix" = "0" ] && [ "$clean_fix" = "1" ]; then
  echo "PASS Atomic：现顺序被违反、修法顺序守住 —— 与代码里的落盘顺序一致"
  exit 0
fi
if [ "$rc_fix" = "12" ]; then
  echo "FAIL 修法顺序也被违反：模型或代码的落盘顺序对不上" >&2
  exit 1
fi
if [ "$rc_cur" = "0" ]; then
  echo "FAIL 现顺序居然守住了：模型没覆盖到真实的落盘顺序（先怀疑模型）" >&2
  exit 1
fi
echo "未判定：TLC 既没报违例也没干净结束（rc $rc_cur / $rc_fix），先看 $WORK 里的输出" >&2
exit 2
