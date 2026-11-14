#!/bin/bash
# semif-env.sh — 手动运行时获得与插件注入【等价】的完整环境
#
# 为什么需要它
#   插件的 scriptEnv()（index.js:709-744）只在 profile 显式配了 l1.backend 时才注入
#   REFLEX_DECIDE_BACKEND / REFLEX_JEV_* 全套。手动敲命令时少了任何一个，
#   shadow-semif.sh 会静默回退到本地 run_score.sh（Intel Mac 必败），
#   而失败被 `|| true` 吞掉，表现为「影子文件没落盘」而不是报错。
#   这个脚本把那份注入原样复现一遍，让「手动跑 = 插件跑」。
#
# 用法
#   eval "$(tools/semif-env.sh)"                       # 注入当前 shell
#   eval "$(tools/semif-env.sh --target mytarget)"     # 顺带设 REFLEX_TARGET
#   tools/semif-env.sh --check                         # 只体检，不输出 export
#   tools/semif-env.sh --quiet                         # 省掉 stderr 提示
#   tools/semif-env.sh --profile <name>                # 多 profile 时指定
#
# 密钥：从 $DSH_HOME/.credentials.yaml 的 refs 段读，只用不打印。
#
# 输出：stdout 只放 export 行（供 eval）；提示一律走 stderr。

set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REFLEX_HOME="${REFLEX_HOME:-$DSH_HOME/dsh-reflex}"
TARGET=""
CHECK_ONLY=0
QUIET=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --check)  CHECK_ONLY=1; shift ;;
    --quiet)  QUIET=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '[semif-env] 未知参数: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# profile 自动探测：找唯一一个配了 dsh-reflex 段的 profile；可用 --profile 或
# REFLEX_PROFILE_NAME 覆盖。写死某个 profile 名会让这份工具只在一台机器上成立。
PROFILE="${REFLEX_PROFILE_NAME:-}"
pick_profile() {
  local found="" n=0 f
  for f in "$DSH_HOME"/profiles/*/cordis.patch.yml; do
    [ -f "$f" ] || continue
    grep -q "id: dsh-reflex\|name: dsh-reflex" "$f" 2>/dev/null || continue
    found="$f"; n=$((n + 1))
  done
  [ "$n" -eq 1 ] && { printf '%s' "$found"; return 0; }
  [ "$n" -gt 1 ] && { printf '[semif-env] 多个 profile 都配了 dsh-reflex，用 --profile <name> 指定：\n' >&2
                      for f in "$DSH_HOME"/profiles/*/cordis.patch.yml; do
                        grep -q "id: dsh-reflex" "$f" 2>/dev/null && printf '  %s\n' "$(basename "$(dirname "$f")")" >&2
                      done; return 1; }
  return 1
}
if [ -n "$PROFILE" ]; then
  PROFILE_YML="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
else
  PROFILE_YML="$(pick_profile)" || { printf '[semif-env] 没找到配了 dsh-reflex 的 profile；用 --profile <name> 指定\n' >&2; exit 1; }
  PROFILE="$(basename "$(dirname "$PROFILE_YML")")"
fi
CREDS="$DSH_HOME/.credentials.yaml"
TUNING_DIR="${REFLEX_TUNING_DIR:-$HOME/.agents/skills/reflex-tuning/scripts}"
SEMIF_DIR="${REFLEX_SEMIF_DIR:-$HOME/.agents/skills/semif-decide/scripts}"
# jev-score.mjs 解析：环境变量 > 插件安装目录（profile 的 node_modules，可能是 link: 指向源码仓）
resolve_jev_score() {
  [ -n "${REFLEX_JEV_SCORE:-}" ] && { printf '%s' "$REFLEX_JEV_SCORE"; return; }
  local cand
  for cand in \
    "$DSH_HOME/profiles/$PROFILE/node_modules/dsh-reflex/jev-score.mjs" \
    "$HOME/SourceCode/dsh-reflex/jev-score.mjs"; do
    [ -f "$cand" ] && { printf '%s' "$cand"; return; }
  done
  printf '%s' ""   # 找不到就留空，体检会报出来
}
JEV_SCORE="$(resolve_jev_score)"


note() { [ "$QUIET" = "1" ] || printf '[semif-env] %s\n' "$*" >&2; }
fail() { printf '[semif-env] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$PROFILE_YML" ] || fail "profile 配置不存在: $PROFILE_YML"

# ---------- 从 profile 读 backend 与 jev 三项 ----------
PARSED=$(python3 - "$PROFILE_YML" <<'PY'
import sys, yaml, json
try:
    doc = yaml.safe_load(open(sys.argv[1]))
except Exception as e:
    print(json.dumps({"error": f"yaml 解析失败: {e}"}))
    sys.exit(0)

def find_reflex(node):
    if isinstance(node, list):
        for it in node:
            r = find_reflex(it)
            if r: return r
    elif isinstance(node, dict):
        if node.get("id") == "dsh-reflex" or node.get("name") == "dsh-reflex":
            return node
        for v in node.values():
            r = find_reflex(v)
            if r: return r
    return None

sec = find_reflex(doc) or {}
cfg = sec.get("config") or {}
l1 = cfg.get("l1") or {}
print(json.dumps({
    "backend": (cfg.get("backend") or "").strip(),
    "jevBaseUrl": (cfg.get("jevBaseUrl") or "").strip(),
    "jevModel": (cfg.get("jevModel") or "").strip(),
    "semifResident": l1.get("semifResident"),
}))
PY
)

BACKEND=$(printf '%s' "$PARSED" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error','') and '' or d.get('backend',''))")
PARSED_ERR=$(printf '%s' "$PARSED" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',''))")
[ -n "$PARSED_ERR" ] && fail "$PARSED_ERR"
[ -z "$BACKEND" ] && note "profile 未配 backend —— 手动跑会走本地 semif 后端（本机 Intel Mac 不可用）；如要走 jev 请在 profile 里设 backend: jev"

# ---------- 组装 export 行 ----------
emit() { printf 'export %s=%q\n' "$1" "$2"; }

ENV_LINES=""
add() { ENV_LINES="${ENV_LINES}$(emit "$1" "$2")"$'\n'; }

add REFLEX_HOME "$REFLEX_HOME"
add REFLEX_SEMIF_RUN "$TUNING_DIR/shadow-semif.sh"
add REFLEX_SHADOW_REAL "$SEMIF_DIR/run_score.sh"
add REFLEX_TUNING_DIR "$TUNING_DIR"
[ -n "$TARGET" ] && add REFLEX_TARGET "$TARGET"

RESIDENT=$(printf '%s' "$PARSED" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('semifResident'); print('0' if v is False else '1')")
add REFLEX_SEMIF_RESIDENT "$RESIDENT"

if [ "$BACKEND" = "jev" ] || [ "$BACKEND" = "jevlocal" ]; then
  add REFLEX_DECIDE_BACKEND "$BACKEND"
  add REFLEX_JEV_BASE_URL "$(printf '%s' "$PARSED" | python3 -c "import json,sys; print(json.load(sys.stdin).get('jevBaseUrl',''))")"
  add REFLEX_JEV_MODEL "$(printf '%s' "$PARSED" | python3 -c "import json,sys; print(json.load(sys.stdin).get('jevModel',''))")"
  add REFLEX_JEV_SCORE "$JEV_SCORE"

  # 密钥：从凭据 refs 段读，绝不打印
  KEY=$(python3 - "$CREDS" <<'PY'
import sys, os, json
try:
    import yaml
    doc = yaml.safe_load(open(sys.argv[1])) or {}
except Exception:
    sys.exit(0)
refs = doc.get("refs") or {}
for name in ("JEV_API_KEY", "REFLEX_JEV_API_KEY", "TYPESAFE_API_KEY"):
    v = refs.get(name)
    if isinstance(v, str) and v.strip():
        print(v.strip()); break
PY
)
  if [ -n "$KEY" ]; then
    add REFLEX_JEV_API_KEY "$KEY"
    note "密钥已注入（来自 $CREDS 的 refs 段，未回显）"
  else
    note "⚠️ 凭据里没有 JEV_API_KEY —— jev 打分必然 401；把 key 写进 refs 段"
  fi
elif [ -n "$BACKEND" ]; then
  add REFLEX_DECIDE_BACKEND "$BACKEND"
fi

# ---------- 体检 ----------
CHECK_FAIL=0
chk() {
  local name="$1" path="$2"
  if [ -e "$path" ]; then note "✅ $name"; else note "❌ $name 缺失: $path"; CHECK_FAIL=1; fi
}
[ "$CHECK_ONLY" = "1" ] && {
  note "--- 体检 ---"
  chk "shadow-semif.sh" "$TUNING_DIR/shadow-semif.sh"
  chk "run_score.sh" "$SEMIF_DIR/run_score.sh"
  [ "$BACKEND" = "jev" ] && chk "jev-score.mjs" "$JEV_SCORE"
  command -v node >/dev/null 2>&1 && note "✅ node $(node -v)" || { note "❌ node 不在 PATH"; CHECK_FAIL=1; }
  note "backend = ${BACKEND:-（未配）}"
  [ "$CHECK_FAIL" = "0" ] && note "体检通过" || note "体检有问题"
  exit "$CHECK_FAIL"
}

printf '%s' "$ENV_LINES"
note "已生成 export（backend=${BACKEND:-未配}）。用 eval \"\$(bash $0)\" 注入当前 shell。"
exit 0
