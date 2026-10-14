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
    targetBot: '存储专家',
    escalateToChief: true,
    chiefBot: 'Chief',
  },
  semif: {
    skillDir: join(process.env.HOME || '', '.agents', 'skills', 'semif-decide'),
  },
}

export const name = 'ds-bot-layered-agent'

// 兄弟插件需要的 DSH 服务 (只依赖 schedule; sessionController/sessions 仅在有时代码路径使用, 不在 inject 硬依赖)
export const inject = ['schedule']

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

  const scheduleSvc = () => {
    // DSH schedule 服务
    try { return ctx.get?.('schedule') ?? ctx.schedule } catch { return undefined }
  }

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

  // ---------- L2 唤醒: 经 schedule 服务投递消息给目标 session ----------
  async function wakeL2(summary) {
    const targetName = cfg.l1.targetBot
    const sessionId = botSessionId(targetName)
    if (!sessionId) { log(`L2 wake failed: no session for "${targetName}"`); return }
    const prompt = `[分层智能体·L1] 检测到需关注事件：${summary}\n请评估并决策是否需要处理(如可清理缓存则执行)。`
    const svc = scheduleSvc()
    if (!svc?.create) { log('L2 wake failed: schedule service unavailable'); return }
    try {
      await svc.create(sessionId, {
        title: `分层智能体唤醒-${Date.now()}`,
        prompt,
        after: { seconds: 0 }, // 立即 (DSH 支持 after)
      })
      log(`L2: woken "${targetName}" (${sessionId}) via schedule`)
    } catch (e) {
      log(`L2 wake via schedule failed: ${e.message}`)
      // 回退: 直接尝试 sessionController
      try {
        const sc = ctx.get?.('sessionController')
        if (sc?.deliver) await sc.deliver(sessionId, prompt)
        else log('no sessionController fallback deliver')
      } catch (e2) { log(`L2 fallback failed: ${e2.message}`) }
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

  // ---------- L1: 读新事实 (seq 指针仅进程内; 演进期不做持久去重) ----------
  let lastSeq = 0
  function readNewFacts() {
    const out = []
    const dir = cfg.l0.storeDir
    try {
      const files = (existsSync(dir) ? readdirSync(dir) : []).filter(f => f.endsWith('.jsonl')).sort()
      for (const f of files) {
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
          let o; try { o = JSON.parse(line) } catch { continue }
          if (o.seq && o.seq <= lastSeq) continue
          if (o.seq) lastSeq = o.seq
          out.push(o)
        }
      }
    } catch (e) { log(`L1 read fail: ${e.message}`) }
    return out.slice(-50)
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

  // ---------- L1: 决策 ----------
  async function decideOnce() {
    const facts = readNewFacts()
    if (!facts.length) return
    const disk = facts.filter(f => f.source === 'disk').slice(-1)[0]?.raw
    const state = {
      since: facts[0]?.ts ?? Date.now(),
      count: facts.length,
      disk,
      policy: `可用空间低于${cfg.l1.hardRule.lowAvailableGB}GB 或使用率高于${cfg.l1.hardRule.highUsedPct}% 视为需要关注`,
    }
    // 硬规则先决
    if (disk && (disk.availableGB < cfg.l1.hardRule.lowAvailableGB || disk.usedPct > cfg.l1.hardRule.highUsedPct)) {
      const summary = `磁盘可用 ${disk.availableGB}GB / 使用率 ${disk.usedPct}% (硬规则触发)`
      log(`L1: HARD-RULE -> ${summary}`)
      await wakeL2(summary)
      return
    }
    // SemIf 边界
    try {
      const d = await semifDecide(state)
      log(`L1: SemIf winning=${d.winning} pYes=${d.pYes.toFixed(3)}`)
      if (d.pYes >= cfg.l1.threshold) await wakeL2(`磁盘可用 ${disk?.availableGB}GB / 使用率 ${disk?.usedPct}% (SemIf pYes=${d.pYes.toFixed(2)})`)
    } catch (e) { log(`L1 SemIf fail: ${e.message}`) }
  }

  // ---------- 启动 ----------
  collectOnce().catch(() => {})
  const t0 = setInterval(() => collectOnce().catch(e => log(`L0 err: ${e.message}`)), cfg.l0.intervalMs)
  const t1 = setInterval(() => decideOnce().catch(e => log(`L1 err: ${e.message}`)), cfg.l1.intervalMs)
  try { ctx.effect(() => { clearInterval(t0); clearInterval(t1) }) } catch {}

  log(`layered-agent installed: L0=${cfg.l0.intervalMs}ms L1=${cfg.l1.intervalMs}ms target="${cfg.l1.targetBot}"`)
  return { collectOnce, decideOnce, wakeL2 }
}
