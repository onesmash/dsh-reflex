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
export function scanSources(dir, options = {}) {
  if (!existsSync(dir)) return []
  // 逐行「L1 调优」按钮要知道这一行有没有判据可调：只看文件在不在，不猜。
  const targetsDir = typeof options.targetsDir === 'string' ? options.targetsDir : ''
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
    return {
      name,
      paused: existsSync(join(dir, `${name}.paused`)),
      intervalMs,
      hasEnv,
      metric,
      hasTarget: Boolean(targetsDir) && existsSync(join(targetsDir, `${name}.sh`)),
    }
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
 * @param {string} op 'list' | 'pause' | 'resume' | 'create' | 'probe' | 'delegate'
 * @param {object} body 面板请求体（含 name / 三段式字段 / 一句话建源的 sentence）
 * @param {object} io { list(), commit(name,paused), refresh(), log(msg), create(body), probe(body), delegate(body) }
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
  // 一句话建源：把原话拼成提示词投给 bot。投递是异步的（要等会话控制器），
  // 所以和 probe 一样恒返回 Promise；投不出去必须 reject —— 界面要看到「没交出去」，
  // 而不是一个 ok:true 之后什么都没有发生。
  if (op === 'delegate') {
    if (typeof io?.delegate !== 'function') {
      return Promise.reject(new Error('一句话建源未接线：宿主没有提供 delegate'))
    }
    return Promise.resolve(io.delegate(body)).then((result) => ({ ok: true, ...(result ?? {}) }))
  }
  // 逐行 L1 调优：同样只接线。合法性（有没有这个源、有没有 target）由宿主判，
  // 因为只有宿主手里有 collectors/targets 两个目录。
  if (op === 'tune') {
    if (typeof io?.tune !== 'function') {
      return Promise.reject(new Error('L1 调优未接线：宿主没有提供 tune'))
    }
    return Promise.resolve(io.tune(body)).then((result) => ({ ok: true, ...(result ?? {}) }))
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
  sentenceMax: 500,
})

/** 采集命令自己那条汇总行的固定后缀：target 据此把它排除，不当数据。 */
export const SCAN_METRIC_SUFFIX = '-scan'

/**
 * 一句话建源：把用户原话拼进固定提示词，交给 bot（默认 L1 的 targetBot）执行。
 *
 * 为什么不再让界面去填字段：真正难的从来不是那六个框，而是「采集命令」——它必须自己
 * 输出 JSONL。把这件事交给读过 reflex-datasource 的 bot，用户就只需要说清「盯着什么、
 * 什么情况叫我」。代价是每次产出不完全一致，所以提示词里把验收写成硬要求：
 * 报不出数字就当没做完。
 *
 * @param {string} sentence 用户原话（一句话）
 * @returns {string} 可以被直接投递的完整提示词
 */
export function buildDelegatePrompt(sentence) {
  const said = String(sentence ?? '').trim()
  if (!said) throw new Error('先写一句话：监控什么、什么情况叫你')
  if (said.length > NEW_SOURCE_LIMITS.sentenceMax) {
    throw new Error(`那句话太长：${said.length} 字（上限 ${NEW_SOURCE_LIMITS.sentenceMax}）`)
  }
  return `[建源请求] 用户要加一个监控，原话如下：

「${said}」

把它变成一个 dsh-reflex 数据源，并验证它真能出数据。

先做两件事
1. 加载 skill reflex-datasource —— 契约、脚手架、验证清单都在里面，不要凭记忆写。
2. ls $REFLEX_HOME/collectors/ 看现有源；能复用（x-timeline / arxiv / futu-baba /
   screen-ocr 这类）就复用，不要重造。

硬约束
- 名字 ^[a-z0-9][a-z0-9._-]*$，不重名、不与内置源撞。
- 采集器 stdout 每行一个 JSON 对象；首跑只建水位、不发存量。
- 落盘顺序：env / schema / target 先写，collectors/<name>.sh 最后落 —— 它才是提交点，
  中途失败不许留半个源。
- 间隔 10s~7d，默认 15 分钟；采集命令 ≤4000 字符。
- 判定用 all 或 match(关键词)；不要用 semantic —— 它现在只记账不叫醒，建出来是哑的。

验收（拿不到证据就算没做完）
1. 手工跑一次：退出码 0、有行、每行合法 JSON，贴「N 行 / 前 3 条摘要」。
2. 连跑第二次：应为 0 条（水位幂等）。
3. 确认热发现已认出该源（面板列表或日志里出现该源）。

回报
一句话结论（建了什么 / 多久抓一次 / 什么情况叫你）+ 写了哪几个文件 + 上面三项的实际数字。
任一步不过：不落盘或回滚，直接说哪步不过、原话报错是什么。`
}

/**
 * 逐行「L1 调优」：把源名拼进固定的调优提示词，交给 bot 按 reflex-tuning 走四层。
 *
 * 为什么不把门槛留给现场判断：0 标签拟合阈值就是拟合噪声。样本量分档、A/B、重拟合、
 * 语义不许自动转正这几条必须写在提示词里，否则每次调优的可靠性都取决于当天谁在处理。
 */
export const TUNE_PREFERENCE_MAX = 500

/**
 * 「调优请求」提示词。
 *
 * @param {string} name 数据源名
 * @param {string} [preference] 用户这次的要求（原话）。空 = 与旧行为逐字一致，
 *   所以这里只在非空时插一段，不改已有措辞 —— 旧调用方与旧测试都不受影响。
 *   偏好写在最前面：bot 先看到「这次要什么」，再读规矩。
 */
export function buildTunePrompt(name, preference) {
  const target = String(name ?? '').trim()
  if (!target) throw new Error('先给一个数据源名字')
  if (!NAME.test(target)) throw new Error(`名字不合法：${JSON.stringify(target)}`)

  const pref = String(preference ?? '').trim()
  if (pref.length > TUNE_PREFERENCE_MAX) {
    throw new Error(`偏好最多 ${TUNE_PREFERENCE_MAX} 个字（现在 ${pref.length} 个）`)
  }
  const prefBlock = pref
    ? `\n用户这次的偏好（原话，按它取舍；它不覆盖下面的硬规矩）：\n${pref}\n`
    : ''
  return `[调优请求] 目标数据源：${target}
${prefBlock}
先读现场，再决定改不改。不许凭印象调参数。

## 一、先把基线读出来（这一步不做完，后面一律不许动文件）
1. 加载 skill reflex-tuning，按它的四层机制走：影子 → 回放 → 拟合/证书 → 策略。
2. 读 $REFLEX_HOME/tools/shadow_targets.json 里 ${target} 的当前条目（阈值、标签数、note、回滚说明）。
   没有条目 = 这个源从没调过，先只做诊断。
3. 数样本：shadow/${target}-*.jsonl 的条数、能对上标签的条数。
4. 读 targets/${target}.sh 与 targets/${target}.env.json，把当前判据原文、阈值、去重/冷却/合并参数抄进报告。

## 二、按样本量分档，不许越档
- 标签 ≥ 100：可做完整调优（threshold_fit 拟合 + risk_certificate 给 CP 下界 + 与同量随机基线对比）。
- 标签 30–99：只做保守调整——只动阈值或去重，不改判据措辞；结论必须写明 CP 区间宽到什么程度。
- 标签 < 30（含 0）：不许改任何文件。只出诊断：缺多少样本、建议怎么攒、哪几个维度该先标。

## 三、硬规矩（skill 里写着，这里再写一遍，违反就算没做完）
- 改判据 ⟹ 必须先 A/B（shadow_ab.py），且改完重拟合阈值、重跑 pc_inject.py 看判据指纹。
  判据一改，分数尺度整体漂移，旧阈值直接失效。
- 改阈值 ⟹ 必须用 threshold_fit.py 按期望效用拟合，并把新值 + 依据写回 tools/shadow_targets.json。
  阈值不许硬编码在脚本里。
- 语义判据的 target（只记账不叫醒）：只能给出「建议阈值 + 转正条件」，不许自动转成叫醒。转正要人点。
- 不动 collectors/${target}.sh，不动采集间隔（要改必须单列一节说明理由与证据）。
- 标签读不到必须报错，不许当作「没有负面样本」。

## 四、回报
一句话结论（调了没调、为什么）+ 改前/改后对照（阈值、P/R、CP 下界、同量随机基线）+
改了哪几行（路径:行号）+ 回滚方式（一行命令）。分档为「只看不改」时，明确写「本轮未改任何文件」。`
}

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

/**
 * 一次创建会写哪些文件（界面据此做"提交前复核"）。
 *
 * ⚠️ 顺序是设计的一部分，不是随手排的：`collectors/<name>.sh` 必须是**最后**一个落盘的文件。
 * 它一出现，插件下一轮就把这个源当数据源；而五个文件是分别 rename 的，不是一次落盘的。
 * 如果采集器先落盘，进程死在剩下的 rename 中途，就会留下「会一直采集、永远不叫醒」的源，
 * 而且同名再也建不了（重名守卫会拒）。把它放在最后 = 它才是提交点：
 * 前面任何一个文件没落成，源都还不可见，最多留下点无害的残留。
 *
 * 这条不是靠推理定的：docs/verification/create-source/ 有 TLC 模型，
 * 现顺序 `Atomic breaks`（2 步），这个顺序 `Atomic` 守住；重放见 P19 的崩溃测试。
 */
export function planSourceFiles(spec) {
  const collectorConfig = [
    { dir: 'collectors', file: `${spec.name}.env.json`, mode: 0o644 },
    { dir: 'collectors', file: `${spec.name}.schema.json`, mode: 0o644 },
  ]
  const targetFiles = spec.trigger.mode === 'off' ? [] : [
    { dir: 'targets', file: `${spec.name}.sh`, mode: 0o755 },
    { dir: 'targets', file: `${spec.name}.env.json`, mode: 0o644 },
  ]
  const commitPoint = { dir: 'collectors', file: `${spec.name}.sh`, mode: 0o755 }
  return [...collectorConfig, ...targetFiles, commitPoint]
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
  // rename 可注入：测试要复现「进程在落盘中途被杀」——这种崩溃跑不到 catch，
  // 只能让子进程在第 N 次 rename 时真的杀掉自己，再回来检查盘上的状态。
  const rename = typeof options.rename === 'function' ? options.rename : renameSync
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
      rename(f.tmp, f.path)
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
