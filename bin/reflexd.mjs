#!/usr/bin/env node
// reflexd — dsh-reflex 的无宿主运行时。
//
// 目的: 证明 L0/L1 不需要 DSH / cordis 也能长跑。整个 index.js 只通过四个口碰宿主:
//   ① ctx.logger  — 日志
//   ② ctx.effect  — 注册调度器(副作用通道), 返回 dispose
//   ③ ctx.inject  — 动态取 sessionController(投递要用)
//   ④ ctx.get     — 遗留注释里提到过, 实际代码 0 处调用
// 所以适配层不需要抽象 index.js, 只需要造一个"形状对的 ctx"。
// 这个配方不是新发明的: tests/test-fast-lane.mjs:76-85 早就在用, 只是从没做成进程。
//
// 与插件的差别只有一处: 投递不再调 agent.followup(那是 DSH 进程里的活对象),
// 而是写 wake-outbox.jsonl —— DSH 侧由一个 ~40 行 shim 消费, OS 通知/菜单栏也能消费同一份。
//
// 用法: REFLEX_HOME=/path/to/home node bin/reflexd.mjs
// 配置: $REFLEX_HOME/config.json (可选), 覆盖 statePath / l0 / l1。

import { apply } from '../index.js'
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// --once: 单轮控制面(菜单栏按钮/CLI)。它自己会调 collectOnce+decideOnce,
// 所以必须让 ctx.effect 补空 —— 否则 effect 立刻把调度器拉起来, 一轮变两轮(实测重复采集)。
const ONCE = process.argv.includes('--once')

const HOME = process.env.REFLEX_HOME
if (!HOME) {
  console.error('reflexd: REFLEX_HOME is required (state dir, e.g. ~/.dsh/dsh-reflex)')
  process.exit(2)
}
mkdirSync(HOME, { recursive: true })

// ---------- 单实例 ----------
// 双跑的后果不是"慢一点": 同一批事实会被判两次, pending 里的条目会被投两遍
// (index.js:1486 的 reloadPending 注释就是为这个写的)。所以锁必须在起调度之前拿到。
const PID_FILE = join(HOME, 'reflexd.pid')
let lockHeld = false
try {
  const prev = existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8').trim() || 0) : 0
  if (prev) {
    try { process.kill(prev, 0); console.error(`reflexd: already running (pid ${prev})`); process.exit(3) } catch {}
  }
  writeFileSync(PID_FILE, String(process.pid), { flag: 'w' })
  lockHeld = true
} catch (e) {
  console.error(`reflexd: lock failed: ${e.message}`)
  process.exit(4)
}

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`
  process.stdout.write(line + '\n')
  try { appendFileSync(join(HOME, 'reflexd.log'), line + '\n') } catch {}
}

// ---------- sink: 唤醒落到 outbox ----------
const OUTBOX = join(HOME, 'wake-outbox.jsonl')
let wakeCount = 0
function deliver(sessionId, text) {
  wakeCount += 1
  try {
    appendFileSync(OUTBOX, JSON.stringify({ ts: Date.now(), pid: process.pid, sessionId, text }) + '\n')
  } catch (e) { log(`outbox write failed: ${e.message}`); return false }
  log(`wake #${wakeCount} → outbox (${sessionId})`)
  return true
}

// 形状与 index.js:413 的用法一致: resolveAgent(sessionId) → {agent:{followup|steer}}
const sessionController = {
  async resolveAgent(sessionId) {
    if (!sessionId) return { error: { message: 'empty sessionId' } }
    return {
      agent: {
        followup: (msg) => deliver(sessionId, msg?.content?.[0]?.text ?? String(msg)),
        steer: (msg) => deliver(sessionId, msg?.content?.[0]?.text ?? String(msg)),
      },
    }
  },
}

const noop = () => {}
const ctx = {
  logger: { info: log, warn: log, error: log, debug: noop },
  on: noop,
  // 真实宿主里 effect(setup) 立即执行 setup, 返回值是 dispose。照此实现, 否则调度器不起。
  effect: (fn) => {
    if (ONCE) return noop   // 见文件头 ONCE: 单轮模式自己驱动, 不要让 effect 起调度器
    try { const d = fn(); return typeof d === 'function' ? d : noop } catch (e) { log(`effect setup threw: ${e.message}`); return noop }
  },
  get: () => undefined,
  tools: { register: noop },
  systemPrompt: { section: noop },
  schedule: { register: noop },
  workspaceRegistry: {},
  sessionController,
  sessionTitle: {},
  inject: (_deps, cb) => { try { cb({ sessionController, effect: noop }) } catch (e) { log(`inject cb threw: ${e.message}`) } },
}

// ---------- 配置 ----------
const cfgFile = process.env.REFLEXD_CONFIG || join(HOME, 'config.json')
let userCfg = {}
if (existsSync(cfgFile)) {
  try { userCfg = JSON.parse(readFileSync(cfgFile, 'utf8')) } catch (e) { log(`config parse failed: ${e.message}`) }
} else {
  log(`no config at ${cfgFile}, using defaults + REFLEX_HOME`)
}

const config = {
  ...userCfg,
  statePath: userCfg.statePath ?? join(HOME, 'state.json'),
  l0: { homeDir: HOME, sources: [], ...(userCfg.l0 ?? {}) },
  l1: { ...(userCfg.l1 ?? {}) },
}

log(`reflexd starting pid=${process.pid} home=${HOME}`)
let api = null
try {
  api = apply(ctx, config)
} catch (e) {
  log(`apply failed: ${e.message}`)
  cleanup(5)
}

// index.js:1685 对 tickTimer 调了 unref() —— 插件里无所谓(宿主活着), 独立进程会因此退出。
// 这个 keepalive 就是"从插件变进程"必须补的唯一一处运行时差异。
const keepalive = setInterval(noop, 60_000)

function cleanup(code) {
  try { if (lockHeld && existsSync(PID_FILE)) unlinkSync(PID_FILE) } catch {}
  process.exit(code ?? 0)
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { log(`reflexd stopping on ${sig}, wakes=${wakeCount}`); cleanup(0) })
}
process.on('exit', () => { try { clearInterval(keepalive) } catch {} })

// 控制面: 后续菜单栏/CLI 用 `node bin/reflexd.mjs --once` 跑一轮就退出, 不必常驻。
if (ONCE) {
  log('--once: single collect + decide, then exit')
  const t = setTimeout(() => { log('--once timed out'); cleanup(6) }, 120_000)
  Promise.resolve()
    .then(() => api?.collectOnce?.({ scheduled: false }))
    .then(() => api?.decideOnce?.({ scheduled: false }))
    .then(() => { clearTimeout(t); log(`--once done, wakes=${wakeCount}`); cleanup(0) })
    .catch((e) => { log(`--once failed: ${e.message}`); cleanup(7) })
}
