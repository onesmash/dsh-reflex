#!/bin/bash
# check-register 的破坏变体：每条新判据都要亲眼见它红。
set -u
export PATH="${NODE_BIN:-/usr/local/bin}:$PATH"
S="${VDI_SKILL:-$HOME/.agents/skills/verifying-design-invariants}"
R="${REG:-$HOME/SourceCode/dsh-reflex/docs/property-register-sources.md}"
ROOT="$(cd "$(dirname "$R")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/reg-neg.XXXXXX")"
trap 'rm -rf "$T"' EXIT

summarize() { # $1=label $2=jsonfile $3=rc
  python3 - "$1" "$2" "$3" <<'PY'
import json,sys
label,f,rc=sys.argv[1],sys.argv[2],sys.argv[3]
j=json.load(open(f))
hard=j.get("hard_warnings",[])
print("%-24s exit=%s verdict=%-6s errors=%d hard=%d warn=%d" % (
    label, rc, j.get("verdict"), len(j.get("errors",[])), len(hard), len(j.get("warnings",[]))))
if j.get("errors"): print("    E:", " | ".join(e[:70] for e in j["errors"][:3]))
if hard: print("    H:", " | ".join(e[:70] for e in hard[:2]))
PY
}

bad=0
run() { # $1=file $2=label $3=期望 verdict
  node "$S/scripts/check-register.mjs" "$1" --root "$ROOT" > "$T/out.json" 2>&1
  rc=$?
  summarize "$2" "$T/out.json" "$rc"
  got="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['verdict'])" "$T/out.json" 2>/dev/null || echo PARSE_FAIL)"
  if [ "$got" = "$3" ]; then echo "    ok ${2} => ${got}"; else echo "    MISMATCH ${2} => ${got}（期望 ${3}）"; bad=1; fi
}

cp "$R" "$T/ok.md";                                                     run "$T/ok.md" "T0 baseline" "OK"
awk 'BEGIN{d=0} /^\| P10 /{if(!d){print "";d=1}} {print}' "$R" > "$T/blank.md";  run "$T/blank.md" "T1 空行截断" "FAIL"
sed 's/^\(| P19 .*\)| L2 |/\1| L4 |/' "$R" > "$T/badgrade.md";          run "$T/badgrade.md" "T2 等级词汇" "FAIL"
python3 - "$R" "$T/nocover.md" <<'PY2'
import io,sys,re
s=io.open(sys.argv[1],encoding='utf-8').read()
s2=re.sub(r'不建模：数据形状问题，由纯函数守门测试覆盖', '不建模：数据形状问题', s, count=1)
assert s2!=s, "mutation not applied"
io.open(sys.argv[2],'w',encoding='utf-8').write(s2)
PY2
run "$T/nocover.md" "T3 不建模无覆盖" "FAIL"
sed 's|docs/verification/create-source/check.sh|docs/verification/create-source/nope.sh|' "$R" > "$T/nopath.md"; run "$T/nopath.md" "T4 证据文件不存在" "FAIL"

echo "== 结论：$( [ "$bad" = "0" ] && echo '四条破坏变体都按预期报红' || echo '有不符合预期' )"
[ "$bad" = "0" ] && exit 0 || exit 1
