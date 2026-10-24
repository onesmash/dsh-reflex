#!/usr/bin/env bash
# reflex 端到端探针: 在*运行中*的 reflex 上验证 采集→事实→L1判定→L2唤醒 全链。
#
# 用法: bash reflex_e2e_probe.sh [--timeout 240]
# 依赖: 运行中的 DSH (dsh-reflex 插件活跃)。会在运行目录临时创建 e2e-probe 采集器+target,
#       结束(含异常退出)自动清理; 不重启、不改配置——走的是生产热发现链路。
#
# 判定: 探针源被发现 + facts 落盘 + L1[e2e-probe] 命中 + L2: woken → PASS。
# 退出码: 0 通过, 1 失败(附日志定位), 2 环境缺失。
#
# 设计要点(踩过的坑):
# - 探针 collector **持续**每轮发一条新事实(唯一 id), 直到看到判定才停。原因: 新 target
#   注册与首批事实存在同轮时序竞态 —— 第一批事实可能在 target 进入活跃集前就被 L1 消费,
#   之后无新事实 → target 永不触发(表现为"探针源在跑、target 静默")。
# - target 的 python 必须写临时文件再执行: `python3 - <<'PY'` 的 heredoc 会顶掉 stdin 事实流。
set -uo pipefail

LHOME="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"
LOG="$LHOME/dsh-reflex.log"
TIMEOUT=240
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="${2:-240}"; shift 2;;
    *) echo "用法: $0 [--timeout 240]" >&2; exit 2;;
  esac
done

[ -f "$LOG" ] || { echo "FAIL: 找不到 $LOG (reflex 未运行?)"; exit 2; }
[ -d "$LHOME/collectors" ] || { echo "FAIL: 找不到 $LHOME/collectors"; exit 2; }

TAG="e2e-probe"
C="$LHOME/collectors/$TAG.sh"
CE="$LHOME/collectors/$TAG.env.json"
T="$LHOME/targets/$TAG.sh"
TE="$LHOME/targets/$TAG.env.json"
STOP="$LHOME/$TAG.stop"
CNT="$LHOME/$TAG.cnt"
START_LINE=$(( $(wc -l < "$LOG") + 1 ))

cleanup() {
  touch "$STOP" 2>/dev/null || true          # 先让 collector 停发
  rm -f "$C" "$CE" "$T" "$TE" "$CNT" "$STOP"
  rm -rf "$LHOME/facts/$TAG"
  python3 - "$LHOME/cursor.json" <<'PY' 2>/dev/null || true
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception:
    sys.exit(0)
if any('e2e' in k for k in d):
    for k in [k for k in d if 'e2e' in k]:
        d.pop(k, None)
    json.dump(d, open(p, 'w'), ensure_ascii=False)
PY
  echo "[cleanup] 探针已拆除"
}
trap cleanup EXIT

echo "== reflex E2E 探针启动 (timeout=${TIMEOUT}s, home=$LHOME)"

# 1) 探针采集器: 每轮一条新事实, 直到底层写出 stop 文件或达上限
cat > "$C" <<'EOF'
#!/bin/bash
set -uo pipefail
LHOME="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"
[ -f "$LHOME/e2e-probe.stop" ] && exit 0
CNT="$LHOME/e2e-probe.cnt"
n=$(cat "$CNT" 2>/dev/null || echo 0)
[ "$n" -ge 40 ] && exit 0
n=$((n+1)); echo "$n" > "$CNT"
printf '{"metric":"probe","raw":{"id":"e2e-%s-%s","title":"REFLEX E2E 探针 #%s：采集→判定→唤醒 全链验证"}}\n' "$(date +%s)" "$n" "$n"
EOF
chmod +x "$C"
cat > "$CE" <<'EOF'
{"intervalMs": 3000, "timeoutMs": 10000}
EOF

# 2) 探针 target: python 写临时文件再跑 (heredoc 会吃掉 stdin 事实流)
cat > "$T" <<'EOF'
#!/bin/bash
set -uo pipefail
WORK="$(mktemp -d -t reflex-e2e)" || exit 1
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/decide.py" <<'PY'
import sys, json
items = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        f = json.loads(line)
    except Exception:
        continue
    if f.get("metric") != "probe":
        continue
    raw = f.get("raw") or {}
    items.append({"id": "e2e-probe:%s" % raw.get("id", "x"),
                  "title": raw.get("title", "E2E 探针"),
                  "body": "reflex 端到端探针事实（自动测试，已清理）"})
if items:
    print(json.dumps({"wake": True, "reason": "REFLEX E2E 探针命中",
                      "fingerprint": {"ids": [i["id"] for i in items]},
                      "scanned": len(items), "items": items}, ensure_ascii=False))
PY
python3 "$WORK/decide.py"
EOF
chmod +x "$T"
cat > "$TE" <<'EOF'
{"displayName": "E2E 探针", "sources": ["e2e-probe"], "minIntervalMs": 0, "interruptAlways": true, "timeoutMs": 15000}
EOF

# 3) 等链路: L1 判定 → L2 唤醒
FOUND_L1=""; FOUND_WAKE=""
DEADLINE=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 5
  SEG="$(tail -n +"$START_LINE" "$LOG" 2>/dev/null)"
  if [ -z "$FOUND_L1" ] && echo "$SEG" | grep -q "L1\[$TAG\].*E2E 探针命中"; then
    FOUND_L1=1
    echo "[chain] L1 判定: $(echo "$SEG" | grep "L1\[$TAG\]" | tail -1 | cut -c1-110)"
  fi
  if [ -n "$FOUND_L1" ] && echo "$SEG" | grep -q "L2: woken"; then
    FOUND_WAKE=1
    echo "[chain] L2 唤醒: $(echo "$SEG" | grep "L2: woken" | tail -1 | cut -c1-110)"
    break
  fi
done

echo ""
if [ -n "$FOUND_WAKE" ]; then
  echo "PASS: 采集→事实→L1 判定→L2 唤醒 全链通过"
  exit 0
elif [ -n "$FOUND_L1" ]; then
  echo "FAIL: L1 判定已发生, 但未观察到 L2 唤醒 (检查 quietHours/interruptAlways/冷却/投递失败)"
  exit 1
else
  echo "FAIL: ${TIMEOUT}s 内未观察到 L1[$TAG] 判定。排查:"
  echo "  1) 热发现是否捡起探针: grep 'discovery refreshed' $LOG | tail -1"
  echo "  2) 探针源是否在跑:      ls $LHOME/facts/$TAG/"
  echo "  3) target 注册:         grep -o 'script-targets=\[[^]]*\]' $LOG | tail -1"
  echo "  4) target 契约(heredoc/stdin): 见 DATASOURCE.md §6.1"
  exit 1
fi
