#!/bin/bash
# 审计复跑（**修复后**的版本）：十条观测，逐条断言「检查器现在能报出来」或「文档已改」。
# 修复前的输出留在 evidence/rerun-before.txt，两版对照才看得出改动真的生效。
#
# 退出码三态：0 = 十条与预期一致；1 = 至少一条不符；2 = 未判定（找不到 node / 文件）
# 用法：bash evidence/rerun.sh
#   VDI_SKILL 覆盖技能目录，NODE_BIN 覆盖 node 目录（默认值只是本机取值）。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
SKILL="${VDI_SKILL:-$HOME/.agents/skills/verifying-design-invariants}"
PATH="${NODE_BIN:-/usr/local/bin}:$PATH"
REG="$REPO/docs/property-register-sources.md"
V="$REPO/docs/verification/create-source"
CHK="$SKILL/scripts/check-register.mjs"
PATHS="$SKILL/scripts/check-paths.mjs"

command -v node >/dev/null 2>&1 || { echo "未判定：找不到 node（设 NODE_BIN=<目录>）" >&2; exit 2; }
[ -f "$CHK" ] || { echo "未判定：找不到 $CHK（设 VDI_SKILL=<技能目录>）" >&2; exit 2; }
[ -f "$REG" ] || { echo "未判定：找不到 $REG" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vdi-audit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

bad=0
field() { # $1=json文本 $2=字段名
  printf '%s\n' "$1" | sed -n "s/^[[:space:]]*\"$2\":[[:space:]]*\(.*\),\{0,1\}$/\1/p" | head -1 | tr -d '"' | sed 's/,$//'
}
expect() { # $1=label $2=actual $3=expected
  if [ "$2" = "$3" ]; then
    echo "   ok ${1}=${2}"
  else
    echo "   MISMATCH ${1}=${2}（期望 ${3}）"; bad=1
  fi
}

echo "== 环境"
echo "repo   = $REPO"
echo "skill  = $SKILL"
node --version

# E1 全表
out="$(node "$CHK" "$REG" --root "$REPO" 2>&1)"; rc=$?
echo "== E1 全表"
expect verdict "$(field "$out" verdict)" "OK"
expect rows "$(field "$out" rows)" "19"
expect rc "$rc" "0"

# E2 表内空行：现在必须报「表格中断」
p10="$(grep -n '^| P10 ' "$REG" | cut -d: -f1)"
before="$(head -n "$((p10 - 1))" "$REG" | grep -c '^| P')"
awk 'BEGIN{d=0} /^\| P10 /{if(!d){print "";d=1}} {print}' "$REG" > "$WORK/blank.md"
out="$(node "$CHK" "$WORK/blank.md" --root "$REPO" 2>&1)"; rc=$?
echo "== E2 表内空行（应报错，而不是读 9 行还 OK）"
expect verdict "$(field "$out" verdict)" "FAIL"
expect rc "$rc" "1"
expect truncated "$(printf '%s' "$out" | grep -c '表格在第')" "1"

# E3 假证据路径，文档原样跑（不带 --strict）
sed 's|docs/verification/create-source/check.sh|docs/verification/create-source/does-not-exist.sh|' "$REG" > "$WORK/fake.md"
out="$(node "$CHK" "$WORK/fake.md" --root "$REPO" 2>&1)"; rc=$?
echo "== E3 证据文件不存在（硬告警，默认即失败）"
expect verdict "$(field "$out" verdict)" "FAIL"
expect rc "$rc" "1"
expect hard "$(printf '%s' "$out" | grep -c '引用的文件不存在')" "1"

# E4 同一份加 --strict（仍失败）
node "$CHK" "$WORK/fake.md" --root "$REPO" --strict >/dev/null 2>&1; rc=$?
echo "== E4 假证据路径 + --strict"
expect rc "$rc" "1"

# E5 没跑过的命令（指向不存在的脚本）也要红
sed 's|P9 变体（客户端地址改成 `api/other`）；命令 `node tests/sources-invariants.mjs`|P9 变体：命令 `bash tests/never-ran-this.sh`|' "$REG" > "$WORK/unrun.md"
out="$(node "$CHK" "$WORK/unrun.md" --root "$REPO" 2>&1)"; rc=$?
echo "== E5 没跑过的命令 + 退出码 0"
expect verdict "$(field "$out" verdict)" "FAIL"
expect rc "$rc" "1"

# E6 旧称「四项」清零，且 check-paths 绿
# pilot-findings 是历史记录，它的「四项」有说明段兜着（不算漂移）；这里只数会误导人的三处
refs="$(grep -c '四项要求\|可重跑四项\|S5 四项' "$SKILL"/SKILL.md "$SKILL"/references/stations.md "$SKILL"/templates/verification-record.md 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')"
out="$(cd "$SKILL" && node "$PATHS" 2>&1)"; rc=$?
echo "== E6 旧称清零 + 指路检查"
expect refs "$refs" "0"
expect paths_verdict "$(field "$out" verdict)" "OK"
expect rc "$rc" "0"

# E7 运行残留：2f49ffd 曾是 26+4，现在一个都不跟踪
st="$(git -C "$REPO" show --stat --name-only 2f49ffd 2>/dev/null | grep -c 'states/.*\.st$')"
tr="$(git -C "$REPO" show --stat --name-only 2f49ffd 2>/dev/null | grep -c '_TTrace_')"
tracked="$(git -C "$REPO" ls-files | grep -cE 'states/|_TTrace_')"
echo "== E7 运行残留（历史 26/4，现跟踪 0）"
expect historical_states "$st" "26"
expect historical_trace "$tr" "4"
expect tracked_now "$tracked" "0"

# E8 ASCII 规则已入档
hits="$(grep -rl '数字实体\|65288\|&#x' "$SKILL" --include=*.md 2>/dev/null | wc -l | tr -d ' ')"
echo "== E8 Mermaid 非 ASCII 的记载"
expect files "$hits" "1"

# E9 图对表：旧图红、修后绿、错顺序红
out="$(node "$V/check-chart.mjs" "$HERE/chart-fixed-before-fix.mmd" config,target,collector 2>&1)"; rc=$?
echo "== E9 旧 fixed 图（应 FAIL）"
expect verdict "$(field "$out" verdict)" "FAIL"
expect rc "$rc" "1"
out="$(node "$V/check-chart.mjs" "$V/chart-fixed.mmd" config,target,collector 2>&1)"; rc=$?
expect fixed_verdict "$(field "$out" verdict)" "OK"
expect fixed_rc "$rc" "0"

# E10 坏指路能被 check-paths 抓到（在副本上做，不动技能本体）
cp -R "$SKILL" "$WORK/skill"
python3 - "$WORK/skill/SKILL.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace("（见下「六条判据」）","（见下「七条判据」）")
io.open(p,'w',encoding='utf-8').write(s)
PY
out="$(node "$WORK/skill/scripts/check-paths.mjs" "$WORK/skill" 2>&1)"; rc=$?
echo "== E10 悬空指路（应 FAIL）"
expect verdict "$(field "$out" verdict)" "FAIL"
expect rc "$rc" "1"

echo "== 结论：$( [ "$bad" = "0" ] && echo '十条观测与预期一致' || echo '有观测与预期不符')"
[ "$bad" = "0" ] && exit 0 || exit 1
