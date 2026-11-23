// 数据源目录的纯函数层：扫、暂停、恢复。
//
// 为什么单独成文件：这三个动作是「开关」的全部语义，但它们原先埋在 index.js 的闭包里，
// 只能通过跑整个插件来观察。抽出来后可以被测试直接调用，破坏变体也能被机器跑出来
// （见 tests/sources-invariants.mjs）。index.js 只负责把它们接到路由与扫描上。
//
// 硬约束（每条都有测试守着，见 sources.test.mjs）：
//   - 枚举以 <name>.sh 为准：.env.json / .schema.json 都可缺（真实世界里的 tidemark 就是没 env.json）
//   - paused 的唯一真相是 <name>.paused 文件，不读内存、不读 manifest
//   - 内置源（disk/cpu）不可开关，它们由 profile 的 l0.sources 门控
//   - 名字必须落在目录内：挡住 ../、a/b 这类越界写法
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 内置源名：与 index.js 的 BUILTIN_SOURCES 必须一致（测试会拿它们验拒绝）。 */
export const BUILTIN_SOURCES = Object.freeze(['disk', 'cpu'])

/** 宿主注册的 exact Fetch 路由（必须带前导斜杠，否则 assertFetchRoute 拒绝）。 */
export const SOURCE_ROUTE = '/api/reflex'
/** 浏览器侧的相对地址：与 SOURCE_ROUTE 必须是同一个端点，只差前导斜杠。 */
export const SOURCE_ROUTE_CLIENT = SOURCE_ROUTE.replace(/^\//, '')

/** 合法源名：小写字母数字开头，其余允许 . _ -；不允许斜杠与点开头。 */
const NAME = /^[a-z0-9][a-z0-9._-]*$/

/**
 * 扫一个 collectors 目录。
 * @param {string} dir
 * @returns {Array<{name:string, paused:boolean, intervalMs:number|null, hasEnv:boolean, metric:string|null}>}
 */
export function scanSources(dir) {
  if (!existsSync(dir)) return []
  let entries
  try { entries = readdirSync(dir) } catch { return [] }
  const names = entries.filter((f) => f.endsWith('.sh')).map((f) => f.slice(0, -3)).sort()
  return names.map((name) => {
    let intervalMs = null
    let hasEnv = false
    const envFile = join(dir, `${name}.env.json`)
    if (existsSync(envFile)) {
      hasEnv = true
      try {
        const cfg = JSON.parse(readFileSync(envFile, 'utf8'))
        if (Number.isFinite(cfg?.intervalMs)) intervalMs = cfg.intervalMs
      } catch { /* 坏 env.json 不该让整张表塌掉 */ }
    }
    let metric = null
    const schemaFile = join(dir, `${name}.schema.json`)
    if (existsSync(schemaFile)) {
      try { metric = JSON.parse(readFileSync(schemaFile, 'utf8'))?.metric ?? null } catch {}
    }
    return { name, paused: existsSync(join(dir, `${name}.paused`)), intervalMs, hasEnv, metric }
  })
}

/**
 * 暂停或恢复一个脚本源。幂等：重复调用不会抖。
 * @param {string} dir collectors 目录
 * @param {string} name 源名（必须已存在对应 .sh）
 * @param {boolean} paused true=写 .paused，false=删 .paused
 * @returns {{name:string, paused:boolean}}
 */
export function setPaused(dir, name, paused, options = {}) {
  const builtins = Array.isArray(options.builtins) ? options.builtins : BUILTIN_SOURCES
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`invalid name: ${JSON.stringify(name)}`)
  }
  if (builtins.includes(name)) {
    throw new Error(`内置源不可开关（由 profile 的 l0.sources 门控）: ${name}`)
  }
  if (!existsSync(join(dir, `${name}.sh`))) {
    throw new Error(`invalid name: 没有 ${name}.sh`)
  }
  const marker = join(dir, `${name}.paused`)
  if (paused) writeFileSync(marker, '')
  else rmSync(marker, { force: true })
  return { name, paused }
}

/**
 * 把一次面板请求翻成动作。纯逻辑：IO 全部由调用方注入，便于测试与破坏变体。
 * @param {string} op 'list' | 'pause' | 'resume' | 'create' | 'probe'
 * @param {object} body 面板请求体（含 name / 三段式字段）
 * @param {object} io { list(), commit(name,paused), refresh(), log(msg), create(body), probe(body) }
 * @returns {{ok:boolean, error?:string}|Promise<{ok:boolean}>} probe 恒返回 Promise（见下）
 */
export function respondToOp(op, body, io) {
  const list = io?.list ?? (() => ({ sources: [], builtin: [] }))
  if (op === 'list') return { ok: true, ...list() }
  if (op === 'pause' || op === 'resume') {
    const name = String(body?.name ?? '')
    io.commit(name, op === 'pause')
    io.refresh?.()          // 标记落盘后立刻重扫，界面不必等下一个 tick
    io.log?.(`sources: ${op} ${name}`)
    return { ok: true, ...list() }
  }
  if (op === 'create') {
    const created = io.create?.(body) ?? {}
    io.refresh?.()          // 新脚本落盘后立刻重扫：热发现，不用改 profile、不用重启
    io.log?.(`sources: create ${body?.name ?? '?'}`)
    return { ok: true, ...created, ...list() }
  }
  // 试跑要起子进程。宿主是单事件循环，跑同步版会把采集节拍整个卡住，
  // 所以 io.probe 返回 Promise，这里也【恒】返回 Promise —— 调用方 await 一次即可。
  if (op === 'probe') {
    return Promise.resolve(io.probe?.(body) ?? {}).then((result) => ({ ok: true, ...result }))
  }
  return { ok: false, error: `unknown op: ${op || '(empty)'}` }
}

// ===========================================================================
// 新增数据源：三段式（give / when / trigger）
//
// 为什么放在这一层：加一个源过去要写 5 个文件、避开 3 个契约坑（heredoc 顶 stdin /
// stdout 单行协议 / 就地重写被读半截）。界面上的三段式把这件事压成三句话，
// 但生成物必须能被机器验，所以这里只做校验与字符串渲染；
// 真执行（跑命令、bash -n、起进程、超时）由调用方注入。
//
// 三段式口径（与界面上的三段一一对应）
//   give    = 采集命令：它的 stdout 每行一个 JSON 对象，就是数据
//   when    = intervalMs：多久跑一次
//   trigger = 判定方式：all / match / semantic / off，决定要不要生成 targets/<name>.sh
// ===========================================================================

/** 三段式的边界值：越界一律拒绝，不做"帮用户兜一下"的猜测。 */
export const NEW_SOURCE_LIMITS = Object.freeze({
  cmdMax: 4000,
  aboutMax: 200,
  keywordMax: 20,
  keywordLenMax: 60,
  criteriaMax: 300,
  intervalMinMs: 10_000,
  intervalMaxMs: 7 * 24 * 3600_000,
  intervalDefaultMs: 900_000,
})

/** 采集命令自己那条汇总行的固定后缀：target 据此把它排除，不当数据。 */
export const SCAN_METRIC_SUFFIX = '-scan'

const TRIGGER_MODES = Object.freeze(['all', 'match', 'semantic', 'off'])

/** 压成一行：字段里塞换行会把生成脚本/JSON 弄坏，入口处就抹平。 */
function oneLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 校验并归一化一次「新增数据源」请求。
 * @param {object} body 面板请求体
 * @param {object} options { collectorsDir?, builtins? } —— 给了目录就顺手查重名
 * @returns {{name:string, about:string, cmd:string, intervalMs:number, trigger:object}}
 */
export function parseNewSource(body, options = {}) {
  const builtins = Array.isArray(options.builtins) ? options.builtins : BUILTIN_SOURCES
  const collectorsDir = options.collectorsDir
  const name = String(body?.name ?? '').trim()
  if (!NAME.test(name)) {
    throw new Error(`名称不合法：${JSON.stringify(name)} —— 只允许小写字母/数字开头，其余可用 . _ -`)
  }
  if (builtins.includes(name)) throw new Error(`内置源名不可用：${name}（内置源由 profile 的 l0.sources 门控）`)
  if (collectorsDir && existsSync(join(collectorsDir, `${name}.sh`))) {
    throw new Error(`已存在：collectors/${name}.sh（不覆盖已有数据源）`)
  }
  const cmd = String(body?.cmd ?? '').replace(/\r\n/g, '\n').trim()
  if (!cmd) throw new Error('采集命令不能为空')
  if (cmd.length > NEW_SOURCE_LIMITS.cmdMax) {
    throw new Error(`采集命令太长：${cmd.length} 字符（上限 ${NEW_SOURCE_LIMITS.cmdMax}）`)
  }
  const about = oneLine(body?.about).slice(0, NEW_SOURCE_LIMITS.aboutMax)
  const rawInterval = body?.intervalMs
  const intervalMs = Number(rawInterval ?? NEW_SOURCE_LIMITS.intervalDefaultMs)
  if (!Number.isInteger(intervalMs)
    || intervalMs < NEW_SOURCE_LIMITS.intervalMinMs
    || intervalMs > NEW_SOURCE_LIMITS.intervalMaxMs) {
    throw new Error(`采集间隔不合法：${rawInterval}（${NEW_SOURCE_LIMITS.intervalMinMs / 1000}s ~ ${NEW_SOURCE_LIMITS.intervalMaxMs / 1000}s）`)
  }
  return { name, about, cmd, intervalMs, trigger: parseTrigger(body?.trigger) }
}

function parseTrigger(raw) {
  const mode = String(raw?.mode ?? 'all')
  if (!TRIGGER_MODES.includes(mode)) throw new Error(`未知的触发方式：trigger.mode=${mode}`)
  if (mode === 'match') {
    const keywords = (Array.isArray(raw?.keywords) ? raw.keywords : [])
      .map(oneLine)
      .filter(Boolean)
    if (!keywords.length) throw new Error('触发方式「关键词」至少需要一个关键词')
    if (keywords.length > NEW_SOURCE_LIMITS.keywordMax) {
      throw new Error(`关键词太多：${keywords.length} 个（上限 ${NEW_SOURCE_LIMITS.keywordMax}）`)
    }
    for (const k of keywords) {
      if (k.length > NEW_SOURCE_LIMITS.keywordLenMax) {
        throw new Error(`关键词太长：${k.length} 字符（上限 ${NEW_SOURCE_LIMITS.keywordLenMax}）`)
      }
    }
    return { mode, keywords }
  }
  if (mode === 'semantic') {
    const criteria = oneLine(raw?.criteria)
    if (!criteria) throw new Error('触发方式「语义判据」需要一句判据')
    if (criteria.length > NEW_SOURCE_LIMITS.criteriaMax) {
      throw new Error(`判据太长：${criteria.length} 字符（上限 ${NEW_SOURCE_LIMITS.criteriaMax}）`)
    }
    return { mode, criteria }
  }
  return { mode }
}

/** 把 JSON 值渲成可嵌进 Python 的源码（JSON 数组字面量同时是合法的 Python 字面量）。 */
const pyLiteral = (value) => JSON.stringify(value)

/**
 * give 段：采集器。用户命令原样嵌入一个 { … } 块里（不缩进，否则会顶坏命令自带的 heredoc），
 * 外面这一层负责三件事：水位去重、首跑建水位、失败显式退出。
 */
export function renderCollector(spec) {
  const scan = spec.name + SCAN_METRIC_SUFFIX
  const triggerLine = spec.trigger.mode === 'off'
    ? '（只采集：不进 L1 判定）'
    : `targets/${spec.name}.sh（trigger=${spec.trigger.mode}）`
  return `#!/bin/bash
# 数据源: ${spec.name} — ${spec.about || '（未写用途）'}
# 由 dsh-reflex 的 Trigger 页按三段式生成（give / when / trigger）。
#
#   give    : 下面「采集命令」块 —— 它的 stdout 就是数据，每行一个 JSON 对象
#   when    : ${spec.name}.env.json 里的 intervalMs
#   trigger : ${triggerLine}
#
# 契约（DATASOURCE.md §2）
#   stdout 每行一个 JSON fact；source/ts 由插件补。插件另补一条 ${scan} 汇总行。
#   退出 0 + 空输出 = 本轮没有新数据（正常）；退出非 0 = 记 L0 ${spec.name} failed。
#   「没找到就退出 1」的命令（grep 这类）请在末尾接 || true，否则会被记成失败。
#   幂等：按整行内容的 sha256 去重；首跑只建水位，不倒历史 —— 不会把存量当新事件叫醒。
set -uo pipefail

RH="\${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"
STATE="$RH/seen-${spec.name}.json"
mkdir -p "$RH" 2>/dev/null || true

WORK="$(mktemp -d "\${TMPDIR:-/tmp}/${spec.name}-collect.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM
RAW="$WORK/raw.txt"

# ---------- give：采集命令（改这里就是改数据来源） ----------
# 用子 shell 跑：命令里的 exit / cd / set 只影响子 shell，不会把采集器本身带走。
(
${spec.cmd}
) > "$RAW" 2> "$WORK/stderr.txt"
CMD_RC=$?

if [ ! -s "$RAW" ]; then
  printf '[${spec.name}] 采集命令没有输出 (rc=%s)\\n' "$CMD_RC" >&2
  tail -3 "$WORK/stderr.txt" >&2 2>/dev/null || true
  exit 1
fi

python3 - "$RAW" "$STATE" "${scan}" "$CMD_RC" <<'PY'
import hashlib, json, os, sys

raw_path, state_path, scan_metric, cmd_rc = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
CAP = 20000   # 水位上限：超出丢最旧的键（被丢的键再出现会当新条目重发一次）


def load():
    try:
        with open(state_path, encoding="utf-8") as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except Exception:
        return {}


def save(st):
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, state_path)      # 原子替换：被杀在半路也不会留下半截水位


st = load()
order = [k for k in st.get("order", []) if isinstance(k, str)]
known = set(order)
seeded = bool(st.get("seeded"))

total = 0
bad = 0
fresh = []
for line in open(raw_path, encoding="utf-8", errors="replace"):
    t = line.strip()
    if not t:
        continue
    total += 1
    try:
        obj = json.loads(t)
    except Exception:
        bad += 1
        continue
    if not isinstance(obj, dict):
        bad += 1        # 不是对象就不合契约（插件只认 {"metric","raw"} 这种形状）
        continue
    key = hashlib.sha256(t.encode("utf-8")).hexdigest()[:16]
    if key in known:
        continue
    known.add(key)
    order.append(key)
    fresh.append(t)

# 先落水位再发数据：中途被杀宁可漏一条，也不要重发（重发会重复叫醒）
save({"v": 1, "seeded": True, "order": order[-CAP:]})

if bad and bad == total:
    sys.stderr.write("[%s] 采集命令输出了 %d 行，没有一行是合法 JSON 对象\\n" % (scan_metric, bad))
    sys.exit(1)

# 首跑只建水位：存量不发出去（否则一装上就把历史当新事件刷屏）
if seeded:
    for t in fresh:
        print(t)        # 数据行原样转发：metric / raw 由采集命令自己定
print(json.dumps({"metric": scan_metric,
                  "raw": {"ok": True, "seeded": not seeded, "total": total, "bad": bad,
                          "new": 0 if not seeded else len(fresh), "cmdRc": cmd_rc}},
                 ensure_ascii=False))
PY
exit $?
`
}

/** when 段：采集间隔。timeoutMs 不放 20s 默认值 —— 慢源会被杀在半路，且看起来像"没数据"。 */
export function renderCollectorEnv(spec) {
  return JSON.stringify({ intervalMs: spec.intervalMs, timeoutMs: 120_000, env: {} }, null, 2) + '\n'
}

/** 让 L2 不读脚本源码也看得懂这个源有什么字段、多久采一次。 */
export function renderSchema(spec) {
  const minutes = Math.round(spec.intervalMs / 60000)
  const trigger = spec.trigger.mode === 'off'
    ? '只采集，不进 L1'
    : spec.trigger.mode === 'match'
      ? `关键词命中才叫醒（${spec.trigger.keywords.join(' / ')}）`
      : spec.trigger.mode === 'semantic'
        ? `语义判据（影子记账）：${spec.trigger.criteria}`
        : '任何新条目都叫醒'
  return JSON.stringify({
    metric: `${spec.name}${SCAN_METRIC_SUFFIX}（每轮一条汇总）+ 采集命令自己输出的 metric`,
    fields: {
      ok: '本轮采集是否成功',
      seeded: '首跑水位标记（true=只建基线，不发存量）',
      total: '本轮从采集命令读到的行数',
      bad: '其中不是合法 JSON 对象的行数',
      new: '本轮新增的数据行数（首跑恒为 0）',
      cmdRc: '采集命令的退出码',
    },
    notes: `${spec.about || '（未写用途）'}｜采集间隔 ≈ ${minutes} 分钟｜触发：${trigger}。数据行的字段由采集命令决定。`,
  }, null, 2) + '\n'
}

/** trigger 段：三种判定方式共用一个壳，差别只在 python 里的过滤与是否叫醒。 */
export function renderTarget(spec) {
  const name = spec.name
  const scan = name + SCAN_METRIC_SUFFIX
  const isSemantic = spec.trigger.mode === 'semantic'
  const keywords = spec.trigger.mode === 'match' ? spec.trigger.keywords : []
  const reason = spec.trigger.mode === 'match'
    ? `${name} 命中关键词 %d 条`
    : `${name} 有 %d 条新内容`
  const head = `#!/bin/bash
# target: ${name} — ${describeTrigger(spec)}
# 由 dsh-reflex 的 Trigger 页按三段式生成（give / when / trigger）。
#
# 契约
#   stdin 收本轮该源的新事实（JSONL）→ stdout 恰好一行决策 JSON；不唤醒 = 空输出。
#   ${scan} 是采集器的汇总行，不算数据（下面第一件事就是把它剔掉）。
${isSemantic ? '#   影子模式：只打分记账，不叫醒。攒够样本后校准阈值，再决定要不要转成确定性叫醒。' : '#   命中才输出：不命中必须一个字都不输出，否则等于乱叫。'}
set -uo pipefail

WORK="$(mktemp -d "\${TMPDIR:-/tmp}/${name}-target.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM
cat > "$WORK/facts.jsonl"        # 先把 stdin 落盘：heredoc 会顶掉管道 stdin，直接喂 python 会一条都读不到
`
  const tail = `exit $?
`
  if (isSemantic) {
    return head + `
python3 - "$WORK/facts.jsonl" "$WORK/rows.jsonl" <<'PY'
import json, sys, time

facts_path, rows_path = sys.argv[1], sys.argv[2]
SCAN = ${pyLiteral(scan)}
QUESTION = ${pyLiteral(spec.trigger.criteria)}
YES = ${pyLiteral('满足这条判据：' + spec.trigger.criteria)}
NO = ${pyLiteral('不满足或不相关：' + spec.trigger.criteria + '（只是提及、传闻、与判据无关的内容都算 no）')}
CAP = 20        # 单轮最多打这么多条：影子是记账，不是把成本拉满

rows = []
for line in open(facts_path, encoding="utf-8", errors="replace"):
    t = line.strip()
    if not t:
        continue
    try:
        rec = json.loads(t)
    except Exception:
        continue
    if not isinstance(rec, dict) or rec.get("metric") == SCAN:
        continue
    raw = rec.get("raw")
    text = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
    rows.append({"id": "%s-shadow-%s" % (${pyLiteral(name)}, len(rows)),
                 "state": text,
                 "question": QUESTION,
                 "options": [{"id": "yes", "description": YES},
                             {"id": "no", "description": NO}],
                 "createdMs": int(time.time() * 1000) + len(rows)})

with open(rows_path, "w", encoding="utf-8") as f:
    for row in rows[-CAP:]:
        f.write(json.dumps(row, ensure_ascii=False) + "\\n")
PY

# 影子打分交给宿主注入的 wrapper（全量分落在 $REFLEX_HOME/shadow/）
SEMIF="\${REFLEX_SEMIF_RUN:-}"
if [ -n "$SEMIF" ] && [ -f "$SEMIF" ] && [ -s "$WORK/rows.jsonl" ]; then
  bash "$SEMIF" --input "$WORK/rows.jsonl" --output "$WORK/scores.jsonl" > /dev/null 2> "$WORK/semif.err" || true
  [ -s "$WORK/semif.err" ] && printf '[${name}] 影子打分告警: %s\\n' "$(tail -1 "$WORK/semif.err")" >&2
fi
` + tail
  }
  return head + `
python3 - "$WORK/facts.jsonl" <<'PY'
import hashlib, json, sys

facts_path = sys.argv[1]
SCAN = ${pyLiteral(scan)}
KEYWORDS = ${pyLiteral(keywords)}
REASON = ${pyLiteral(reason)}

items = []
scanned = 0
for line in open(facts_path, encoding="utf-8", errors="replace"):
    t = line.strip()
    if not t:
        continue
    try:
        rec = json.loads(t)
    except Exception:
        continue
    if not isinstance(rec, dict) or rec.get("metric") == SCAN:
        continue
    scanned += 1
    raw = rec.get("raw")
    text = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
    if KEYWORDS and not any(k in text for k in KEYWORDS):
        continue
    first = text.strip().splitlines()[0] if text.strip() else "(空)"
    items.append({"id": ${pyLiteral(name + ':')} + hashlib.sha256(t.encode("utf-8")).hexdigest()[:16],
                  "title": first[:80],
                  "body": text})

if items:
    print(json.dumps({"wake": True,
                      "reason": REASON.replace("%d", str(len(items))),
                      "fingerprint": {"ids": [i["id"] for i in items]},
                      "scanned": scanned,
                      "items": items}, ensure_ascii=False))
PY
` + tail
}

/** target 的 env：sources 不声明就是空跑，这是最容易忘的一行。 */
export function renderTargetEnv(spec) {
  return JSON.stringify({
    displayName: spec.name,
    sources: [spec.name],
    minIntervalMs: spec.intervalMs,
    timeoutMs: 120_000,
    env: {},
  }, null, 2) + '\n'
}

function describeTrigger(spec) {
  if (spec.trigger.mode === 'off') return '只采集，不叫醒（不该生成这个文件）'
  if (spec.trigger.mode === 'match') return `关键词命中才叫醒（${spec.trigger.keywords.join(' / ')}）`
  if (spec.trigger.mode === 'semantic') return `语义判据·影子记账（${spec.trigger.criteria}）`
  return '任何新条目都叫醒'
}

/** 一次创建会写哪些文件（界面据此做"提交前复核"）。 */
export function planSourceFiles(spec) {
  const collector = [
    { dir: 'collectors', file: `${spec.name}.sh`, mode: 0o755 },
    { dir: 'collectors', file: `${spec.name}.env.json`, mode: 0o644 },
    { dir: 'collectors', file: `${spec.name}.schema.json`, mode: 0o644 },
  ]
  if (spec.trigger.mode === 'off') return collector
  return [...collector,
    { dir: 'targets', file: `${spec.name}.sh`, mode: 0o755 },
    { dir: 'targets', file: `${spec.name}.env.json`, mode: 0o644 },
  ]
}

/**
 * 把所有文件写进目录：先全部写 .tmp、验一遍、再逐个 rename；任何一步失败都不留半成品。
 * @param {{collectorsDir:string, targetsDir?:string}} dirs
 * @param {object} spec parseNewSource 的返回值
 * @param {{check?:(path:string, content:string)=>void}} [options] 写盘前的语法检查（由宿主注入 bash -n）
 * @returns {{created:string[], plan:Array<{path:string,file:string}>}}
 */
export function createSource(dirs, spec, options = {}) {
  const collectorsDir = dirs?.collectorsDir
  const targetsDir = dirs?.targetsDir
  if (!collectorsDir) throw new Error('createSource 缺少 collectorsDir')
  const plan = planSourceFiles(spec)
  // 解析层已经查过一次重名（给界面早报错）；这里再守一次 —— createSource 可以被直接调用。
  for (const item of plan) {
    const dir = item.dir === 'targets' ? targetsDir : collectorsDir
    if (!dir) throw new Error(`createSource 缺少 ${item.dir} 目录`)
    const path = join(dir, item.file)
    if (existsSync(path)) throw new Error(`已存在：${item.dir}/${item.file}（不覆盖已有数据源）`)
  }
  for (const item of plan) {
    mkdirSync(item.dir === 'targets' ? targetsDir : collectorsDir, { recursive: true })
  }
  const rendered = plan.map((item) => {
    const dir = item.dir === 'targets' ? targetsDir : collectorsDir
    const path = join(dir, item.file)
    const content = item.file.endsWith('.sh')
      ? (item.dir === 'targets' ? renderTarget(spec) : renderCollector(spec))
      : item.file.endsWith('.env.json')
        ? (item.dir === 'targets' ? renderTargetEnv(spec) : renderCollectorEnv(spec))
        : renderSchema(spec)
    return { ...item, path, content, tmp: `${path}.tmp.${process.pid}` }
  })
  const renamed = []
  try {
    for (const f of rendered) {
      writeFileSync(f.tmp, f.content, { encoding: 'utf8', mode: f.mode })
      chmodSync(f.tmp, f.mode)
    }
    if (typeof options.check === 'function') {
      for (const f of rendered) if (f.file.endsWith('.sh')) options.check(f.path, f.content)
    }
    for (const f of rendered) {
      renameSync(f.tmp, f.path)
      renamed.push(f.path)
    }
  } catch (e) {
    for (const f of rendered) { try { rmSync(f.tmp, { force: true }) } catch { /* 尽力而为 */ } }
    for (const path of renamed) { try { rmSync(path, { force: true }) } catch { /* 尽力而为 */ } }
    throw e
  }
  return { created: renamed, plan: rendered.map((f) => ({ path: f.path, file: f.file, dir: f.dir })) }
}

/**
 * 试跑结果摘要：把命令的 stdout 翻成「几行 / 几行合法 / 前几行」。
 * 只做统计与截样，不判断内容对不对 —— 那要看人。
 */
export function summarizeProbe(stdout, limit = 3) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  let valid = 0
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object') valid += 1
    } catch { /* 非法行只计数 */ }
  }
  return { lines: lines.length, valid, bad: lines.length - valid, sample: lines.slice(0, Math.max(0, limit)) }
}
