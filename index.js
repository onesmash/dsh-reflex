// Layered Agent — cordis sibling plugin to ds-bot (zero modification to ds-bot).
//
// 分层智能体 (你的架构):
//   L0 事实序列化层: 轮询数据源(程序), 带时间戳/来源序列化存储 facts/
//   L1 SemIf 决策层: 轮询新事实, 硬规则先决 + SemIf 本地模型裁决边界
//   L2 推理层: 被 L1 唤醒(事件驱动, 不轮询) — 通过 DSH schedule 服务投递消息给目标 Bot session
//
// 共存: 独立 cordis 插件, patch: cordis.patch.yml -> insert: { id: layered-agent }.
//   不修改原版 ds-bot 任何代码; 通过 ctx.get('schedule') + 读 bot state.json 定位目标会话。

import { join, dirname } from 'node:path'
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------- 配置 (可通过 profile patch 覆盖: layered-agent: {...}) ----------
const DEFAULTS = {
  enabled: true,
  statePath: join(process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh'), 'bot', 'state.json'),
  l0: {
    intervalMs: 60_000,
    sources: ['disk'],
    storeDir: process.env.LAYERED_FACT_DIR || join(process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), 'bot', 'layered-facts'),
  },
  l1: {
    intervalMs: 60_000,
    threshold: 0.8,
    hardRule: { lowAvailableGB: 20, highUsedPct: 90 },
    targetBot: 'Chief',       // L1 触发时唤醒 Chief 决策 (Chief 再派发执行 Bot)
    escalateToChief: false,   // 目标就是 Chief, 无需再升级
    chiefBot: 'Chief',
    cooldownMs: 30 * 60 * 1000,  // 同状态异常冷却: 30 分钟内不重复唤醒
  },
  semif: {
    skillDir: join(process.env.HOME || '', '.agents', 'skills', 'semif-decide'),
  },
}

export const name = 'ds-bot-layered-agent'

// 探明 (本地 cordis 决定性实验): module-level inject 会让 apply 延迟到服务可见才执行;
// 真实 DSH 里 schedule 服务可能不在插件可见的隔离作用域, 导致 apply 永不执行。
// ds-bot 成功路径 = inject 不声明 + 运行时 ctx.inject(['schedule'], attach) 动态子插件。
export const inject = []

export function apply(ctx, config = {}) {
  try {
    return install(rtOf(ctx), ctx, normalize(cfgOf(config)))
  } catch (e) {
    // 兄弟插件绝不拖垮宿主: 任何初始化错误都降级为记录并跳过
    try { ctx.logger?.warn?.(`[layered-agent] init skipped: ${e.message}`) } catch {}
    return undefined
  }
}

function cfgOf(config) {
  return config?.layeredAgent ?? config ?? {}
}
function normalize(c) {
  const cfg = {
    ...DEFAULTS,
    ...c,
    l0: { ...DEFAULTS.l0, ...(c?.l0 ?? {}) },
    l1: { ...DEFAULTS.l1, ...(c?.l1 ?? {}) },
    semif: { ...DEFAULTS.semif, ...(c?.semif ?? {}) },
  }
  return cfg
}

// 构造一个最小的 rt 视图 (兄弟插件只用 state + 会话定位, 不碰 ds-bot 内部)
function rtOf(ctx) {
  return { ctx }
}

// ================================================================
//  安装: 注册 L0/L1 定时器 + L2 唤醒 (通过 schedule 服务)
// ================================================================
function install(rt, ctx, cfg) {
  // 确保事实目录存在
  try { mkdirSync(cfg.l0.storeDir, { recursive: true }) } catch {}
  const logFile = join(cfg.l0.storeDir, '..', 'layered-agent.log')
  const log = (m) => {
    const line = `[${new Date().toISOString()}] ${m}`
    try { appendFileSync(logFile, line + '\n') } catch {}
    try { ctx.logger?.info?.(line) } catch {}
  }

  // 投递服务: 用 ds-bot 同款机制 = ctx.sessionController.resolveAgent(sessionId) → agent.followup(message)
  // (schedule 服务在插件上下文不可见, 已探明; sessionController 是 ds-bot 必需服务, 对插件可见)
  let sessionCtrl = null
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionController'], (sub) => {
        sessionCtrl = sub?.sessionController
        log(`sessionController attached (${sessionCtrl ? 'ok' : 'null'})`)
        try { sub?.effect?.(() => () => { if (sessionCtrl) sessionCtrl = null }, 'layered-agent: sessionController') } catch {}
      })
    } else {
      log('ctx.inject unavailable at install')
    }
  } catch (e) { log(`inject sessionController failed: ${e.message}`) }
  const sessionCtrlSvc = () => sessionCtrl

  // ---------- 定位目标 Bot 的 chat sessionId (读 state.json) ----------
  function botSessionId(name) {
    try {
      const state = JSON.parse(readFileSync(cfg.statePath, 'utf8'))
      for (const [id, b] of Object.entries(state.bots ?? {})) {
        if (b.name === name) {
          // chat session = bot 的 sessionId 字段, 无则 key 本身 (store.js: chatOf = botOf(botId)?.sessionId ?? botId)
          return b.sessionId ?? id
        }
      }
    } catch (e) { log(`botSessionId error: ${e.message}`) }
    return undefined
  }

  // 复刻 dsh-llm createUserMessage (只加 id; 返回可被 followup 接受的 user 消息)
  function createUserMessageLike({ content, source }) {
    return { id: `msg-${randomUUID().replace(/-/g, '').slice(0, 24)}`, role: 'user', content, source }
  }

  // ---------- L2 唤醒: 经 sessionController 直接投递 (ds-bot 同款) ----------
  async function wakeL2(summary) {
    try {
      const targetName = cfg.l1.targetBot
      const sessionId = botSessionId(targetName)
      if (!sessionId) { log(`L2 wake failed: no session for "${targetName}"`); return }
      const sc = sessionCtrlSvc()
      if (!sc?.resolveAgent) { log('L2 wake failed: sessionController unavailable'); return }
      const resolved = await sc.resolveAgent(sessionId)
      if ('error' in resolved) { log(`L2 wake failed: ${resolved.error?.message}`); return }
      const agent = resolved.agent
      const text = `[分层智能体·L1] 检测到需关注事件：${summary}\n请评估并决策是否需要处理(如可清理缓存则执行)。`
      const message = createUserMessageLike({
        content: [{ type: 'text', text }],
        source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: randomUUID(), senderName: '分层智能体', hop: 0 },
      })
      if (agent?.followup) agent.followup(message)
      else if (agent?.steer) agent.steer(message)
      else { log('L2 wake failed: agent has no followup/steer'); return }
      log(`L2: woken "${targetName}" (${sessionId}) via sessionController`)
    } catch (e) {
      log(`L2 wake error: ${e.message}`)
    }
  }

  // ---------- L0: 数据源采集 ----------
  const SOURCES = {
    async disk() {
      const { stdout } = await execFileP('df', ['-k', '/System/Volumes/Data'])
      const line = stdout.trim().split('\n')[1]?.trim().split(/\s+/)
      if (!line) return []
      const [, totalKb, usedKb, availKb] = line.map(Number)
      return [{
        source: 'disk', metric: 'data-volume', ts: Date.now(),
        raw: {
          availableGB: +(availKb / 1048576).toFixed(2),
          usedPct: Math.round((usedKb / totalKb) * 100),
          totalGB: +(totalKb / 1048576).toFixed(2),
          usedGB: +(usedKb / 1048576).toFixed(2),
        },
        meta: { volume: '/System/Volumes/Data' },
      }]
    },
  }

  // ---------- L0: 序列化存储 (JSONL) ----------
  let factCounter = 0
  function appendFact(fact) {
    const date = new Date(fact.ts).toISOString().slice(0, 10)
    const file = join(cfg.l0.storeDir, `${date}.jsonl`)
    const row = { id: `fact-${randomUUID().slice(0, 8)}`, seq: ++factCounter, ...fact, ...(fact.raw ? { raw: fact.raw } : {}) }
    appendFileSync(file, JSON.stringify(row) + '\n')
    return row
  }

  async function collectOnce() {
    const ts = Date.now()
    let count = 0
    for (const src of cfg.l0.sources) {
      const c = SOURCES[src]
      if (!c) continue
      try {
        const rows = await c()
        for (const r of rows) appendFact({ ts, ...r })
        count += rows.length
      } catch (e) { log(`L0 ${src} failed: ${e.message}`) }
    }
    if (count) log(`L0: +${count} fact(s)`)
    return count
  }

  // ---------- L1: 增量读事实 (持久化游标 cursor.json, 跨重启不重读历史) ----------
  // 游标 = 上次消费到 <file, lineIndex>; L0 事实追加在按日期命名的 jsonl, 文件排序 == 时间序。
  const cursorPath = join(dirname(cfg.l0.storeDir), 'cursor.json')
  let cursor = { file: null, line: 0 }
  try { if (existsSync(cursorPath)) cursor = { file: null, line: 0, ...JSON.parse(readFileSync(cursorPath, 'utf8')) } } catch (e) { log(`cursor read fail: ${e.message}`) }
  function saveCursor() { try { writeFileSync(cursorPath, JSON.stringify(cursor)) } catch (e) { log(`cursor write fail: ${e.message}`) } }

  // 返回 (facts, 新游标位置)。只读游标之后的新事实; 不修改游标 (由调用方在决策后 advanceCursor)
  function readNewFacts() {
    const out = []
    const dir = cfg.l0.storeDir
    let nextFile = null, nextLine = 0
    try {
      const files = (existsSync(dir) ? readdirSync(dir) : []).filter(f => f.endsWith('.jsonl')).sort()
      for (const f of files) {
        // 游标前的文件整跳过; 游标当前文件从 cursor.line 起
        if (cursor.file && f < cursor.file) continue
        const startIdx = (cursor.file === f) ? cursor.line : 0
        const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)
        for (let i = startIdx; i < lines.length; i++) {
          let o; try { o = JSON.parse(lines[i]) } catch { continue }
          out.push(o)
          nextFile = f; nextLine = i + 1
        }
      }
    } catch (e) { log(`L1 read fail: ${e.message}`) }
    return { facts: out.slice(-50), nextFile, nextLine }
  }
  function advanceCursor(nextFile, nextLine) {
    if (!nextFile) return
    cursor = { file: nextFile, line: Math.max(cursor.file === nextFile ? cursor.line : 0, nextLine) }
    saveCursor()
  }

  // ---------- L1: SemIf 调用 ----------
  async function semifDecide(state) {
    const runScore = join(cfg.semif.skillDir, 'scripts', 'run_score.sh')
    const work = join(cfg.l0.storeDir, '..', 'work')
    try { mkdirSync(work, { recursive: true }) } catch {}
    const inp = join(work, `dec-${process.pid}.jsonl`)
    const out = join(work, `res-${process.pid}.jsonl`)
    for (const f of [out, out.replace(/\.jsonl$/, '.summary.md')]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
    const row = {
      id: 'l1',
      state,
      question: '仅当磁盘可用空间紧张、使用率过高、或出现明确异常时选 yes 需要唤醒 L2 处理。若一切正常或轻微波动选 no; 数据不足选 insufficient。',
      options: [
        { id: 'yes', description: '需要唤醒 L2。存在明确需决策的异常。' },
        { id: 'no', description: '无需唤醒 L2。空间充足或轻微波动。' },
        { id: 'insufficient', description: '数据不足, 无法判断。' },
      ],
    }
    writeFileSync(inp, JSON.stringify(row) + '\n')
    await execFileP('bash', [runScore, '--input', inp, '--output', out, '--offline'], { timeout: 120_000 })
    const res = JSON.parse(readFileSync(out, 'utf8').trim().split('\n').pop())
    const ids = res.option_ids, probs = res.probabilities
    const p = {}; ids.forEach((id, i) => { p[id] = probs[i] })
    return { winning: ids[probs.indexOf(Math.max(...probs))], pYes: p.yes ?? 0 }
  }

  // ---------- L1: 决策 (增量: 游标推进 + 状态冷却去重) ----------
  // lastWake 记录上次唤醒的"状态指纹+时间", 同状态或冷却期内不重复唤醒 → L2 无状态可行
  const lastWakePath = join(dirname(cfg.l0.storeDir), 'last-wake.json')
  let lastWake = null
  try { if (existsSync(lastWakePath)) lastWake = JSON.parse(readFileSync(lastWakePath, 'utf8')) } catch (e) { log(`last-wake read fail: ${e.message}`) }
  function saveLastWake(w) { try { writeFileSync(lastWakePath, JSON.stringify(w)) } catch (e) { log(`last-wake write fail: ${e.message}`) } }
  // 状态指纹: 用于判断"是否同一异常"。磁盘场景取 (avail 取整到 5GB, usedPct 取整到 5%) 的量化。
  function stateFingerprint(disk) {
    if (!disk) return null
    return { availBucket: Math.round((disk.availableGB ?? 0) / 5), usedBucket: Math.round((disk.usedPct ?? 0) / 5) }
  }
  function contentChanged(fp) {
    if (!lastWake || !lastWake.fp) return true                     // 无上次 → 视为新
    if (lastWake.fp.availBucket !== fp.availBucket || lastWake.fp.usedBucket !== fp.usedBucket) return true  // 状态显著变化 → 新
    const cooldownMs = cfg.l1.cooldownMs ?? 30 * 60 * 1000          // 冷却期内同状态不重复
    if (Date.now() - (lastWake.at ?? 0) < cooldownMs) return false
    return true                                                     // 同状态但超过冷却期 → 重新关注
  }

  async function decideOnce() {
    // 测试钩子: wake-test 标记 → 强制唤醒 (端到端验证)
    try {
      const marker = join(dirname(cfg.l0.storeDir), 'wake-test')
      if (existsSync(marker)) { unlinkSync(marker); log('L1: TEST-WAKE marker → forcing wakeL2'); await wakeL2('端到端投递测试 (wake-test 标记触发)'); return }
    } catch (e) { log(`TEST-WAKE error: ${e.message}`) }
    const { facts, nextFile, nextLine } = readNewFacts()
    if (!facts.length) return
    // 无论要不要唤醒, 都推进游标 (已消费这些事实)
    advanceCursor(nextFile, nextLine)
    const disk = facts.filter(f => f.source === 'disk').slice(-1)[0]?.raw
    const state = {
      since: facts[0]?.ts ?? Date.now(),
      count: facts.length,
      disk,
      policy: `可用空间低于${cfg.l1.hardRule.lowAvailableGB}GB 或使用率高于${cfg.l1.hardRule.highUsedPct}% 视为需要关注`,
    }
    const fp = stateFingerprint(disk)
    // 硬规则先决
    if (disk && (disk.availableGB < cfg.l1.hardRule.lowAvailableGB || disk.usedPct > cfg.l1.hardRule.highUsedPct)) {
      if (contentChanged(fp)) {
        const summary = `磁盘可用 ${disk.availableGB}GB / 使用率 ${disk.usedPct}% (硬规则触发)`
        log(`L1: HARD-RULE -> ${summary}`)
        await wakeL2(summary)
        saveLastWake({ fp, at: Date.now(), reason: 'hard-rule' })
      } else {
        log(`L1: HARD-RULE 但状态冷却中, 跳过重复唤醒 (fp=${JSON.stringify(fp)})`)
      }
      return
    }
    // SemIf 边界
    try {
      const d = await semifDecide(state)
      log(`L1: SemIf winning=${d.winning} pYes=${d.pYes.toFixed(3)}`)
      if (d.pYes >= cfg.l1.threshold) {
        if (contentChanged(fp)) {
          await wakeL2(`磁盘可用 ${disk?.availableGB}GB / 使用率 ${disk?.usedPct}% (SemIf pYes=${d.pYes.toFixed(2)})`)
          saveLastWake({ fp, at: Date.now(), reason: 'semif' })
        } else {
          log(`L1: SemIf 触发但状态冷却中, 跳过重复唤醒`)
        }
      }
    } catch (e) { log(`L1 SemIf fail: ${e.message}`) }
  }

  // ---------- 启动 ----------
  collectOnce().catch(() => {})
  const t0 = setInterval(() => collectOnce().catch(e => log(`L0 err: ${e.message}`)), cfg.l0.intervalMs)
  const t1 = setInterval(() => decideOnce().catch(e => log(`L1 err: ${e.message}`)), cfg.l1.intervalMs)
  t0.unref?.(); t1.unref?.()
  // cordis effect(setup): 立即调用 setup, 其返回值才是 dispose 回调 (照 ds-bot 惯例双箭头)
  try { ctx.effect(() => () => { clearInterval(t0); clearInterval(t1) }, 'layered-agent: L0/L1 timers') } catch {}

  log(`layered-agent installed: L0=${cfg.l0.intervalMs}ms L1=${cfg.l1.intervalMs}ms target="${cfg.l1.targetBot}"`)
  return { collectOnce, decideOnce, wakeL2 }
}
