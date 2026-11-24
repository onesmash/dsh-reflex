#!/bin/bash
# 一条命令重跑 shadow_targets 一致性的全部证据（S1 模型 + S2/S3 守门 + 登记表机器核对）。
#
# 判据（verifying-design-invariants S5）：干净 shell 里能跑、不靠调用方 shell 里已有的变量、
# 贴真实退出码、从零跑一次就出结论。三态：0 全过 / 1 有失败 / 2 未判定（缺工具或数据）。
#
# 用法：
#   bash docs/verification/registry-consistency/check-all.sh
#   RVCA_HOME=<运行时目录> RVCA_NODE=node RVCA_PYTHON=python3 bash ...
#   （运行时目录默认取 REFLEX_HOME，再退到 ~/.dsh/dsh-reflex）
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
HOME_DIR="${RVCA_HOME:-${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}}"
NODE_BIN="${RVCA_NODE:-node}"
PY_BIN="${RVCA_PYTHON:-python3}"
REGISTER="$ROOT/docs/property-register-targets.md"

fail=0
undecided=0

echo "== 0) 前置 =="
[ -d "$HOME_DIR" ] || { echo "未判定：运行时目录不存在（RVCA_HOME / REFLEX_HOME）" >&2; exit 2; }
[ -f "$ROOT/tests/test-reflex-targets-invariants.py" ] || {
  echo "未判定：守门测试不在预期位置（找错目录，不是数据不足）" >&2; exit 2; }
echo "ROOT=$ROOT"
echo "HOME_DIR=$HOME_DIR"

echo
echo "== 1) 模型两卡（two-step 必须红 / single-source 必须绿）=="
bash "$HERE/check.sh"
rc=$?
case "$rc" in
  0) ;;
  2) echo "未判定：模型检查缺工具" >&2; undecided=1 ;;
  *) echo "失败：模型两卡结论与预期不符（exit $rc）" >&2; fail=1 ;;
esac

echo
echo "== 2) 守门测试（T1–T6）=="
"$PY_BIN" "$ROOT/tests/test-reflex-targets-invariants.py" --home "$HOME_DIR"
rc=$?
case "$rc" in
  0) ;;
  2) echo "未判定：登记表或读层缺失" >&2; undecided=1 ;;
  *) echo "失败：守门测试报红（exit $rc）" >&2; fail=1 ;;
esac

echo
echo "== 3) 登记表机器核对 =="
if command -v "$NODE_BIN" >/dev/null 2>&1 && [ -f "$REGISTER" ]; then
  CHECKER="${RVCA_CHECKER:-}"
  if [ -z "$CHECKER" ]; then
    for c in "$HOME/.agents/skills/verifying-design-invariants/scripts/check-register.mjs" \
             "$ROOT/.agents/skills/verifying-design-invariants/scripts/check-register.mjs"; do
      [ -f "$c" ] && CHECKER="$c" && break
    done
  fi
  if [ -z "$CHECKER" ]; then
    echo "未判定：找不到 check-register.mjs（设 RVCA_CHECKER=<路径>）" >&2
    undecided=1
  else
    "$NODE_BIN" "$CHECKER" "$REGISTER" --root "$ROOT"
    rc=$?
    case "$rc" in
      0) ;;
      2) echo "未判定：登记表读不进（缺表头）" >&2; undecided=1 ;;
      *) echo "失败：登记表核对有 ERROR（exit $rc）" >&2; fail=1 ;;
    esac
  fi
else
  echo "未判定：没有 $NODE_BIN 或登记表不存在" >&2
  undecided=1
fi

echo
if [ "$fail" = "1" ]; then
  echo "结论：有失败（见上面 exit 非 0 的那一步）"
  exit 1
fi
if [ "$undecided" = "1" ]; then
  echo "结论：未判定（缺工具或数据，不等于通过）"
  exit 2
fi
echo "结论：全过——模型两卡成对、守门 20 项绿（T1-e 声明过期另计）、登记表核对 OK"
exit 0
