// Layered Agent — cordis sibling plugin to ds-bot (zero modification to ds-bot).
//
// 分层智能体 (你的架构):
//   L0 事实序列化层: 轮询数据源(程序), 带时间戳/来源序列化存储 facts/
//   L1 SemIf 决策层: 轮询新事实, 硬规则先决 + SemIf 本地模型裁决边界
//   L2 推理层: 被 L1 唤醒(事件驱动, 不轮询) — 通过 DSH schedule 服务投递消息给目标 Bot session
//
// 共存: 独立 cordis 插件, patch: cordis.patch.yml -> insert: { id: dsh-reflex }.
//   不修改原版 ds-bot 任何代码; 通过 ctx.get('schedule') + 读 bot state.json 定位目标会话。

import { join, dirname } from 'node:path'
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync, statSync, cpSync, chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import Schema from '@deepseek-ai/schemastery'
import { promisify, format } from 'node:util'
import { randomUUID } from 'node:crypto'
import { loadavg } from 'node:os'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------- 配置 (可通过 profile patch 覆盖: dsh-reflex: {...}) ----------
/** DSH 主目录。原先各处内联重复了三遍, 这里统一 —— 也是默认凭据文件位置的基准。 */
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')

const DEFAULTS = {
  enabled: true,
  statePath: join(DSH_HOME, 'bot', 'state.json'),
  l0: {
    intervalMs: 60_000,
    // 采集源在配置层决定(profile patch l0.sources), 插件默认最小; 可用: disk/cpu/uptime/mail/自写脚本源
    sources: ['disk'],
    // 统一目录: 数据源工作区根 — collectors/ 脚本、facts/ 数据、manifest/状态全在此之下
    homeDir: process.env.REFLEX_HOME || join(DSH_HOME, 'dsh-reflex'),
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
    // 安静时段: 此区间内【内容类】target 的命中不打扰, 攒进 pending, 到点合并成一条摘要。
    // 硬规则 target(磁盘) 通过 interruptAlways 穿透。null = 不启用。
    quietHours: null,            // 例: { from: '18:00', to: '09:00' }
    // 用户画像: 内容类 target(如 feed-timeline)组装 SemIf 决策 context 用 —— 建议在 profile patch 里覆盖
    profile: '',
    // 内容类 target 的参数现在归 target 自己的 env.json 管 (targets/<name>.env.json 的 env 段),
    // 例如 feed-timeline 的阈值/候选数走 REFLEX_X_THRESHOLD / REFLEX_X_MAX_CANDIDATES。
    // 唤醒闸门缺省跟随该源采集间隔, 见 ALL_TARGETS 里的 minIntervalMs。
  },
  semif: {
    skillDir: join(process.env.HOME || '', '.agents', 'skills', 'semif-decide'),
  },
  // 判定调优工具 (shadow/回放/拟合/策略): 随插件 skill 分发, 由 install() 自动部署。
  // target 通过注入的 REFLEX_TUNING_DIR 引用, 不在运行目录放副本 (DATASOURCE.md §0)。
  tuning: {
    skillDir: join(process.env.HOME || '', '.agents', 'skills', 'reflex-tuning', 'scripts'),
  },
  // 决策后端: L1 的判定由谁打分。三种后端同构(见 tools/semif-adapt.py):
  //   semif    本地 MLX 读答案槽 logits (默认, 不联网)
  //   jev      TypeSafe 托管 POST /v1/systemone (联网, 内容会离开本机)
  //   jevlocal 本地同款线格式, 端点由 jevBaseUrl 指向
  // 决策后端(与 Config schema 的顶层字段一一对应, 见上方注释)
  backend: '',
  jevBaseUrl: 'https://api.typesafe.ai',
  jevModel: 'jev-latest',
  credentialsFile: join(DSH_HOME, '.credentials.yaml'),
  secretsFile: join(DSH_HOME, 'bot', 'secrets.json'),
  // 主名用 JEV_API_KEY(用户指定); 后两个是兼容既有的存量命名, 按顺序回退。
  secretAllow: ['JEV_API_KEY', 'REFLEX_JEV_API_KEY', 'TYPESAFE_API_KEY'],
}

// 子进程实现。默认就是 child_process 的 spawn —— 这里做成模块级引用
// 只是为了让测试能截获"插件递给脚本的环境变量"(密钥注入必须可验证, 不能靠读代码相信)。
let spawnImpl = spawn
export function __setSpawnForTest(fn) { spawnImpl = fn }

// ---------- 配置 schema ----------
// 作用有两个:
//   1. DSH 据此"服务"这个配置 —— 插件面板里才会出现本插件的配置页
//   2. 面板按字段渲染表单(标签/说明), 所以 decide 段逐字段声明
//
// ⚠️ 只声明 decide, 其余用 Schema.any() 透传 —— 这是【验证过的】选择, 不是省事:
//    实测(见提交说明)本版本 schemastery 不会丢弃 schema 未声明的键,
//    即便如此也不敢依赖该行为去枚举 l0/l1 的每个字段: 漏写一个就会让配置静默失效,
//    而那是最难查的一类故障(本会话已踩过多次)。
//
// ⚠️ 不要给字段加 .default(): 那会让"未配置"被填成默认值,
//    而本插件的语义是"未配置 = 不注入环境变量 = 保持既有行为"。
export const Config = Schema.object({
  // ⚠️ 字段必须在【配置根的顶层】, 不能嵌套。
  //    面板表单把字段名当作配置根下的路径写: ops=[{op:'set',path:['backend'],...}]。
  //    嵌套一层(decide.backend)会让宿主的路径校验找不到 'backend' 而抛
  //    "Config field backend is not volatile" -> mutate 未落地 -> 界面只显示
  //    "保存失败, 已保留你的输入", 且不报任何具体原因(上游 catch 丢了异常)。
  //    实测踩过: 嵌套写法下 ops 的 path 就是 ["backend"] 而不是 ["decide","backend"]。
  //
  // ⚠️ 每个字段还要 .volatile() —— 否则 settings 服务不认为它可编辑, 面板里
  //    根本不会出现表单(实测: 不标就什么都没有, 也不报错)。
  backend: Schema.string()
    .description('决策后端: 留空=semif(本地,不联网) | jev=托管(内容会离开本机) | jevlocal=本地端点')
    .default('').volatile(),
  jevBaseUrl: Schema.string()
    .description('Jev 端点。TypeSafe: https://api.typesafe.ai | OpenRouter: https://openrouter.ai/api/v1 | 本地: http://127.0.0.1:30001')
    .default('https://api.typesafe.ai').volatile(),
  jevModel: Schema.string()
    .description('Jev 模型名: jev-latest(TypeSafe) | typesafe/jev-1.13(OpenRouter)')
    .default('jev-latest').volatile(),
}).description('分层智能体: 数据源 / 判定目标 / 决策后端')
// 注: key 不在这里 —— 它走凭据域(只写不读), 见 client.js

export const name = 'dsh-reflex'

// 探明 (本地 cordis 决定性实验): module-level inject 会让 apply 延迟到服务可见才执行;
// 真实 DSH 里 schedule 服务可能不在插件可见的隔离作用域, 导致 apply 永不执行。
// ds-bot 成功路径 = inject 不声明 + 运行时 ctx.inject(['schedule'], attach) 动态子插件。
export const inject = []

export function apply(ctx, config = {}) {
  try {
    return install(rtOf(ctx), ctx, normalize(cfgOf(config)))
  } catch (e) {
    // 兄弟插件绝不拖垮宿主: 任何初始化错误都降级为记录并跳过
    try { ctx.logger?.warn?.(`[dsh-reflex] init skipped: ${e.message}`) } catch {}
    return undefined
  }
}

function cfgOf(config) {
  return config?.dshReflex ?? config ?? {}
}
function normalize(c) {
  const cfg = {
    ...DEFAULTS,
    ...c,
    l0: { ...DEFAULTS.l0, ...(c?.l0 ?? {}) },
    l1: { ...DEFAULTS.l1, ...(c?.l1 ?? {}) },
    semif: { ...DEFAULTS.semif, ...(c?.semif ?? {}) },
    tuning: { ...DEFAULTS.tuning, ...(c?.tuning ?? {}) },
    decide: { ...DEFAULTS.decide, ...(c?.decide ?? {}) },
  }
  // 统一目录派生: 默认 homeDir/facts, homeDir/collectors; 显式传 storeDir/collectorsDir 优先
  cfg.l0.homeDir ||= join(DSH_HOME, 'dsh-reflex')
  cfg.l0.storeDir ||= process.env.REFLEX_FACT_DIR || join(cfg.l0.homeDir, 'facts')
  cfg.l0.collectorsDir ||= process.env.REFLEX_COLLECTORS_DIR || join(cfg.l0.homeDir, 'collectors')
  cfg.l0.logFile = join(cfg.l0.homeDir, 'dsh-reflex.log')
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
  const log = (m, ...args) => {
    // 支持 printf 风格: 调用方写过 log('...%s...', x, y), 但旧实现只收一个参数,
    // 多余实参被静默丢掉 —— 日志里留下字面量 %s, 恰好把"哪个后端 / 去哪找 key"
    // 这类最有用的信息吞了。用 format 兜住, 以后再有 %s 调用也不会退化。
    const line = `[${new Date().toISOString()}] ${args.length ? format(m, ...args) : m}`
    try { appendFileSync(logFile, line + '\n') } catch {}
    try { ctx.logger?.info?.(line) } catch {}
  }
  // 迁移: 旧版 layed-facts/ (旧默认 storeDir) → 新统一目录 homeDir/facts
  try {
    const legacyStore = join(DSH_HOME, 'bot', 'layered-facts')
    if (legacyStore !== cfg.l0.storeDir && existsSync(legacyStore) && !existsSync(join(cfg.l0.storeDir, 'disk'))) {
      for (const item of readdirSync(legacyStore)) {
        try { cpSync(join(legacyStore, item), join(cfg.l0.storeDir, item), { recursive: true, force: true }) } catch {}
      }
      log(`L0: migrated legacy ${legacyStore} → ${cfg.l0.storeDir}`)
    }
  } catch (e) { log(`migrate legacy store fail: ${e.message}`) }
  // collectors/ 由使用者自己放在统一目录 —— 插件包【不内置】任何采集器。
  // 早期版本在包内也留一份并 seed 过来, 结果是同一脚本存在两份副本: 改了包内
  // 那份, 统一目录那份因为"已存在不覆盖"永远不更新, 插件实际跑的是旧版。
  // 采集器是使用者自己的东西(接哪些源、什么口径), 不由插件分发。

  // 自动部署 skill: 仓库 skill/<name>/ → agent skills 目录 (~/.agents/skills/<name>/)
  // 整个目录递归部署(有的 skill 带 scripts/ assets/ 边车, 只拷 SKILL.md 会装出个残废)。
  // 策略由 skill/<name>/.deploy.json 的 policy 决定:
  //   sync      (默认) 自有 skill —— 内容不同就覆盖, 随插件代码版本走
  //   seed-only 第三方 vendored —— 只在目标【整个缺失】时安装; 已存在则整体跳过。
  //             理由: 用户可能装了更新的上游版本, 不能悄悄把它降级成插件里的这份快照。
  function deploySkillDir(srcDir, dstDir) {
    let n = 0
    mkdirSync(dstDir, { recursive: true })
    for (const e of readdirSync(srcDir, { withFileTypes: true })) {
      if (e.name === '.DS_Store' || e.name === '__pycache__' || e.name === '.deploy.json') continue
      const s = join(srcDir, e.name), d = join(dstDir, e.name)
      if (e.isDirectory()) { n += deploySkillDir(s, d); continue }
      try {
        if (existsSync(d) && readFileSync(d).equals(readFileSync(s))) continue   // 内容一致不重写
        cpSync(s, d); n++
      } catch (err) { log(`skill file copy fail ${e.name}: ${err.message}`) }
    }
    return n
  }
  try {
    const pkgSkills = join(__dirname, 'skill')
    const skillsRoot = process.env.AGENTS_SKILLS_DIR || join(process.env.HOME || '', '.agents', 'skills')
    if (existsSync(pkgSkills)) {
      for (const skillName of readdirSync(pkgSkills)) {
        const srcDir = join(pkgSkills, skillName)
        if (!existsSync(join(srcDir, 'SKILL.md'))) continue
        const dstDir = join(skillsRoot, skillName)
        let policy = 'sync'
        try {
          const policyFile = join(srcDir, '.deploy.json')
          if (existsSync(policyFile)) policy = JSON.parse(readFileSync(policyFile, 'utf8')).policy ?? 'sync'
        } catch (e) { log(`skill deploy config ${skillName} parse fail: ${e.message}`) }
        if (policy === 'seed-only' && existsSync(dstDir)) {
          log(`skill ${skillName}: 已存在, 跳过 (seed-only — 不覆盖可能更新的上游版本)`)
          continue
        }
        try {
          const n = deploySkillDir(srcDir, dstDir)
          if (n) log(`skill deployed: ${skillName} (${n} 个文件) → ${dstDir}`)
        } catch (e) { log(`skill deploy ${skillName} fail: ${e.message}`) }
      }
    }
  } catch (e) { log(`deploy skills fail: ${e.message}`) }

  // ---------- 捆绑自检组件: defaults/reflex-health → 统一目录 (sync) ----------
  // 为什么收编: reflex-health 扫描的是本插件自己的日志格式("L0 x failed"/"L1[x] error"),
  // 与插件同源演进 —— 留在运行目录会随版本升级静默失配(日志改版=自检盲区, 无报错)。
  // sync 策略: 与包内不同即覆盖(旧版双副本分歧的教训由"覆盖+备份"化解)。
  // 用户本地改过时先留 .bak-user 再覆盖, 不静默丢定制。
  try {
    const healthDefaults = join(__dirname, 'defaults', 'reflex-health')
    if (existsSync(healthDefaults)) {
      let hn = 0
      for (const sub of ['collectors', 'targets']) {
        const srcDir = join(healthDefaults, sub)
        if (!existsSync(srcDir)) continue
        // cfg.l0.collectorsDir 可能未配置(:312 插件自己的读取也带同样兜底) —— 不兜底会
        // mkdirSync(undefined) 抛 TypeError 且被整个部署块的外层 catch 吞掉(2026-10-24 实测)。
        const dstDir = sub === 'collectors'
          ? (cfg.l0.collectorsDir ?? join(cfg.l0.homeDir, 'collectors'))
          : (cfg.l1.targetsDir ?? join(cfg.l0.homeDir, 'targets'))
        mkdirSync(dstDir, { recursive: true })
        for (const e of readdirSync(srcDir)) {
          // ⚠️ readdirSync 不带 withFileTypes 返回【字符串数组】, e 就是文件名本身;
          //    首版误写 e.name(Dirent 用法) → join(src, undefined) → TypeError 被 catch
          //    吞成一行日志, 部署永远失败(2026-10-24 两次重启实测, 栈回溯定位)。
          const sf = join(srcDir, e), df = join(dstDir, e)
          try {
            if (existsSync(df) && readFileSync(df).equals(readFileSync(sf))) continue
            if (existsSync(df)) { try { cpSync(df, df + '.bak-user', { force: true }) } catch {} }
            cpSync(sf, df)
            hn++
          } catch (err) { log(`health file copy fail ${e.name}: ${err.message}`) }
        }
      }
      if (hn) log(`health deployed: reflex-health (${hn} 个文件) → ${cfg.l0.homeDir}`)
    }
  } catch (e) { log(`health deploy fail: ${e.message}`) }

  // 投递服务: 用 ds-bot 同款机制 = ctx.sessionController.resolveAgent(sessionId) → agent.followup(message)
  // (schedule 服务在插件上下文不可见, 已探明; sessionController 是 ds-bot 必需服务, 对插件可见)
  let sessionCtrl = null
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionController'], (sub) => {
        sessionCtrl = sub?.sessionController
        log(`sessionController attached (${sessionCtrl ? 'ok' : 'null'})`)
        try { sub?.effect?.(() => () => { if (sessionCtrl) sessionCtrl = null }, 'dsh-reflex: sessionController') } catch {}
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
  // 返回"是否真的投出去了"。调用方必须据此决定要不要记指纹 ——
  // 投递失败还记指纹, 这条告警就被永久去重、再也发不出来(2026-10-15 20:55 实测丢过一次:
  // 插件正在重载 → sessionController unavailable → 失败却记了指纹 → 那条"有人在等你回话"消失)。
  async function wakeL2(summary) {
    try {
      const targetName = cfg.l1.targetBot
      const sessionId = botSessionId(targetName)
      if (!sessionId) { log(`L2 wake failed: no session for "${targetName}"`); return false }
      const sc = sessionCtrlSvc()
      if (!sc?.resolveAgent) { log('L2 wake failed: sessionController unavailable'); return false }
      const resolved = await sc.resolveAgent(sessionId)
      if ('error' in resolved) { log(`L2 wake failed: ${resolved.error?.message}`); return false }
      const agent = resolved.agent
      // text 由 target.render 产出完整结构化通知; 这里不再加前缀 (原 'detected' 前缀已移入 render)
      const text = summary
      const message = createUserMessageLike({
        content: [{ type: 'text', text }],
        source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: randomUUID(), senderName: '分层智能体', hop: 0 },
      })
      if (agent?.followup) agent.followup(message)
      else if (agent?.steer) agent.steer(message)
      else { log('L2 wake failed: agent has no followup/steer'); return false }
      log(`L2: woken "${targetName}" (${sessionId}) via sessionController`)
      return true
    } catch (e) {
      log(`L2 wake error: ${e.message}`)
      return false
    }
  }

  // ---------- L0: 数据源采集 (内置 builtin + 自动扫描的脚本源) ----------
  // collector 契约:
  //   - builtin: { builtin: async () => [facts...] }   JS 内联实现 (稳定/低延迟源)
  //   - script:  { cmd: 'path/to/script.sh' }          外部脚本, stdout 每行一个 JSON fact
  // fact 形如 { source?, metric, raw, meta? }; source 缺省用源名; ts 缺省由 collectOnce 补
  //
  // 脚本源自动发现: 插件启动时扫描 <collectorsDir> (默认 REFLEX_HOME/collectors/), 每个 *.sh 自动注册为源,
  // 源名 = 脚本文件名(去 .sh)。加一个脚本源 = 丢脚本到此目录 + 配置 l0.sources 启用, 无需改插件代码。
  // 可选命名 companion 文件 <script>.env.json 提供该脚本源的 {intervalMs, env} 覆盖。
  const collectorsDir = cfg.l0.collectorsDir ?? join(cfg.l0.homeDir, 'collectors')
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
  const SOURCES = { ...BUILTIN_SOURCES }   // 脚本源由 scanScriptSources() 动态并入 (可热重扫)

  function scanScriptSources() {
    // 可重入: 先清旧脚本条目再按目录现状重建 (内置源 BUILTIN_SOURCES 不受影响)。
    // 供 refreshDiscovery() 在目录变化时调用 —— 新脚本源落盘即生效, 无需重启。
    for (const k of Object.keys(SCRIPT_SOURCES)) delete SOURCES[k]
    for (const k of Object.keys(SCRIPT_SOURCES)) delete SCRIPT_SOURCES[k]
    for (const k of Object.keys(SCRIPT_SCHEMAS)) delete SCRIPT_SCHEMAS[k]
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
    Object.assign(SOURCES, SCRIPT_SOURCES)
  }
  scanScriptSources()
  if (Object.keys(SCRIPT_SOURCES).length) log(`L0: auto-discovered script sources: [${Object.keys(SCRIPT_SOURCES).join(',')}]`)

  // ---------- 脚本驱动的 L1 target ----------
  // 与 collector 同构: <targetsDir>/<name>.sh 自动注册为 target, 配置 l1.targets 启用。
  // 职责分界 —— 这是本设计的关键:
  //   脚本负责【判定 + 条目内容】: 从 stdin 拿本轮新事实 → 组装 context → 调 SemIf → 判定 → 产出条目
  //   插件负责【投递纪律】  : 指纹去重、冷却、minIntervalMs 节流、pending 累积合并、排版信封、投递
  //   信封(heading/编号/合并说明/L0入口)必须由插件排: "其中 N 条为冷却期累积"这类信息来自跨轮统计,
  //   脚本根本不知道; 而且信封对所有 target 是同一套, 复制进脚本必然漂移。
  // 契约: stdin 收到本轮新事实(JSONL); stdout 输出一行 JSON; 无输出=本轮不唤醒; 非 0 退出=记 failed
  //   { wake, reason, fingerprint, header?, scanned?, items?: [{id,title,body}] }  或 { notice } 全权模式
  const targetsDir = cfg.l1.targetsDir ?? join(cfg.l0.homeDir, 'targets')
  // targets/ 与 tools/ 同样只从统一目录读, 插件包不内置 (与 collectors 同因)。
  // 判定脚本、回执脚本这些是使用者自己的口径与渠道, 不属于插件。

  const SCRIPT_TARGETS = {}
  function scanScriptTargets() {
    // 可重入: 先清旧条目再按目录现状重建 (供 refreshDiscovery 热加载)
    for (const k of Object.keys(SCRIPT_TARGETS)) delete SCRIPT_TARGETS[k]
    try {
      if (existsSync(targetsDir)) {
        for (const f of readdirSync(targetsDir)) {
          if (!f.endsWith('.sh')) continue
          const name = f.slice(0, -3)
          const def = { target: name, type: 'script', cmd: join(targetsDir, f), displayName: name, timeoutMs: 120_000 }
          const envFile = join(targetsDir, `${name}.env.json`)
          if (existsSync(envFile)) {
            try { Object.assign(def, JSON.parse(readFileSync(envFile, 'utf8'))) } catch (e) { log(`target env ${envFile} parse fail: ${e.message}`) }
          }
          // 缺省唤醒闸门: 存在同名采集源 → 'auto'(跟随其采集间隔, 即每轮采集最多叫醒一次); 否则 0(不限制)
          if (def.minIntervalMs === undefined) def.minIntervalMs = SCRIPT_SOURCES[name] ? 'auto' : 0
          SCRIPT_TARGETS[name] = def
        }
      }
    } catch (e) { log(`scan targets fail: ${e.message}`) }
  }
  scanScriptTargets()
  if (Object.keys(SCRIPT_TARGETS).length) log(`L1: auto-discovered script targets: [${Object.keys(SCRIPT_TARGETS).join(',')}]`)


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
        // L1 监控目标 (发现层): 让 L2 知道"除了 facts 之外, 还有哪些 target 在盯着"
        l1Targets: Object.keys(ALL_TARGETS).map(k => ({
          target: k,
          type: ALL_TARGETS[k].isScript ? 'script' : 'builtin',
          name: ALL_TARGETS[k].name ?? k,
          minIntervalMs: ALL_TARGETS[k].minIntervalMs ?? 0,
        })),
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

  // 每个脚本源按【自己的】intervalMs 节流 (来自 collectors/<name>.env.json)。
  // 注意: 这个字段以前只被存进 SCRIPT_SOURCES 却从未在采集循环里生效 ——
  // 所有脚本源实际都按 l0.intervalMs(默认 60s) 跑, 浏览器类源(feed-timeline)会被拉到
  // 每分钟启停一次 Chrome, 既费资源又容易被目标站限流。这里补上。
  const lastCollectAt = {}
  async function collectOnce() {
    refreshDiscovery()                 // 新脚本源落盘即生效 (目录签名门控, 空载近零成本)
    const ts = Date.now()
    let count = 0
    // 启用集 = 配置声明(内置/显式脚本) ∪ 已发现的脚本源 (drop-in: 落盘即采集)
    const enabled = new Set(cfg.l0.sources)
    for (const name of Object.keys(SCRIPT_SOURCES)) enabled.add(name)
    for (const src of enabled) {
      const c = SOURCES[src]
      if (!c) continue
      // 声明了【比节拍更长】的独立间隔的源才额外节流 ——
      // 扫描循环给每个脚本源都塞了默认 intervalMs(= scriptIntervalMs), 若不加这个比较,
      // 默认值恰好等于节拍时会被反复跳过(抖动导致 60s 的源变成 120s 跑一次)。
      // 启动后 lastCollectAt 为空 → 首轮立即采一次。
      const everyMs = (c.intervalMs ?? 0) > cfg.l0.intervalMs ? c.intervalMs : 0
      if (everyMs && ts - (lastCollectAt[src] ?? 0) < everyMs) continue
      lastCollectAt[src] = ts
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
  // 用 bash -c 执行, 并注入自定义 CA 证书与完整 PATH (受控服务依赖, 否则 TLS 失败)
  //
  // ---------- 密钥: 自己读密钥库(见 scriptEnv 的说明) ----------
  // 格式与 ds-bot 的密钥库一致: { secrets: [ {name, value, scope, ...} ] }
  // 只按白名单取, 不把整库递给脚本。
  let secretsCache = { at: 0, values: new Map() }
  let warnedNoJevKey = false
  function loadSecrets() {
    const now = Date.now()
    if (now - secretsCache.at < 30_000) return secretsCache.values   // 30s 缓存: 别每轮都读盘
    const values = new Map()
    // 1) .credentials.yaml 的 refs 段 —— 只做极简解析, 不引 yaml 依赖:
    //    该段是扁平的 "KEY: value" 列表, 取白名单内的键即可。多行/引号也顺手处理。
    try {
      if (existsSync(cfg.credentialsFile)) {
        const text = readFileSync(cfg.credentialsFile, 'utf8')
        let inRefs = false
        for (const raw of text.split('\n')) {
          const line = raw.replace(/\s+$/, '')
          if (!line || line.trimStart().startsWith('#')) continue
          if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
          if (inRefs && /^\S/.test(line)) break                    // 缩进结束, 离开 refs 段
          if (!inRefs) continue
          const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
          if (!m) continue
          const name = m[1]
          if (!cfg.secretAllow.includes(name)) continue     // 白名单之外一律不碰
          let v = m[2].trim()
          if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
            v = v.slice(1, -1)
          }
          if (v) values.set(name, v)
        }
      }
    } catch (e) {
      log(`凭据文件读取失败 ${cfg.credentialsFile}: ${e.message}`)
    }
    // 2) ds-bot 的密钥库(有则以它为准, 因为那是用户显式通过安全卡片存的)
    try {
      if (existsSync(cfg.secretsFile)) {
        const parsed = JSON.parse(readFileSync(cfg.secretsFile, 'utf8'))
        for (const entry of Array.isArray(parsed?.secrets) ? parsed.secrets : []) {
          const name = String(entry?.name ?? '')
          if (!name || typeof entry.value !== 'string') continue
          if (!cfg.secretAllow.includes(name)) continue
          if (entry.value.trim()) values.set(name, entry.value)
        }
      }
    } catch (e) {
      log(`密钥库读取失败 ${cfg.secretsFile}: ${e.message}`)
    }
    secretsCache = { at: now, values }
    return values
  }
  function secretValue(name) {
    if (!cfg.secretAllow.includes(name)) return undefined
    const v = loadSecrets().get(name)
    return typeof v === 'string' && v.trim() ? v : undefined
  }

  // 解包 volatile 字段。
  // ⚠️ 声明了 .volatile() 的字段在运行时不是裸值, 而是 `Volatile<T>` 取值器 ——
  //    官方写法是 `this.config.provider.get()`。直接当字符串用会静默出错:
  //    `cfg.backend === 'jev'` 永远 false, 于是"切后端"看起来配了却不生效,
  //    而且不报任何错。这里统一解包, 兼顾未标 volatile 的字段(仍是裸值)。
  function unwrap(v, fallback) {
    if (v === undefined || v === null) return fallback
    if (typeof v === 'object' && typeof v.get === 'function') {
      try { return v.get() ?? fallback } catch { return fallback }
    }
    return v
  }

  // 脚本运行的公共环境: 统一目录 / 自定义 CA(只透传) / 完整 PATH / SemIf 打分脚本位置
  // (GUI 子进程 PATH 可能精简, 不补会导致 helper / 受控服务的 TLS 失败)
  //
  // 密钥注入: 这里【必须自己读】密钥库, 不能指望 process.env 里已经有。
  // ds-bot 把密钥注册进 DSH 的 shellEnv 服务(按需解析, 只对 DSH 的 bash 工具有效),
  // 而本插件是用 spawn 直接起子进程 —— 实测 process.env 里 DSH_SECRET_* 为 0 个。
  // 不自己读的话, REFLEX_JEV_API_KEY 永远是空的, 切到托管 Jev 必然失败。
  function scriptEnv(extra) {
    // 不内置任何平台专有的 CA 文件名 —— 需要自定义 CA 的环境在宿主侧设好
    // SSL_CERT_FILE / CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE 即可, 这里只做透传兜底。
    const env = {
      ...process.env,
      REFLEX_HOME: cfg.l0.homeDir,
      // 标记"这次是插件在采集" —— 采集器据此区分正常采集与手工跑(排障)。
      // 手工跑的输出只进终端、不会成为 facts, 若它也写去重表, 那批邮件就被
      // 永久标记为已见、再也等不到 facts(实测踩过, 见 mail.sh 的 dry-run 分支)。
      REFLEX_PLUGIN_INVOKED: '1',
      PATH: `/usr/local/bin:/opt/homebrew/bin:/bin:/usr/bin:/sbin:/usr/sbin:${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}`,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE || '',
      CURL_CA_BUNDLE: process.env.CURL_CA_BUNDLE || process.env.SSL_CERT_FILE || '',
      REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE || process.env.CURL_CA_BUNDLE || process.env.SSL_CERT_FILE || '',
      // target 脚本要调 SemIf 时用它, 不必写死路径
      // 默认走影子包装: 真实打分不变(REFLEX_SHADOW_REAL=run_score.sh), 但全量分数(含阈值以下)
      // 落盘 shadow/ 供阈值拟合/回放/A-B。防递归由 wrapper 自带; 保留策略见 shadow_record.py。
      // ⚠️ tuning.skillDir 默认已含 /scripts(defaults 处), 再拼一层会得到 scripts/scripts
      // (2026-10-24 事故: ai-policy/edu-policy 判定层因此瘫痪 10h; 回归 tests/reflex-semif-degrade-regress.py)
      REFLEX_SEMIF_RUN: join(cfg.tuning.skillDir, 'shadow-semif.sh'),
      REFLEX_SHADOW_REAL: join(cfg.semif.skillDir, 'scripts', 'run_score.sh'),
      // 调优工具目录 (shadow 包装 / 唤醒策略库), 随插件 skill 部署
      REFLEX_TUNING_DIR: cfg.tuning.skillDir,
      ...(extra ?? {}),
    }
    // 决策后端: 只在显式配了才注入 —— 不配就别动, 让 target 自己的默认(semif)生效。
    // 注意 'semif' 也要注入: 它是"从默认切回本地"的显式选择。
    const backend = String(unwrap(cfg.backend, '') ?? '').trim()
    if (backend) env.REFLEX_DECIDE_BACKEND = backend
    if (backend === 'jev' || backend === 'jevlocal') {
      env.REFLEX_JEV_BASE_URL = String(unwrap(cfg.jevBaseUrl, '') ?? '')
      env.REFLEX_JEV_MODEL = String(unwrap(cfg.jevModel, '') ?? '')
      const key = secretValue('JEV_API_KEY')
        ?? secretValue('REFLEX_JEV_API_KEY')
        ?? secretValue('TYPESAFE_API_KEY')
      if (key) {
        env.REFLEX_JEV_API_KEY = key
      } else if (!warnedNoJevKey) {
        warnedNoJevKey = true
        log('决策后端=%s 但没找到密钥(找过 %s 的 refs) —— 判定会因缺 key 失败。'
          + '存法: 把 JEV_API_KEY 写进凭据文件的 refs 段(或聊天里用 request_secret)',
          backend, cfg.credentialsFile, cfg.secretAllow.join('/'))
      }
    }
    return env
  }

  async function runScriptCollector(c, src) {
    const { stdout } = await execFileP('/bin/bash', [c.cmd], { timeout: (c.timeoutMs ?? 20_000), env: scriptEnv(c.env) })
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

  // 跑子进程并把 input 写进 stdin —— 异步 execFile 不支持 input 选项, 所以用 spawn 自己接
  function runWithStdin(cmd, args, input, { timeoutMs, env }) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(cmd, args, { env })
      let out = '', err = '', timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { err += d })
      child.on('error', e => { clearTimeout(timer); reject(e) })
      child.on('close', code => {
        clearTimeout(timer)
        if (timedOut) return reject(new Error(`timeout after ${timeoutMs}ms`))
        if (code !== 0) {
          const tail = err.trim().split('\n').filter(Boolean).pop() ?? ''
          return reject(new Error(`exit ${code}${tail ? `: ${tail}` : ''}`))
        }
        resolve({ stdout: out, stderr: err })
      })
      child.stdin.on('error', () => {})   // 脚本不读 stdin 时忽略 EPIPE
      child.stdin.end(input)
    })
  }

  // 脚本 target: 本轮新事实(JSONL)喂 stdin → 读回一行 JSON 决策; 无输出/无内容 = 本轮不唤醒
  async function runScriptTarget(t, facts) {
    const input = facts.length ? facts.map(f => JSON.stringify(f)).join('\n') + '\n' : ''
    const { stdout } = await runWithStdin('/bin/bash', [t.cmd], input, {
      timeoutMs: t.timeoutMs ?? 120_000,
      env: scriptEnv({
        // 用户画像: 内容类 target 组装 SemIf 决策 context 用 (由 profile patch 的 l1.profile 提供)
        REFLEX_PROFILE: cfg.l1.profile ?? '',
        REFLEX_TARGET: t.target,
        ...(t.env ?? {}),
      }),
    })
    for (const line of stdout.split('\n')) {
      const s = line.trim()
      if (!s) continue
      let o; try { o = JSON.parse(s) } catch { continue }
      if (!o || typeof o !== 'object') continue
      if (o.wake === false) {
        // 脚本跑了但本轮不唤醒: 记一行 —— 否则没命中的轮次完全静默, 排查时看不出 target 是死是活
        const why = typeof o.reason === 'string' ? o.reason
          : (Number.isFinite(o.scanned) ? `扫描 ${o.scanned} 条, 本轮无命中` : null)
        if (why) log(`L1[${t.target}]: ${why}`)
        return null
      }
      const items = Array.isArray(o.items) ? o.items : []
      const notice = typeof o.notice === 'string' && o.notice.trim() ? o.notice : null
      if (!items.length && !notice) return null
      return {
        kind: 'script-target',
        reason: typeof o.reason === 'string' ? o.reason : '脚本判定命中',
        fingerprint: (o.fingerprint && typeof o.fingerprint === 'object') ? o.fingerprint : null,
        header: typeof o.header === 'string' ? o.header : null,
        items, notice,
        scanned: Number.isFinite(o.scanned) ? o.scanned : 0,
        rounds: 1,
        carried: 0,
      }
    }
    return null
  }

  // 脚本 target 的累积合并: items 按 id 去重、新一轮排在前面; 自由文本 notice 只能整段拼接
  function mergeScriptDecisions(prev, next) {
    const prevItems = prev?.items ?? []
    const prevIds = new Set(prevItems.map(i => String(i?.id ?? '')).filter(Boolean))
    const seen = new Set()
    const items = [...(next?.items ?? []), ...prevItems].filter(it => {
      const id = String(it?.id ?? '')
      if (!id) return true
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    const notices = [
      ...(next?.notice ? [next.notice] : []),
      ...(prev?.notices ?? []),
      ...(prev?.notice ? [prev.notice] : []),
    ]
    if (!items.length && !notices.length) return null
    return {
      kind: 'script-target',
      reason: next?.reason ?? prev?.reason ?? '脚本判定命中',
      header: next?.header ?? prev?.header ?? null,
      fingerprint: null,                       // 合并后交给 stateFingerprint 从 items 重新算
      items, notices,
      scanned: (prev?.scanned ?? 0) + (next?.scanned ?? 0),
      rounds: (prev?.rounds ?? 0) + (next?.rounds ?? 0),   // next 为 null 时(空跑补发)不计轮次
      carried: items.filter(it => prevIds.has(String(it?.id ?? ''))).length,
    }
  }

  // 排版信封 —— 由插件负责, 脚本只出 items[].title/body。
  // "其中 N 条为冷却期累积 / 跨 N 轮扫描" 这类信息来自插件跨轮统计, 脚本不可能知道。
  function renderScriptTarget(displayName, ctx, extra) {
    const items = ctx.items ?? []
    const parts = [`[分层智能体·L1·${displayName}] ${items.length ? `${items.length} 条值得关注` : '需要关注'}`]
    const meta = []
    if (ctx.carried) meta.push(`其中 ${ctx.carried} 条为此前暂存（冷却期或安静时段）`)
    if ((ctx.rounds ?? 1) > 1) meta.push(`跨 ${ctx.rounds} 轮扫描`)
    if (ctx.scanned) meta.push(`累计扫描 ${ctx.scanned} 条`)
    if (meta.length) parts.push(meta.join(' · '))
    if (ctx.header) parts.push(ctx.header)
    if (items.length) {
      parts.push('')
      items.forEach((it, i) => {
        const title = String(it?.title ?? '')
        const body = String(it?.body ?? '')
        if (title) parts.push(`${i + 1}. ${title}`)
        if (body) parts.push(body.split('\n').map(l => (title ? `   ${l}` : l)).join('\n'))
        parts.push('')
      })
    }
    const notices = ctx.notices ?? []
    notices.forEach((nt, i) => {
      if (notices.length > 1) parts.push(`── 冷却期内累积的第 ${i + 1} 段 ──`)
      parts.push(nt)
      parts.push('')
    })
    if (extra) parts.push(extra)
    parts.push(`请评估并决策是否需要处理。需要更多数据时, L0 数据源入口: ${cfg.l0.storeDir}/manifest.json`)
    return parts.join('\n')
  }

  // ---------- L1: 增量读事实 (持久化游标 cursor.json, 跨重启不重读历史) ----------
  // 游标按 source 隔离: cursor = { <source>: { file, line } } — 各源独立消费位置
  const cursorPath = join(dirname(cfg.l0.storeDir), 'cursor.json')
  let cursor = {}
  try { if (existsSync(cursorPath)) cursor = JSON.parse(readFileSync(cursorPath, 'utf8')) ?? {} } catch (e) { log(`cursor read fail: ${e.message}`) }
  function saveCursor() { try { writeFileSync(cursorPath, JSON.stringify(cursor)) } catch (e) { log(`cursor write fail: ${e.message}`) } }

  // 返回 (facts, next: {src → {file, line}}) —— 每个源各自读到哪里; 不修改游标
  // (由调用方在决策后 advanceCursor)。存储: <storeDir>/<source>/<date>.jsonl。
  //
  // ⚠️ 游标必须【一个源一个】。曾经这里只记"最后一个有新行的源"的位置, 后果:
  //   disk/swap 这种每分钟产出的源永远轮不到推进, 每轮把历史全量重投一遍; 数组末尾
  //   .slice(-100) 一截, 排在字母表前面的源(cpu-top / jira-my-tasks)永远进不了批次 ——
  //   它们的 target 一次都没跑过, 是最难发现的那种死代码(2026-10-16 实测: cpu-load 与
  //   release-progress 从未被调用过)。见 tests/test-facts-cursor.mjs。
  const MAX_FACTS_PER_ROUND = 1000   // 安全网, 不是节流阀: 正常一轮只有几条, 见上面注释
  function readNewFacts() {
    const out = []
    const dir = cfg.l0.storeDir
    const next = {}
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
            next[src] = { file: f, line: i + 1 }   // 每个源各记各的
          }
        }
      }
    } catch (e) { log(`L1 read fail: ${e.message}`) }
    return { facts: out.slice(-MAX_FACTS_PER_ROUND), next }
  }
  function advanceCursor(next) {
    let changed = false
    for (const [src, pos] of Object.entries(next ?? {})) {
      if (!pos?.file) continue
      const prev = cursor[src] ?? { file: null, line: 0 }
      const line = Math.max(prev.file === pos.file ? prev.line : 0, pos.line)
      if (prev.file === pos.file && prev.line === line) continue
      cursor[src] = { file: pos.file, line }
      changed = true
    }
    if (changed) saveCursor()
  }

  // ---------- L1: SemIf 调用 (通用; question/options 由 target 提供) ----------
  // 批量打分: 一次进程只加载一次模型, N 条 state 一起评 —— 逐条筛选场景(如推文)比 N 次单调用快得多
  let semifSeq = 0
  async function semifScoreBatch(rows, timeoutMs = 180_000) {
    const runScore = join(cfg.semif.skillDir, 'scripts', 'run_score.sh')
    const work = join(cfg.l0.storeDir, '..', 'work')
    try { mkdirSync(work, { recursive: true }) } catch {}
    const tag = `${process.pid}-${++semifSeq}`
    const inp = join(work, `dec-${tag}.jsonl`)
    const out = join(work, `res-${tag}.jsonl`)
    for (const f of [out, out.replace(/\.jsonl$/, '.summary.md')]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
    writeFileSync(inp, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    const semifArgs = ['bash', [runScore, '--input', inp, '--output', out, '--offline'], { timeout: timeoutMs }]
    try {
      await execFileP(...semifArgs)
    } catch (e1) {
      // 2026-10-26: 瞬时失败（spawn EAGAIN / 资源抖动 / 网络中断窗口）会让整轮 L1 丢分，
      // 重试一次即可恢复；第一次失败留下的半成品先清掉（run_score 是 create-only，
      // 输出文件已存在会直接报错）。
      log(`SemIf 打分失败，2s 后重试一次: ${e1.message}`)
      await new Promise(r => setTimeout(r, 2000))
      for (const f of [out, out.replace(/\.jsonl$/, '.summary.md')]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
      await execFileP(...semifArgs)
    }
    const res = new Map()
    for (const line of readFileSync(out, 'utf8').split('\n')) {
      const t = line.trim(); if (!t) continue
      let o; try { o = JSON.parse(t) } catch { continue }
      const probs = {}; (o.option_ids ?? []).forEach((id, i) => { probs[id] = (o.probabilities ?? [])[i] })
      const vals = Object.keys(probs).map(k => probs[k])
      res.set(String(o.id), {
        winning: Object.keys(probs)[vals.indexOf(Math.max(...vals))],
        pYes: probs.yes ?? 0,
        probs,
      })
    }
    return res
  }
  async function semifDecide(state, question, options) {
    const m = await semifScoreBatch([{ id: 'l1', state, question, options }])
    return m.get('l1') ?? { winning: 'insufficient', pYes: 0 }
  }

  // ---------- L1: 目标化决策框架 (v2) ----------
  // 每个 target 是自包含的决策闭环: collect(组装context) → interim(硬规则) → semif(本地模型) → wake(通知)
  // L2 通知自包含 target collect 产出的 context → L2 无状态可决策

  // 某个【脚本源】的真实采集间隔 —— 来自 collectors/<name>.env.json 的 intervalMs,
  // 插件启动扫描 collectors/ 时已放进 SCRIPT_SOURCES。
  // 用途: 内容类 target 的唤醒上限缺省跟随采集节奏, 避免写死魔数、改采集频率后忘了同步。
  const sourceIntervalMs = (src) =>
    SCRIPT_SOURCES[src]?.intervalMs ?? cfg.l0.scriptIntervalMs ?? cfg.l0.intervalMs ?? 60_000

  // feed-timeline 的 SemIf 判据与阈值: 已随该 target 一起迁到 targets/feed-timeline.sh
  // (校准记录与踩过的坑都在那个脚本的注释里 —— 判据归脚本, 插件不再持有它的措辞)
  const TARGETS = {
    disk: {
      name: '磁盘存储',
      interruptAlways: true,      // 硬规则不被安静时段拦住: 磁盘满是"现在就得知道"的事
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
        // 跨源关联: 顺手带上本轮的 swap 情况。磁盘骤降时, 这是"文件涨了"还是
        // "系统把内存换到磁盘"的第一判据 —— 2026-10-14 那次可用量 3 分钟掉 55GB,
        // 真凶是 swap 而非任何用户文件, 当时只能事后手工排查。
        const swapFacts = facts.filter(f => f.source === 'swap')
        const swLast = swapFacts[swapFacts.length - 1]?.raw
        const swFirst = swapFacts[0]?.raw
        const swap = swLast && swLast.usedMB !== undefined ? {
          usedGB: +(swLast.usedMB / 1024).toFixed(1),
          dirGB: swLast.vmDirMB ? +(swLast.vmDirMB / 1024).toFixed(1) : null,
          files: swLast.swapFiles ?? null,
          deltaGB: (swFirst && swFirst.usedMB !== undefined)
            ? +((swLast.usedMB - swFirst.usedMB) / 1024).toFixed(1) : null,
        } : null
        return {
          kind: 'disk',
          current: { availableGB: latest.availableGB, usedPct: latest.usedPct, totalGB: latest.totalGB, usedGB: latest.usedGB },
          trend,
          swap,
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
          ...(ctx.swap ? [`swap: 已用 ${ctx.swap.usedGB}GB` +
            (ctx.swap.dirGB !== null ? ` / 占用磁盘 ${ctx.swap.dirGB}GB` : '') +
            (ctx.swap.files !== null ? ` (${ctx.swap.files} 个 swapfile)` : '') +
            (ctx.swap.deltaGB ? ` / 窗口内 Δ${ctx.swap.deltaGB >= 0 ? '+' : ''}${ctx.swap.deltaGB}GB` : '')
          ] : []),
          // 判读只说明"swap 解释了多少", 不声称它是全部 —— 窗口内掉的空间很可能另有原因
          ...(t && ctx.swap && t.deltaGB < -1 && ctx.swap.deltaGB > 1
            ? [`判读: 窗口内可用空间减少 ${Math.abs(t.deltaGB)}GB, 其中 ${ctx.swap.deltaGB}GB 来自 swap 增长`]
            : []),
          `阈值: 可用<${ctx.policy.lowAvailableGB}GB 或 使用率>${ctx.policy.highUsedPct}%`,
          ...(extra ? [extra] : []),
          `请评估并决策是否需要处理(如可清理缓存则执行)。需要更多数据时, L0 数据源入口: ${cfg.l0.storeDir}/manifest.json`,
        ].join('\n')
      },
    },
  }

  // 脚本 target 适配器: 把 targets/<name>.sh 包装成与内置 target 同形的对象,
  // 于是 decideOnce 的主循环一行都不用改 —— 去重/冷却/节流/累积/投递纪律全部复用。
  let scriptTargetAdapters = {}
  let ALL_TARGETS = { ...TARGETS }
  function rebuildScriptLayer() {
    // 可重入: 由 refreshDiscovery 在目录变化时调用 (脚本 target 落盘即生效, 无需重启)
    scriptTargetAdapters = Object.fromEntries(
      Object.entries(SCRIPT_TARGETS).map(([key, t]) => [key, {
        name: t.displayName ?? key,
        isScript: true,
        minIntervalMs: t.minIntervalMs === 'auto' ? sourceIntervalMs(key) : (t.minIntervalMs ?? 0),
        interruptAlways: !!t.interruptAlways,      // 由 <name>.env.json 配置, 默认遵守安静时段
        collect: async (facts) => {
          // env.json 里声明了 sources 的 target: 本轮没有它关心的源的数据时, 连脚本都不用起。
          // 不加这道闸, target 脚本会被每分钟空跑一次 —— 因为 disk 每分钟产出一条事实,
          // 就触发一轮决策, 而脚本对那批事实根本不关心。
          if (Array.isArray(t.sources) && t.sources.length &&
              !facts.some(f => t.sources.includes(f.source))) return null
          return runScriptTarget(t, facts)
        },
        interim: (ctx) => !!ctx,
        interimReason: (ctx) => ctx?.reason ?? '脚本判定命中',
        mergeCtx: mergeScriptDecisions,
        render: (ctx, extra) => renderScriptTarget(t.displayName ?? key, ctx, extra),
      }]))
    ALL_TARGETS = { ...TARGETS, ...scriptTargetAdapters }
  }
  rebuildScriptLayer()
  if (Object.keys(scriptTargetAdapters).length) log(`L1: script targets registered: [${Object.keys(scriptTargetAdapters).join(',')}]`)
  // manifest 要列出 L1 监控目标, 所以延到这里再写 (ALL_TARGETS 此时才建好)
  writeManifest()


  // 目标指纹 + 冷却去重 (跨 target 各自独立)
  // lastWake 记录上次唤醒的"状态指纹+时间", 同状态或冷却期内不重复唤醒 → L2 无状态可行
  const lastWakePath = join(dirname(cfg.l0.storeDir), 'last-wake.json')
  let lastWake = {}
  try { if (existsSync(lastWakePath)) lastWake = JSON.parse(readFileSync(lastWakePath, 'utf8')) ?? {} } catch (e) { log(`last-wake read fail: ${e.message}`) }
  function saveLastWake(w) { lastWake = w; try { writeFileSync(lastWakePath, JSON.stringify(w)) } catch (e) { log(`last-wake write fail: ${e.message}`) } }

  // 冷却期攒下的待唤醒内容 (只有声明了 mergeCtx 的 target 会用到):
  // 硬上限生效的那几轮不能白扫 —— 把筛出的条目攒下来, 到点合并成一条摘要发出, 避免漏报。
  // 注意: 必须持久化, 且 decideOnce 在没有新事实时也要跑 (否则"攒了但之后没新数据"就永远发不出去)。
  const pendingPath = join(dirname(cfg.l0.storeDir), 'pending-wakes.json')
  let pendingWakes = {}
  // 从磁盘重读 pending (磁盘为准)。两个理由:
  //   1) 插件热重载时新旧实例并存: 旧实例投递失败后写进 pending 的条目, 不能因为新实例
  //      install 时读到的是旧快照、之后 savePending 整份覆盖写回而消失 (2026-10-27 10:39 实测:
  //      arxiv-watch 的 8 条 pending 被新实例下一轮 savePending 整份覆盖, 补投丢了)。
  //   2) 每轮决策前重读, 旧实例留下的 pending 才能被活着的那个实例补投出去。
  function reloadPending() {
    try {
      if (!existsSync(pendingPath)) return pendingWakes
      const disk = JSON.parse(readFileSync(pendingPath, 'utf8'))
      if (disk && typeof disk === 'object') pendingWakes = disk
    } catch (e) { log(`pending reload fail: ${e.message}`) }
    return pendingWakes
  }
  reloadPending()
  function savePending(targetKey, ctx) {
    // read-modify-write: 只改自己这个 key, 不把磁盘上别的实例写的条目整份盖掉
    reloadPending()
    if (ctx) pendingWakes = { ...pendingWakes, [targetKey]: ctx }
    else { const rest = { ...pendingWakes }; delete rest[targetKey]; pendingWakes = rest }
    try { writeFileSync(pendingPath, JSON.stringify(pendingWakes)) } catch (e) { log(`pending write fail: ${e.message}`) }
    return pendingWakes
  }
  // 本轮/累积的条目数 —— 内置 target 用 notable[], 脚本 target 用 items[]
  const ctxItemCount = (ctx) => ctx?.items?.length ?? ctx?.notable?.length ?? 0

  function stateFingerprint(targetKey, ctx) {
    if (targetKey === 'disk') {
      const c = ctx?.current
      if (!c) return null
      return { availBucket: Math.round((c.availableGB ?? 0) / 5), usedBucket: Math.round((c.usedPct ?? 0) / 5) }
    }
    // 脚本 target: 优先用脚本自己给的 fingerprint; 没给就用 items 的 id 集合兜底 ——
    // 指纹缺失会让 contentChanged 恒真, 变成每轮都唤醒, 所以兜底不能省
    if (ctx?.fingerprint && typeof ctx.fingerprint === 'object') return ctx.fingerprint
    const items = ctx?.items ?? ctx?.notable ?? []
    const ids = items.map(x => String(x?.id ?? x?.post?.id ?? '')).filter(Boolean).sort()
    return ids.length ? { ids } : null
  }
  function contentChanged(targetKey, fp) {
    const last = lastWake[targetKey]
    if (!last || !last.fp) return true                     // 该 target 无上次 → 视为新
    if (fp) {
      const changed = targetKey === 'disk'
        ? (last.fp.availBucket !== fp.availBucket || last.fp.usedBucket !== fp.usedBucket)  // 状态分桶变化
        : JSON.stringify(last.fp) !== JSON.stringify(fp)                                    // 内容指纹变化
      if (changed) return true
    }
    const cooldownMs = cfg.l1.cooldownMs ?? 30 * 60 * 1000
    if (Date.now() - (last.at ?? 0) < cooldownMs) return false
    return true                                             // 同状态但超过冷却期 → 重新关注
  }

  // 安静时段判定 (支持跨午夜, 如 18:00 -> 09:00)
  function isQuietNow(q) {
    if (!q || !q.from || !q.to) return false
    // 容忍数字: YAML 1.1 把「双位:两位」当 sexagesimal(时分), 所以
    //   from: 18:00        (无引号) -> 解析成 1080
    //   from: "18:00"      (有引号) -> 字符串
    // 谁写的 patch 都可能漏引号(宿主加载器重写整个文件时就会把引号去掉),
    // 而 1080 恰好就是"当日第 1080 分钟" = 18:00 —— 语义完全等价, 应当接受。
    // 不兜住的话这里会判格式错误并静默返回 false, 安静时段就悄悄失效了。
    const toMin = (v) => {
      if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 1440 ? v : null
      const m = String(v).match(/^(\d{1,2}):(\d{2})$/)
      return m ? (Number(m[1]) * 60 + Number(m[2])) : null
    }
    const from = toMin(q.from), to = toMin(q.to)
    if (from === null || to === null) { log(`quietHours 格式错误(应为 HH:MM 或分钟数): ${JSON.stringify(q.from)}/${JSON.stringify(q.to)}`); return false }
    const d = new Date()
    const cur = d.getHours() * 60 + d.getMinutes()
    return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to)
  }

  // 启用集 = 配置声明(内置/显式脚本) ∪ 已发现的脚本 target (drop-in: 文件存在即生效)。
  // 由 rebuildActiveTargets()/refreshDiscovery() 维护 —— 加脚本 target 不再需要重启。
  let activeTargets = []
  function rebuildActiveTargets() {
    const cfgSet = new Set(cfg.l1.targets ?? ['disk'])
    activeTargets = Object.keys(ALL_TARGETS).filter(k => cfgSet.has(k) || SCRIPT_TARGETS[k])
  }
  rebuildActiveTargets()

  // ---------- 热发现: 新脚本源/target 落盘即生效, 无需重启 ----------
  // 门控: collectors/ 与 targets/ 的目录 mtime + .env.json mtime 签名变了才重扫
  // (空载成本 ≈ 两次 stat)。语义: 脚本源/target 以【文件存在】为准自动启用;
  // 移除文件或 <name>.paused 即退出。内置源 (disk/mail/swap) 仍由 l0.sources 配置门控。
  let lastDiscSig = null
  function discoverySig() {
    const mt = (p) => { try { return statSync(p).mtimeMs } catch { return 0 } }
    let sig = `${mt(collectorsDir)}|${mt(targetsDir)}`
    for (const dir of [collectorsDir, targetsDir]) {
      try { for (const f of readdirSync(dir)) if (f.endsWith('.env.json')) sig += `|${mt(join(dir, f))}` } catch {}
    }
    return sig
  }
  function refreshDiscovery() {
    const sig = discoverySig()
    if (sig === lastDiscSig) return
    const before = `${Object.keys(SCRIPT_SOURCES).join(',')}|${Object.keys(SCRIPT_TARGETS).join(',')}`
    scanScriptSources()
    scanScriptTargets()
    rebuildScriptLayer()
    rebuildActiveTargets()
    lastDiscSig = discoverySig()
    const after = `${Object.keys(SCRIPT_SOURCES).join(',')}|${Object.keys(SCRIPT_TARGETS).join(',')}`
    if (before !== after) {
      writeManifest()
      log(`discovery refreshed: sources=[${Object.keys(SCRIPT_SOURCES).join(',')}] script-targets=[${Object.keys(SCRIPT_TARGETS).join(',')}]`)
    }
  }

  // 防重入: 脚本 target 可能要跑十几秒(要启浏览器、要调 SemIf), 一旦超过 l1.intervalMs,
  // setInterval 会让两轮决策并发 —— 它们会读到同一批事实各判一次, 造成重复唤醒。
  let deciding = false
  async function decideOnce() {
    if (deciding) { log('L1: 上一轮决策尚未结束, 跳过本轮'); return }
    deciding = true
    try { return await decideOnceInner() } finally { deciding = false }
  }

  async function decideOnceInner() {
    refreshDiscovery()                 // 新脚本 target 落盘即生效 (与 L0 同一门控)
    reloadPending()                    // 磁盘为准: 别的实例(热重载残留)写进 pending 的条目也要补投
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
    const { facts, next } = readNewFacts()
    // 没有新事实时不能直接 return: 冷却期内攒下的 pending 需要在这里【到点补发】
    if (facts.length) advanceCursor(next)
    if (!facts.length && !Object.keys(pendingWakes).length) return
    for (const targetKey of activeTargets) {
      const target = ALL_TARGETS[targetKey]
      try {
        const rateLimit = target.minIntervalMs ?? 0
        // 安静时段与唤醒闸门是同一类限制(都靠 pending 累积绕过), 所以合并成一个 limited。
        // interruptAlways 的 target(如磁盘硬规则)穿透安静时段 —— 磁盘满这类事没有"上班再说"。
        const quiet = isQuietNow(cfg.l1.quietHours) && !target.interruptAlways
        const limited = quiet || (!!rateLimit && (Date.now() - (lastWake[targetKey]?.at ?? 0)) < rateLimit)
        const limitWhy = quiet ? '处于安静时段' : `距上次唤醒不足 ${Math.round(rateLimit / 60000)} 分钟`
        const buffers = typeof target.mergeCtx === 'function'

        // 不支持累积的 target: 冷却期内直接短路, 连 collect 都不跑
        if (limited && !buffers) {
          log(`L1[${targetKey}]: ${limitWhy}, 本轮跳过`)
          continue
        }

        // 支持累积的 target: 冷却期内照常筛选, 命中项攒进 pending 等下次合并发出 (不漏报)
        let ctx = facts.length ? await target.collect(facts) : null
        const pending = pendingWakes[targetKey]
        if (buffers && pending) {
          ctx = target.mergeCtx(pending, ctx)
          if (ctx) log(`L1[${targetKey}]: 合并此前暂存 (共 ${ctxItemCount(ctx)} 条, 其中 ${ctx.carried ?? 0} 条为暂存)` )
        }
        if (!ctx) continue

        const fp = stateFingerprint(targetKey, ctx)
        // 硬规则先决 (target 专属); 部分 target(如 feed-timeline)把 SemIf 前置进 collect, 用 interimReason 说明
        if (target.interim?.(ctx)) {
          const label = (typeof target.interimReason === 'function' ? target.interimReason(ctx) : target.interimReason) ?? '硬规则触发'
          if (limited) {
            savePending(targetKey, ctx)
            log(`L1[${targetKey}]: ${label} 但${limitWhy}, 已攒 ${ctxItemCount(ctx)} 条待下次合并`)
            continue
          }
          if (contentChanged(targetKey, fp)) {
            log(`L1[${targetKey}]: ${label}`)
            const delivered = await wakeL2(target.render(ctx, `(${label})`))
            if (delivered) {
              saveLastWake({ ...(lastWake), [targetKey]: { fp, at: Date.now(), reason: label } })
              if (pending) savePending(targetKey, null)
            } else {
              // 没投出去就不能记指纹: 记了这条内容会被永久去重, 告警静默消失(踩过)。
              // 攒进 pending, 下轮继续重试, 投递一恢复就补发。
              savePending(targetKey, ctx)
              log(`L1[${targetKey}]: 投递失败, 未记指纹, 已攒 ${ctxItemCount(ctx)} 条待下轮重试`)
            }
          } else {
            log(`L1[${targetKey}]: ${label} 但内容与上次唤醒相同且未过冷却期, 跳过重复唤醒`)
            // 内容与上次唤醒完全重合 → pending 已无新信息, 清掉避免无限累积
            if (pending) savePending(targetKey, null)
          }
          continue
        }
        // SemIf 边界 (target 专属 question) —— 走到这里说明该 target 没有在 collect 里前置判定
        if (limited) { log(`L1[${targetKey}]: 冷却中, 跳过 SemIf 边界判定`); continue }
        const state = {
          since: facts[0]?.ts ?? Date.now(),
          count: facts.length,
          ...ctx,
        }
        const d = await semifDecide(state, target.semif.question, target.semif.options)
        log(`L1[${targetKey}]: SemIf winning=${d.winning} pYes=${d.pYes.toFixed(3)}`)
        if (d.pYes >= cfg.l1.threshold) {
          if (contentChanged(targetKey, fp)) {
            const delivered = await wakeL2(target.render(ctx, `(SemIf pYes=${d.pYes.toFixed(2)})`))
            if (delivered) {
              saveLastWake({ ...(lastWake), [targetKey]: { fp, at: Date.now(), reason: 'semif' } })
              if (pending) savePending(targetKey, null)
            } else {
              savePending(targetKey, ctx)
              log(`L1[${targetKey}]: 投递失败, 未记指纹, 已攒 ${ctxItemCount(ctx)} 条待下轮重试`)
            }
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
  try { ctx.effect(() => () => { clearInterval(t0); clearInterval(t1) }, 'dsh-reflex: L0/L1 timers') } catch {}

  log(`dsh-reflex installed: L0=${cfg.l0.intervalMs}ms L1=${cfg.l1.intervalMs}ms target="${cfg.l1.targetBot}" sources=[${cfg.l0.sources.join(',')}] targets=[${activeTargets.join(',')}]`)
  // scriptEnv 一并返回: 密钥注入是"必须可验证"的逻辑(读代码相信不算证据),
  // 测试直接调它比对环境变量, 不必真跑一轮采集。
  return { collectOnce, decideOnce, wakeL2, scriptEnv }
}
