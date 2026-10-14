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
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync, statSync, cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { loadavg } from 'node:os'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------- 配置 (可通过 profile patch 覆盖: layered-agent: {...}) ----------
const DEFAULTS = {
  enabled: true,
  statePath: join(process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh'), 'bot', 'state.json'),
  l0: {
    intervalMs: 60_000,
    // 采集源在配置层决定(profile patch l0.sources), 插件默认最小; 可用: disk/cpu/uptime/mail/自写脚本源
    sources: ['disk'],
    // 统一目录: 数据源工作区根 — collectors/ 脚本、facts/ 数据、manifest/状态全在此之下
    homeDir: process.env.LAYERED_HOME || join(process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), 'bot', 'layered-agent'),
    // storeDir / collectorsDir 由 homeDir 派生 (若显式传则优先)
  },
  l1: {
    intervalMs: 60_000,
    threshold: 0.8,
    targets: ['disk'],        // 启用的监控目标 (对应 TARGETS 注册表)
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
  // 统一目录派生: 默认 homeDir/facts, homeDir/collectors; 显式传 storeDir/collectorsDir 优先
  cfg.l0.homeDir ||= join(process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), 'bot', 'layered-agent')
  cfg.l0.storeDir ||= process.env.LAYERED_FACT_DIR || join(cfg.l0.homeDir, 'facts')
  cfg.l0.collectorsDir ||= process.env.LAYERED_COLLECTORS_DIR || join(cfg.l0.homeDir, 'collectors')
  cfg.l0.logFile = join(cfg.l0.homeDir, 'layered-agent.log')
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
  // 统一目录工作区根
  try { mkdirSync(cfg.l0.homeDir, { recursive: true }) } catch {}
  try { mkdirSync(cfg.l0.storeDir, { recursive: true }) } catch {}
  try { mkdirSync(cfg.l0.collectorsDir, { recursive: true }) } catch {}
  const logFile = cfg.l0.logFile
  const log = (m) => {
    const line = `[${new Date().toISOString()}] ${m}`
    try { appendFileSync(logFile, line + '\n') } catch {}
    try { ctx.logger?.info?.(line) } catch {}
  }
  // 迁移: 旧版 layed-facts/ (旧默认 storeDir) → 新统一目录 homeDir/facts
  try {
    const legacyStore = join(process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), 'bot', 'layered-facts')
    if (legacyStore !== cfg.l0.storeDir && existsSync(legacyStore) && !existsSync(join(cfg.l0.storeDir, 'disk'))) {
      for (const item of readdirSync(legacyStore)) {
        try { cpSync(join(legacyStore, item), join(cfg.l0.storeDir, item), { recursive: true, force: true }) } catch {}
      }
      log(`L0: migrated legacy ${legacyStore} → ${cfg.l0.storeDir}`)
    }
  } catch (e) { log(`migrate legacy store fail: ${e.message}`) }
  // 种子脚本: 插件包内置 collectors/ → 统一目录 collectors/ (仅当缺失)
  try {
    const pkgCollectors = join(__dirname, 'collectors')
    if (existsSync(pkgCollectors)) {
      for (const f of readdirSync(pkgCollectors)) {
        if (!existsSync(join(cfg.l0.collectorsDir, f))) {
          try { cpSync(join(pkgCollectors, f), join(cfg.l0.collectorsDir, f)) } catch {}
        }
      }
    }
  } catch (e) { log(`seed collectors fail: ${e.message}`) }

  // 自动部署 skill: 仓库 skill/<name>/ 的 SKILL.md → agent skills 目录 (~/.agents/skills/<name>/)
  // 这样插件安装/每次启动时 skill 自动就位, 且随插件代码版本更新 (幂等: 目标存在且内容一致则跳过)
  try {
    const pkgSkills = join(__dirname, 'skill')
    const skillsRoot = process.env.AGENTS_SKILLS_DIR || join(process.env.HOME || '', '.agents', 'skills')
    if (existsSync(pkgSkills)) {
      for (const skillName of readdirSync(pkgSkills)) {
        const srcSkill = join(pkgSkills, skillName, 'SKILL.md')
        if (!existsSync(srcSkill)) continue
        const dstSkill = join(skillsRoot, skillName, 'SKILL.md')
        try {
          mkdirSync(join(skillsRoot, skillName), { recursive: true })
          const needCopy = !existsSync(dstSkill) ||
            (existsSync(dstSkill) && readFileSync(dstSkill, 'utf8') !== readFileSync(srcSkill, 'utf8'))
          if (needCopy) { cpSync(srcSkill, dstSkill); log(`skill deployed: ${skillName} → ${dstSkill}`) }
        } catch (e) { log(`skill deploy ${skillName} fail: ${e.message}`) }
      }
    }
  } catch (e) { log(`deploy skills fail: ${e.message}`) }

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
      // text 由 target.render 产出完整结构化通知; 这里不再加前缀 (原 'detected' 前缀已移入 render)
      const text = summary
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

  // ---------- L0: 数据源采集 (内置 builtin + 自动扫描的脚本源) ----------
  // collector 契约:
  //   - builtin: { builtin: async () => [facts...] }   JS 内联实现 (稳定/低延迟源)
  //   - script:  { cmd: 'path/to/script.sh' }          外部脚本, stdout 每行一个 JSON fact
  // fact 形如 { source?, metric, raw, meta? }; source 缺省用源名; ts 缺省由 collectOnce 补
  //
  // 脚本源自动发现: 插件启动时扫描 <collectorsDir> (默认插件包内 collectors/), 每个 *.sh 自动注册为源,
  // 源名 = 脚本文件名(去 .sh)。加一个脚本源 = 丢脚本到此目录 + 配置 l0.sources 启用, 无需改插件代码。
  // 可选命名 companion 文件 <script>.env.json 提供该脚本源的 {intervalMs, env} 覆盖。
  const collectorsDir = cfg.l0.collectorsDir ?? join(__dirname, 'collectors')
  const BUILTIN_SOURCES = {
    disk: {
      builtin: async () => {
        const { stdout } = await execFileP('df', ['-k', '/System/Volumes/Data'])
        const line = stdout.trim().split('\n')[1]?.trim().split(/\s+/)
        if (!line) return []
        const [, totalKb, usedKb, availKb] = line.map(Number)
        return [{
          source: 'disk', metric: 'data-volume',
          raw: {
            availableGB: +(availKb / 1048576).toFixed(2),
            usedPct: Math.round((usedKb / totalKb) * 100),
            totalGB: +(totalKb / 1048576).toFixed(2),
            usedGB: +(usedKb / 1048576).toFixed(2),
          },
          meta: { volume: '/System/Volumes/Data' },
        }]
      },
    },
    cpu: {
      builtin: async () => {
        const { stdout } = await execFileP('ps', ['-A', '-o', '%cpu='])
        const procs = stdout.trim().split('\n').map(Number).filter(n => Number.isFinite(n))
        const load1 = Math.round(loadavg()[0] * 100) / 100
        const top = procs.slice().sort((a, b) => b - a)[0] ?? 0
        return [{
          source: 'cpu', metric: 'load',
          raw: { load1, procCount: procs.length, topProcCpu: Math.round(top * 100) / 100 },
          meta: { scope: 'host' },
        }]
      },
    },
  }
  // 扫描脚本源: <collectorsDir>/<name>.sh → source "<name>"
  //   可选 <name>.env.json    → {intervalMs,env,timeoutMs} 覆盖运行参数
  //   可选 <name>.schema.json → 自描述字段, 进 manifest 供 L2 发现 (加源无需改插件代码)
  const SCRIPT_SOURCES = {}
  const SCRIPT_SCHEMAS = {}
  try {
    if (existsSync(collectorsDir)) {
      for (const f of readdirSync(collectorsDir)) {
        if (!f.endsWith('.sh')) continue
        const name = f.slice(0, -3)
        const def = { cmd: join(collectorsDir, f), intervalMs: cfg.l0.scriptIntervalMs ?? 60_000 }
        const envFile = join(collectorsDir, `${name}.env.json`)
        if (existsSync(envFile)) {
          try { Object.assign(def, JSON.parse(readFileSync(envFile, 'utf8'))) } catch (e) { log(`collector env ${envFile} parse fail: ${e.message}`) }
        }
        const schemaFile = join(collectorsDir, `${name}.schema.json`)
        if (existsSync(schemaFile)) {
          try { SCRIPT_SCHEMAS[name] = JSON.parse(readFileSync(schemaFile, 'utf8')) } catch (e) { log(`collector schema ${schemaFile} parse fail: ${e.message}`) }
        }
        SCRIPT_SOURCES[name] = def
      }
    }
  } catch (e) { log(`scan collectors fail: ${e.message}`) }
  const SOURCES = { ...BUILTIN_SOURCES, ...SCRIPT_SOURCES }
  if (Object.keys(SCRIPT_SOURCES).length) log(`L0: auto-discovered script sources: [${Object.keys(SCRIPT_SOURCES).join(',')}]`)


  // ---------- L0: 序列化存储 (JSONL, 按 source 隔离) ----------
  // 结构: <storeDir>/<source>/<YYYY-MM-DD>.jsonl — 各源独立目录, 便于读隔离/独立保留策略/敏感源(diff 权限)
  // 启动时迁移: 旧 root 混合文件 (*.jsonl) 按 source 拆分进各自子目录
  function migrateLegacyStore() {
    try {
      const rootFiles = existsSync(cfg.l0.storeDir) ? readdirSync(cfg.l0.storeDir).filter(f => f.endsWith('.jsonl')) : []
      for (const f of rootFiles) {
        const lines = readFileSync(join(cfg.l0.storeDir, f), 'utf8').split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const o = JSON.parse(line)
            const srcDir = join(cfg.l0.storeDir, o.source || 'unknown')
            mkdirSync(srcDir, { recursive: true })
            appendFileSync(join(srcDir, f), line + '\n')
          } catch {}
        }
        // 迁移后删除旧混合文件 (仅当确实写入了子目录)
        unlinkSync(join(cfg.l0.storeDir, f))
        log(`L0: migrated legacy ${f} → per-source dirs`)
      }
    } catch (e) { log(`migrate legacy fail: ${e.message}`) }
  }
  migrateLegacyStore()

  let factCounter = 0
  function appendFact(fact) {
    const date = new Date(fact.ts).toISOString().slice(0, 10)
    const srcDir = join(cfg.l0.storeDir, fact.source || 'unknown')
    try { mkdirSync(srcDir, { recursive: true }) } catch {}
    const file = join(srcDir, `${date}.jsonl`)
    const row = { id: `fact-${randomUUID().slice(0, 8)}`, seq: ++factCounter, ...fact, ...(fact.raw ? { raw: fact.raw } : {}) }
    appendFileSync(file, JSON.stringify(row) + '\n')
    return row
  }

  // ---------- L0: 自描述 manifest (让 L2 自主发现/访问 L0) ----------
  // 职责边界: 配置(启用哪些源)在 cordis.patch.yml 声明; manifest 只是 L0 的【发现层】——
  // 列出可用源与 schema, 供 L2 知道"能查什么、怎么查"。不镜像配置状态(enabled 不属于这里)。
  function writeManifest() {
    try {
      const sourceSchema = {
        disk:  { metric: 'data-volume', fields: { availableGB: '可用GB', usedPct: '使用率%', totalGB: '总量GB', usedGB: '已用GB' } },
        cpu:   { metric: 'load', fields: { load1: '1分钟负载', procCount: '进程数', topProcCpu: '最高进程CPU%' } },
        uptime:{ metric: 'uptime', fields: { seconds: '运行秒数', sinceBoot: '开机epoch' } },
        net:   { metric: 'traffic', fields: { iface: '接口', inBytes: '收字节累计', outBytes: '发字节累计' } },
        mail:  { metric: 'new-email', fields: { id: '邮件id', timeMs: '时间', subject: '标题', from: '发件人', labels: '标签' } },
      }
      const schema = {
        fact: {
          layout: '<storeDir>/<source>/<YYYY-MM-DD>.jsonl', eachLine: 'JSON 对象',
          fields: { id: 'string', seq: 'number(处理顺序)', ts: 'epoch ms', source: 'string(数据源)', metric: 'string', raw: 'object(源原始值)', meta: 'object(可选)' },
        },
        // 可用源及其 schema (发现层; 是否启用见配置, 不在此)
        // builtin 源用内联表; 脚本源优先读 <name>.schema.json 自描述, 否则 null
        sources: Object.keys(SOURCES).map(src => ({ source: src, type: SOURCES[src].builtin ? 'builtin' : 'script', schema: sourceSchema[src] ?? SCRIPT_SCHEMAS[src] ?? null })),
        cursorPath: join(dirname(cfg.l0.storeDir), 'cursor.json'),
        lastWakePath: join(dirname(cfg.l0.storeDir), 'last-wake.json'),
        queryTips: [
          'list sources: ls <storeDir>/',
          'source disk: tail -1 <storeDir>/disk/{today}.jsonl',
          'source mail: tail -1 <storeDir>/mail/{today}.jsonl',
          'timeline: cat <storeDir>/*/*.jsonl',
        ],
      }
      writeFileSync(join(cfg.l0.storeDir, 'manifest.json'), JSON.stringify({ updatedAt: Date.now(), storeDir: cfg.l0.storeDir, schema }, null, 2))
    } catch (e) { log(`manifest write fail: ${e.message}`) }
  }
  writeManifest()

  async function collectOnce() {
    const ts = Date.now()
    let count = 0
    for (const src of cfg.l0.sources) {
      const c = SOURCES[src]
      if (!c) continue
      try {
        let rows
        if (c.builtin) {
          rows = await c.builtin()
        } else if (c.cmd) {
          rows = await runScriptCollector(c, src)
        } else { continue }
        for (const r of rows) appendFact({ ts, ...r })
        count += rows.length
      } catch (e) { log(`L0 ${src} failed: ${e.message}`) }
    }
    if (count) log(`L0: +${count} fact(s)`)
    return count
  }

  // 脚本驱动的 collector: 运行 cmd, 解析 stdout 每行一个 JSON fact
  // 用 bash -c 执行, 并注入 IM 内部 CA 证书与完整 PATH (helper/内部 API 依赖, 否则 TLS 失败)
  async function runScriptCollector(c, src) {
    const baseEnv = {
      ...process.env,
      LAYERED_HOME: cfg.l0.homeDir,   // 统一目录, 供脚本源定位状态文件等
      PATH: `/usr/local/bin:/opt/homebrew/bin:/bin:/usr/bin:/sbin:/usr/sbin:${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}`,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE || join(process.env.HOME || '', '.ca_bundle.pem'),
      CURL_CA_BUNDLE: process.env.CURL_CA_BUNDLE || join(process.env.HOME || '', '.ca_bundle.pem'),
      REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE || join(process.env.HOME || '', '.ca_bundle.pem'),
      ...(c.env ?? {}),
    }
    const { stdout } = await execFileP('/bin/bash', [c.cmd], { timeout: (c.timeoutMs ?? 20_000), env: baseEnv })
    const rows = []
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t)
        rows.push({ source: o.source ?? src, metric: o.metric ?? 'default', ...(o.raw !== undefined ? { raw: o.raw } : {}), ...(o.meta ? { meta: o.meta } : {}) })
      } catch { /* 忽略非 JSON 行 */ }
    }
    return rows
  }

  // ---------- L1: 增量读事实 (持久化游标 cursor.json, 跨重启不重读历史) ----------
  // 游标按 source 隔离: cursor = { <source>: { file, line } } — 各源独立消费位置
  const cursorPath = join(dirname(cfg.l0.storeDir), 'cursor.json')
  let cursor = {}
  try { if (existsSync(cursorPath)) cursor = JSON.parse(readFileSync(cursorPath, 'utf8')) ?? {} } catch (e) { log(`cursor read fail: ${e.message}`) }
  function saveCursor() { try { writeFileSync(cursorPath, JSON.stringify(cursor)) } catch (e) { log(`cursor write fail: ${e.message}`) } }

  // 返回 (facts, 新游标位置)。只读游标之后的新事实; 不修改游标 (由调用方在决策后 advanceCursor)
  // 存储: <storeDir>/<source>/<date>.jsonl — 按源子目录遍历
  function readNewFacts() {
    const out = []
    const dir = cfg.l0.storeDir
    let nextSrc = null, nextFile = null, nextLine = 0
    try {
      const srcDirs = (existsSync(dir) ? readdirSync(dir) : []).filter(d => {
        try { if (d === 'manifest.json') return false; return statSync(join(dir, d)).isDirectory() } catch { return false }
      }).sort()
      for (const src of srcDirs) {
        const srcCursor = cursor[src] ?? { file: null, line: 0 }
        const files = readdirSync(join(dir, src)).filter(f => f.endsWith('.jsonl')).sort()
        for (const f of files) {
          if (srcCursor.file && f < srcCursor.file) continue
          const startIdx = (srcCursor.file === f) ? srcCursor.line : 0
          const lines = readFileSync(join(dir, src, f), 'utf8').split('\n').filter(Boolean)
          for (let i = startIdx; i < lines.length; i++) {
            let o; try { o = JSON.parse(lines[i]) } catch { continue }
            out.push(o)
            nextSrc = src; nextFile = f; nextLine = i + 1
          }
        }
      }
    } catch (e) { log(`L1 read fail: ${e.message}`) }
    return { facts: out.slice(-100), nextSrc, nextFile, nextLine }
  }
  function advanceCursor(nextSrc, nextFile, nextLine) {
    if (!nextSrc || !nextFile) return
    const prev = cursor[nextSrc] ?? { file: null, line: 0 }
    cursor[nextSrc] = { file: nextFile, line: Math.max(prev.file === nextFile ? prev.line : 0, nextLine) }
    saveCursor()
  }

  // ---------- L1: SemIf 调用 (通用; question/options 由 target 提供) ----------
  async function semifDecide(state, question, options) {
    const runScore = join(cfg.semif.skillDir, 'scripts', 'run_score.sh')
    const work = join(cfg.l0.storeDir, '..', 'work')
    try { mkdirSync(work, { recursive: true }) } catch {}
    const inp = join(work, `dec-${process.pid}.jsonl`)
    const out = join(work, `res-${process.pid}.jsonl`)
    for (const f of [out, out.replace(/\.jsonl$/, '.summary.md')]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
    const row = {
      id: 'l1',
      state,
      question,
      options,
    }
    writeFileSync(inp, JSON.stringify(row) + '\n')
    await execFileP('bash', [runScore, '--input', inp, '--output', out, '--offline'], { timeout: 120_000 })
    const res = JSON.parse(readFileSync(out, 'utf8').trim().split('\n').pop())
    const ids = res.option_ids, probs = res.probabilities
    const p = {}; ids.forEach((id, i) => { p[id] = probs[i] })
    return { winning: ids[probs.indexOf(Math.max(...probs))], pYes: p.yes ?? 0 }
  }

  // ---------- L1: 目标化决策框架 (v2) ----------
  // 每个 target 是自包含的决策闭环: collect(组装context) → interim(硬规则) → semif(本地模型) → wake(通知)
  // L2 通知自包含 target collect 产出的 context → L2 无状态可决策
  const TARGETS = {
    disk: {
      name: '磁盘存储',
      // ① 收集器: 该 target 作为"决策 context"的所有数据都在这组装 (含趋势, 供 L2 无状态决策)
      collect: async (facts) => {
        const diskFacts = facts.filter(f => f.source === 'disk')
        const latest = diskFacts[diskFacts.length - 1]?.raw
        if (!latest) return null
        // 趋势: 取窗口内前后对比 (fact 按 ts 排序, 取第一个和最后一个)
        const first = diskFacts[0]?.raw
        const trend = first && first.availableGB !== undefined
          ? { deltaGB: Math.round((latest.availableGB - first.availableGB) * 10) / 10, windowFacts: diskFacts.length }
          : null
        return {
          kind: 'disk',
          current: { availableGB: latest.availableGB, usedPct: latest.usedPct, totalGB: latest.totalGB, usedGB: latest.usedGB },
          trend,
          policy: { lowAvailableGB: cfg.l1.hardRule.lowAvailableGB, highUsedPct: cfg.l1.hardRule.highUsedPct },
        }
      },
      // ② 硬规则预筛: 明确超阈值直接触发 (还可给 SemIf 提供明确的上下文)
      interim: (ctx) => ctx && ctx.current &&
        (ctx.current.availableGB < cfg.l1.hardRule.lowAvailableGB || ctx.current.usedPct > cfg.l1.hardRule.highUsedPct),
      // ③ SemIf 专属配置
      semif: {
        question: '仅当磁盘可用空间紧张、使用率过高、或出现明确异常时选 yes 需要唤醒 L2 处理。若一切正常或轻微波动选 no; 数据不足选 insufficient。',
        options: [
          { id: 'yes', description: '需要唤醒 L2。存在明确需决策的异常。' },
          { id: 'no', description: '无需唤醒 L2。空间充足或轻微波动。' },
          { id: 'insufficient', description: '数据不足, 无法判断。' },
        ],
      },
      // ④ 通知渲染: 把 target 的完整 context 渲染成 L2 可无状态决策的结构化文本
      //    末尾带 L0 入口指引 → L2 读 manifest.json 即可自主发现 L0 (主动推理)
      render: (ctx, extra) => {
        const c = ctx.current
        const t = ctx.trend
        return [
          `[分层智能体·L1·磁盘存储] 检测到需关注事件`,
          `状态: 可用 ${c.availableGB}GB / 已用 ${c.usedGB}GB (${c.usedPct}%) / 总量 ${c.totalGB}GB`,
          ...(t ? [`趋势: 窗口${t.windowFacts}条采样内变化 Δ${t.deltaGB >= 0 ? '+' : ''}${t.deltaGB}GB`] : []),
          `阈值: 可用<${ctx.policy.lowAvailableGB}GB 或 使用率>${ctx.policy.highUsedPct}%`,
          ...(extra ? [extra] : []),
          `请评估并决策是否需要处理(如可清理缓存则执行)。需要更多数据时, L0 数据源入口: ${cfg.l0.storeDir}/manifest.json`,
        ].join('\n')
      },
    },
  }

  // 目标指纹 + 冷却去重 (跨 target 各自独立)
  // lastWake 记录上次唤醒的"状态指纹+时间", 同状态或冷却期内不重复唤醒 → L2 无状态可行
  const lastWakePath = join(dirname(cfg.l0.storeDir), 'last-wake.json')
  let lastWake = {}
  try { if (existsSync(lastWakePath)) lastWake = JSON.parse(readFileSync(lastWakePath, 'utf8')) ?? {} } catch (e) { log(`last-wake read fail: ${e.message}`) }
  function saveLastWake(w) { lastWake = w; try { writeFileSync(lastWakePath, JSON.stringify(w)) } catch (e) { log(`last-wake write fail: ${e.message}`) } }
  function stateFingerprint(targetKey, ctx) {
    const c = ctx?.current
    if (!c) return null
    if (targetKey === 'disk') return { availBucket: Math.round((c.availableGB ?? 0) / 5), usedBucket: Math.round((c.usedPct ?? 0) / 5) }
    return null
  }
  function contentChanged(targetKey, fp) {
    const last = lastWake[targetKey]
    if (!last || !last.fp) return true                     // 该 target 无上次 → 视为新
    if (fp && last.fp && (last.fp.availBucket !== fp.availBucket || last.fp.usedBucket !== fp.usedBucket)) return true  // 状态显著变化 → 新
    const cooldownMs = cfg.l1.cooldownMs ?? 30 * 60 * 1000
    if (Date.now() - (last.at ?? 0) < cooldownMs) return false
    return true                                             // 同状态但超过冷却期 → 重新关注
  }

  const activeTargets = Object.keys(TARGETS).filter(k => (cfg.l1.targets ?? ['disk']).includes(k))

  async function decideOnce() {
    // 测试钩子: wake-test 标记 → 强制唤醒 (端到端验证; 走真实 disk target.render 产出结构化通知)
    try {
      const marker = join(dirname(cfg.l0.storeDir), 'wake-test')
      if (existsSync(marker)) {
        unlinkSync(marker)
        log('L1: TEST-WAKE marker → forcing wakeL2 (via disk.render)')
        // 读最新 disk 事实组装 context, 用真实 render 生成结构化通知
        const { facts } = readNewFacts()
        const diskTarget = TARGETS.disk
        const ctx = await diskTarget.collect(facts)
        if (ctx) { await wakeL2(diskTarget.render(ctx, '(测试触发)')) }
        else { await wakeL2('端到端投递测试 (wake-test 标记触发, 无disk上下文)') }
        return
      }
    } catch (e) { log(`TEST-WAKE error: ${e.message}`) }
    const { facts, nextSrc, nextFile, nextLine } = readNewFacts()
    if (!facts.length) return
    // 无论要不要唤醒, 都推进游标 (已消费这些事实)
    advanceCursor(nextSrc, nextFile, nextLine)
    for (const targetKey of activeTargets) {
      const target = TARGETS[targetKey]
      try {
        const ctx = await target.collect(facts)
        if (!ctx) continue
        const fp = stateFingerprint(targetKey, ctx)
        // 硬规则先决 (target 专属)
        if (target.interim?.(ctx)) {
          if (contentChanged(targetKey, fp)) {
            log(`L1[${targetKey}]: HARD-RULE trigger`)
            await wakeL2(target.render(ctx, '(硬规则触发)'))
            saveLastWake({ ...(lastWake), [targetKey]: { fp, at: Date.now(), reason: 'hard-rule' } })
          } else {
            log(`L1[${targetKey}]: HARD-RULE 但状态冷却中, 跳过重复唤醒`)
          }
          continue
        }
        // SemIf 边界 (target 专属 question)
        const state = {
          since: facts[0]?.ts ?? Date.now(),
          count: facts.length,
          ...ctx,
        }
        const d = await semifDecide(state, target.semif.question, target.semif.options)
        log(`L1[${targetKey}]: SemIf winning=${d.winning} pYes=${d.pYes.toFixed(3)}`)
        if (d.pYes >= cfg.l1.threshold) {
          if (contentChanged(targetKey, fp)) {
            await wakeL2(target.render(ctx, `(SemIf pYes=${d.pYes.toFixed(2)})`))
            saveLastWake({ ...(lastWake), [targetKey]: { fp, at: Date.now(), reason: 'semif' } })
          } else {
            log(`L1[${targetKey}]: SemIf 触发但状态冷却中, 跳过重复唤醒`)
          }
        }
      } catch (e) { log(`L1[${targetKey}] error: ${e.message}`) }
    }
  }

  // ---------- 启动 ----------
  collectOnce().catch(() => {})
  const t0 = setInterval(() => collectOnce().catch(e => log(`L0 err: ${e.message}`)), cfg.l0.intervalMs)
  const t1 = setInterval(() => decideOnce().catch(e => log(`L1 err: ${e.message}`)), cfg.l1.intervalMs)
  t0.unref?.(); t1.unref?.()
  // cordis effect(setup): 立即调用 setup, 其返回值才是 dispose 回调 (照 ds-bot 惯例双箭头)
  try { ctx.effect(() => () => { clearInterval(t0); clearInterval(t1) }, 'layered-agent: L0/L1 timers') } catch {}

  log(`layered-agent installed: L0=${cfg.l0.intervalMs}ms L1=${cfg.l1.intervalMs}ms target="${cfg.l1.targetBot}" sources=[${cfg.l0.sources.join(',')}]`)
  return { collectOnce, decideOnce, wakeL2 }
}
