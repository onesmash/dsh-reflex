#!/bin/bash
# new-source.sh — 生成一套 reflex 数据源骨架（采集器 + target + 配置 + schema）
#
# 为什么需要它
#   新增一个「带语义判定的数据源」要写 5 个文件，且要避开 3 个未文档化的契约坑
#   （heredoc 顶 stdin / stdout 单行协议 / 就地重写被读半截）。
#   这份脚手架把三个坑的防法直接写进模板，并接好影子与校准链路。
#
# 用法
#   bash tools/new-source.sh <name> [--no-target] [--force]
#   name 只允许小写字母、数字、连字符（会成为文件名与 target tag）
#
# 产出（默认全部生成）
#   collectors/<name>.sh         采集器（stdout 每行一个 JSON fact）
#   collectors/<name>.env.json   采集间隔与超时
#   collectors/<name>.schema.json 字段说明（让 L2 看得懂）
#   targets/<name>.sh            判定入口（确定性层 + 语义影子）
#   targets/<name>.env.json      target 配置（sources 必须声明，否则空跑）
#
# 生成后必做
#   1. bash -n 两个 .sh
#   2. 单独跑采集器看是否输出合法 JSON 行
#   3. 用假 facts 跑 target 的正例与【反例】
#   4. 看日志出现 discovery refreshed: sources=[... <name> ...]（热发现，无需重启）
#
# 三个坑的防法（模板已内置，改模板时不要删）
#   坑1 heredoc 顶掉 stdin  -> 管道内容先落临时文件再交给 python
#   坑2 stdout 是单行协议  -> 决策 JSON 只打一行；调试信息一律 >&2
#   坑3 就地重写被读半截  -> 改运行中的脚本用 tmp + mv 原子替换

set -uo pipefail

RH="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"

NAME=""; WANT_TARGET=1; FORCE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-target) WANT_TARGET=0; shift ;;
    --force)     FORCE=1; shift ;;
    -h|--help)   sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          printf '[new-source] 未知参数: %s\n' "$1" >&2; exit 2 ;;
    *)           NAME="$1"; shift ;;
  esac
done

[ -z "$NAME" ] && { printf '[new-source] 用法: %s <name> [--no-target] [--force]\n' "$0" >&2; exit 2; }
case "$NAME" in
  *[!a-z0-9-]*) printf '[new-source] name 只允许小写字母、数字、连字符: %s\n' "$NAME" >&2; exit 2 ;;
esac

COLL="$RH/collectors/$NAME.sh"
COLL_ENV="$RH/collectors/$NAME.env.json"
COLL_SCHEMA="$RH/collectors/$NAME.schema.json"
TGT="$RH/targets/$NAME.sh"
TGT_ENV="$RH/targets/$NAME.env.json"

if [ "$FORCE" != "1" ]; then
  for f in "$COLL" "$COLL_ENV" "$COLL_SCHEMA" "$TGT" "$TGT_ENV"; do
    [ -e "$f" ] && { printf '[new-source] 已存在（要覆盖加 --force）: %s\n' "$f" >&2; exit 1; }
  done
fi

mkdir -p "$RH/collectors" "$RH/targets"

# 原子写：先写 .tmp 再 mv
put() {
  local path="$1" tmp="${1}.tmp.$$"
  cat > "$tmp" && chmod 755 "$tmp" && mv "$tmp" "$path"
}

# ---------- collectors/<name>.sh ----------
put "$COLL" <<EOF
#!/bin/bash
# 数据源: $NAME — TODO 一句话说明采集什么
#
# 契约
#   stdout 每行一个 JSON fact：{"metric","raw","meta"}；source/ts 由插件补。
#   退出 0 + 空输出 = 本轮无新数据（正常）；退出非 0 = 记 L0 $NAME failed（不要用空输出伪装失败）。
#   必须幂等：同一份数据重复采集不能重复产出。
#
# ⚠️ 三个坑（改本文件时不要破坏）
#   1. 需要 python 处理管道内容时，不要写 \`cmd | python3 - <<'PY'\` ——
#      heredoc 会顶掉管道 stdin，python 一条都读不到，而且不报错。
#      正确做法：先落临时文件，再把路径当参数传给 python。
#   2. 调试输出一律 >&2，不要 print 到 stdout（stdout 是 JSONL 协议）。
#   3. 本文件可能正在被插件执行；改它请写 .tmp 再 mv，不要就地重写。

set -uo pipefail

RH="\${REFLEX_HOME:-\$HOME/.dsh/dsh-reflex}"
STATE="\$RH/seen-$NAME.json"          # 去重水位
mkdir -p "\$RH" 2>/dev/null || true

# ---------- 采集（TODO 替换成你的数据源） ----------
RAW_DATA="\$(TODO-your-command 2>/dev/null || true)"
if [ -z "\$RAW_DATA" ]; then
  printf '[%s] 数据通道为空或失败\n' "$NAME" >&2
  exit 1        # 通道失败要显式记 failed
fi

WORK="\$(mktemp -d "\${TMPDIR:-/tmp}/$NAME-collect.XXXXXX")"
trap 'rm -rf "\$WORK"' EXIT INT TERM
printf '%s\n' "\$RAW_DATA" > "\$WORK/raw.txt"     # 见坑1：落文件再交给 python

python3 - "\$WORK/raw.txt" "\$STATE" <<'PY'
import json, os, sys

raw_path, state_path = sys.argv[1], sys.argv[2]

def load_state():
    try:
        with open(state_path) as f:
            return json.load(f)
    except Exception:
        return {"v": 1, "seeded": False, "known": []}

def save_state(s):
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, ensure_ascii=False)
    os.replace(tmp, state_path)      # 原子替换

state = load_state()
known = set(state.get("known", []))
items = []
with open(raw_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        items.append(line)           # TODO 解析成结构化条目

# 首跑只建水位，不倒历史（避免一上来刷屏）
if not state.get("seeded"):
    for it in items:
        known.add(it)
    state["seeded"] = True
    state["known"] = sorted(known)
    save_state(state)
    print(json.dumps({"metric": "$NAME-scan", "raw": {"ok": True, "seeded": True, "total": len(items)}},
                     ensure_ascii=False))
    sys.exit(0)

new_items = [it for it in items if it not in known]
for it in new_items:
    known.add(it)
    print(json.dumps({"metric": "$NAME-item", "raw": {"key": it, "value": it}}, ensure_ascii=False))

state["known"] = sorted(known)
save_state(state)
print(json.dumps({"metric": "$NAME-scan", "raw": {"ok": True, "new": len(new_items)}}, ensure_ascii=False))
PY
EOF

# ---------- 采集器 env ----------
put "$COLL_ENV" <<EOF
{
  "intervalMs": 1800000,
  "timeoutMs": 120000,
  "env": {}
}
EOF

# ---------- 采集器 schema ----------
put "$COLL_SCHEMA" <<EOF
{
  "metric": "$NAME-scan / $NAME-item",
  "fields": {
    "ok": "本轮采集是否成功",
    "seeded": "首跑水位标记（true=只建基线不发事实）",
    "total": "本轮扫描到的条目总数",
    "new": "本轮新增条目数",
    "key": "条目唯一键（去重与 target 判定依据）",
    "value": "条目内容"
  },
  "notes": "TODO 说明数据来源、去重口径、失败条件。采集间隔 30 分钟；首跑只建水位。"
}
EOF

# ---------- target ----------
if [ "$WANT_TARGET" = "1" ]; then
put "$TGT" <<EOF
#!/bin/bash
# target: $NAME — TODO 一句话说明判定什么
#
# 契约
#   stdin 收本轮该源的新事实（JSONL）→ stdout 恰好一行决策 JSON；不唤醒 = 空输出。
#   决策形状：{"wake":true,"reason":"...","fingerprint":{"ids":[...]},"scanned":N,
#             "items":[{"id":"...","title":"...","body":"..."}]}
#   items[].id 必须有（跨轮合并去重的唯一依据）。
#
# 两层判定
#   [确定性] 规则命中即唤醒 —— 快、可解释、不花钱
#   [语义影子] SemIf/jev 逐条打分，只记账不唤醒 —— 攒样本后拟合阈值再转正
#              分数由 options.description 驱动（不是 question），改描述等于改判据
#
# ⚠️ 三个坑（改本文件时不要破坏）
#   1. stdin 必须先落临时文件 —— \`python3 - <<'PY'\` 会顶掉 stdin，读不到事实且不报错
#   2. stdout 只允许一行决策 JSON —— 任何 print 都会破坏协议，调试信息一律 >&2
#   3. 本文件可能正在被插件执行；改它请写 .tmp 再 mv

set -uo pipefail

RH="\${REFLEX_HOME:-\$HOME/.dsh/dsh-reflex}"
WORK="\$(mktemp -d "\${TMPDIR:-/tmp}/$NAME-target.XXXXXX")"
trap 'rm -rf "\$WORK"' EXIT INT TERM

cat > "\$WORK/facts.jsonl"        # 见坑1

# ---------- 第一层：确定性规则 ----------
python3 - "\$WORK/facts.jsonl" "\$WORK/decision.json" "\$WORK/rows.jsonl" <<'PY'
import json, sys

facts_path, decision_path, rows_path = sys.argv[1], sys.argv[2], sys.argv[3]

msgs, scanned = [], 0
with open(facts_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        scanned += 1
        if rec.get("metric") != "$NAME-item":
            continue
        raw = rec.get("raw") or {}
        msgs.append((str(raw.get("key", "")), raw.get("value", "")))

items = []
for key, value in msgs:
    # TODO 换成真正的判定规则；下面是形状示例
    if TODO-CONDITION:
        items.append({
            "id": f"$NAME-{key}",
            "title": f"$NAME 命中 · {key}",
            "body": f"{value}\n→ TODO 说明该做什么",
        })

if items:
    with open(decision_path, "w") as f:
        json.dump({"wake": True,
                   "reason": f"$NAME 命中 {len(items)} 条",
                   "fingerprint": {"ids": [i["id"] for i in items]},
                   "scanned": scanned,
                   "items": items}, f, ensure_ascii=False)

# ---------- 第二层：语义影子候选 ----------
# 判据写进 description；改措辞分数会整体位移，阈值必须重拟合。
QUESTION = "TODO 这条内容是否值得打断读者？"
SHADOW_YES = ("TODO 明确写出：满足哪些条件算 yes。"
              "写完拿真实历史样本回放校验，不要拍脑袋。")
SHADOW_NO  = ("TODO 明确写出：哪些情况算 no（含容易误判的边界情形）。")

with open(rows_path, "w") as f:
    for key, value in msgs[-20:]:
        f.write(json.dumps({
            "id": f"$NAME-shadow-{key}",
            "state": f"{value}",
            "question": QUESTION,
            "options": [{"id": "yes", "description": SHADOW_YES},
                        {"id": "no",  "description": SHADOW_NO}],
            "createdMs": key,
        }, ensure_ascii=False) + "\n")
PY

# ---------- 影子打分（交给 shadow-semif.sh 内置记录） ----------
# 不要自己写影子文件：wrapper 已把全量分落到 \$REFLEX_HOME/shadow/<tag>-<date>.jsonl
# 手动跑之前先 eval "\$(bash tools/semif-env.sh --target $NAME)"，否则会静默回退本地后端
SEMIF="\${REFLEX_SEMIF_RUN:-}"
if [ -n "\$SEMIF" ] && [ -f "\$SEMIF" ] && [ -s "\$WORK/rows.jsonl" ]; then
  bash "\$SEMIF" --input "\$WORK/rows.jsonl" --output "\$WORK/scores.jsonl" \\
    > /dev/null 2> "\$WORK/semif.err" || true
  [ -s "\$WORK/semif.err" ] && printf '[%s] 影子打分告警: %s\n' "$NAME" "\$(tail -1 "\$WORK/semif.err")" >&2
fi

# ---------- 输出决策（stdout 唯一一行） ----------
[ -s "\$WORK/decision.json" ] && { cat "\$WORK/decision.json"; echo; }
exit 0
EOF

put "$TGT_ENV" <<EOF
{
  "displayName": "$NAME",
  "sources": [
    "$NAME"
  ],
  "minIntervalMs": 1800000,
  "timeoutMs": 120000,
  "env": {}
}
EOF
fi

# ---------- 自检 ----------
printf '\n[new-source] 已生成：\n'
for f in "$COLL" "$COLL_ENV" "$COLL_SCHEMA"; do printf '  %s\n' "$f"; done
[ "$WANT_TARGET" = "1" ] && for f in "$TGT" "$TGT_ENV"; do printf '  %s\n' "$f"; done

printf '\n[new-source] 语法检查：\n'
bash -n "$COLL" && printf '  ✅ collectors/%s.sh\n' "$NAME"
[ "$WANT_TARGET" = "1" ] && bash -n "$TGT" && printf '  ✅ targets/%s.sh\n' "$NAME"

cat <<TIPS

[new-source] 接下来照这个顺序做完（缺一步就别上线）：
  1. 改 TODO：采集命令、判定规则、yes/no 判据描述
  2. 单独跑采集器，确认输出是合法 JSON 行且幂等（连跑三次，第二次只出真正新增）
  3. 造正例和【反例】facts 喂 target；反例必须输出为空，否则会乱叫
  4. 等一个采集周期，确认日志出现 discovery refreshed 里有 ${NAME}（热发现，不用重启）
  5. 手动跑影子前先：eval "\$(bash \$HOME/.dsh/dsh-reflex/tools/semif-env.sh --target $NAME)"
  6. 攒够样本后校准：shadow_replay.py --target $NAME && calibration.py

TIPS
