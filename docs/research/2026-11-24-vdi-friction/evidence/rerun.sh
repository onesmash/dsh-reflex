#!/bin/bash
# 审计复跑：本次判断里所有「机器可核」的话，都从这里来。
#
# 退出码三态：0 = 八条观测与预期一致；1 = 至少一条对不上；2 = 未判定（找不到 node / jar / 文件）
# 用法：bash evidence/rerun.sh
#   VDI_SKILL 覆盖技能目录，NODE_BIN 覆盖 node 目录（默认值只是本机取值）。
# 注意：这里断言的是「观测到的缺陷行为」，不是「通过」——名字里不写 PASS，免得下一个人误读。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
SKILL="${VDI_SKILL:-$HOME/.agents/skills/verifying-design-invariants}"
PATH="${NODE_BIN:-/usr/local/bin}:$PATH"
REG="$REPO/docs/property-register-sources.md"
CHK="$SKILL/scripts/check-register.mjs"
PATHS="$SKILL/scripts/check-paths.mjs"

command -v node >/dev/null 2>&1 || { echo "未判定：找不到 node（设 NODE_BIN=<目录>）" >&2; exit 2; }
[ -f "$CHK" ] || { echo "未判定：找不到 $CHK（设 VDI_SKILL=<技能目录>）" >&2; exit 2; }
[ -f "$REG" ] || { echo "未判定：找不到 $REG" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vdi-audit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

bad=0
field() { # $1=json文本 $2=字段名 -> 打印值（rows/verdict 这类简单字段）
  printf '%s\n' "$1" | sed -n "s/^[[:space:]]*\"$2\":[[:space:]]*\(.*\),\{0,1\}$/\1/p" | head -1 | tr -d '"' | sed 's/,$//'
}

echo "== 环境"
echo "repo   = $REPO"
echo "skill  = $SKILL"
node --version

# E1 基线：全表
out="$(node "$CHK" "$REG" --root "$REPO" 2>&1)"; rc=$?
r1="$(field "$out" rows)"; v1="$(field "$out" verdict)"
echo "== E1 全表：rows=$r1 verdict=$v1 rc=${rc}（预期 19 / OK / 0）"
[ "$r1" = "19" ] && [ "$v1" = "OK" ] && [ "$rc" = "0" ] || { echo "  MISMATCH"; bad=1; }

# E2 表中间插一个空行：核对器还认吗
p10="$(grep -n '^| P10 ' "$REG" | cut -d: -f1)"
before="$(head -n "$((p10 - 1))" "$REG" | grep -c '^| P')"
awk 'BEGIN{d=0} /^\| P10 /{if(!d){print "";d=1}} {print}' "$REG" > "$WORK/blank.md"
out="$(node "$CHK" "$WORK/blank.md" --root "$REPO" 2>&1)"; rc=$?
r2="$(field "$out" rows)"; v2="$(field "$out" verdict)"; e2="$(printf '%s' "$out" | grep -c '"errors": \[\]')"
echo "== E2 表内空行：rows=${r2}（应读 ${before}）verdict=$v2 rc=$rc errors 为空=${e2}（预期 $before / OK / 0 / 1）"
[ "$r2" = "$before" ] && [ "$v2" = "OK" ] && [ "$rc" = "0" ] || { echo "  MISMATCH"; bad=1; }

# E3 引用一个不存在的证据文件，按文档原样跑（不带 --strict）
sed 's|docs/verification/create-source/check.sh|docs/verification/create-source/does-not-exist.sh|' "$REG" > "$WORK/fake.md"
out="$(node "$CHK" "$WORK/fake.md" --root "$REPO" 2>&1)"; rc=$?
v3="$(field "$out" verdict)"; w3="$(printf '%s' "$out" | grep -c '不存在')"
echo "== E3 假证据路径（文档命令）：verdict=$v3 rc=$rc 不存在告警数=${w3}（预期 OK / 0 / 1）"
[ "$v3" = "OK" ] && [ "$rc" = "0" ] && [ "$w3" -ge 1 ] || { echo "  MISMATCH"; bad=1; }

# E4 同一份文件加 --strict
node "$CHK" "$WORK/fake.md" --root "$REPO" --strict >/dev/null 2>&1; rc=$?
echo "== E4 假证据路径 + --strict：rc=${rc}（预期 1）"
[ "$rc" = "1" ] || { echo "  MISMATCH"; bad=1; }

# E5 破坏变体列写一条从没跑过的命令，退出码照抄 0
sed 's|P9 变体（客户端地址改成 `api/other`）；命令 `node tests/sources-invariants.mjs`|P9 变体：命令 `bash tests/never-ran-this.sh`|' "$REG" > "$WORK/unrun.md"
out="$(node "$CHK" "$WORK/unrun.md" --root "$REPO" 2>&1)"; rc=$?
v5="$(field "$out" verdict)"
echo "== E5 没跑过的命令 + 退出码 0：verdict=$v5 rc=${rc}（预期 OK / 0）"
[ "$v5" = "OK" ] && [ "$rc" = "0" ] || { echo "  MISMATCH"; bad=1; }

# E6 悬空小标题：文档里引「四项要求」，但那个标题已经改名叫「六条判据」
refs="$(grep -rc '四项要求\|可重跑四项' "$SKILL"/SKILL.md "$SKILL"/references/*.md "$SKILL"/templates/*.md 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')"
heads="$(grep -rh '^#\{1,6\}.*四项要求' "$SKILL" 2>/dev/null | wc -l | tr -d ' ')"
(cd "$SKILL" && node "$PATHS" >/dev/null 2>&1); rc=$?
echo "== E6 悬空小标题：旧称出现 $refs 次，标题叫「四项要求」的 $heads 个，check-paths rc=${rc}（预期 >0 / 0 / 0）"
[ "$refs" -ge 1 ] && [ "$heads" = "0" ] && [ "$rc" = "0" ] || { echo "  MISMATCH"; bad=1; }

# E7 运行残留进了版本库（toolchain.md 明说别进）
st="$(git -C "$REPO" show --stat --name-only 2f49ffd 2>/dev/null | grep -c 'states/.*\.st$')"
tr="$(git -C "$REPO" show --stat --name-only 2f49ffd 2>/dev/null | grep -c '_TTrace_')"
echo "== E7 2f49ffd 里的运行残留：states/*.st $st 个，TTrace $tr 个（预期 26 / 4）"
[ "$st" = "26" ] && [ "$tr" = "4" ] || { echo "  MISMATCH"; bad=1; }

# E8 「Mermaid 标签非 ASCII 会转成数字实体」这条限制，技能里有没有记载
hits="$(grep -rl '数字实体\|65288\|&#x' "$SKILL" --include=*.md 2>/dev/null | wc -l | tr -d ' ')"
echo "== E8 非 ASCII 标签的记录：${hits} 份 md 提到（预期 0）"
[ "$hits" = "0" ] || { echo "  MISMATCH"; bad=1; }

echo "== 结论：$( [ "$bad" = "0" ] && echo '八条观测与预期一致' || echo '有观测与预期不符')"
[ "$bad" = "0" ] && exit 0 || exit 1
