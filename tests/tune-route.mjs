// 逐行「L1 调优」：从面板请求走到真正的投递（不启动 DSH）。
//
// 这条链要守的四件事：
//   ① 只有一个名字，宿主必须自己判断「这个源有没有 L1」——没有就 400，不许投一条注定失败的活
//   ② 内置源（disk/cpu）由 profile 控制，不许从这里调
//   ③ 提示词必须原样带源名，并让 bot 先读阈值登记表再动手
//   ④ 投不出去必须 400，而"点一下"本身一个字都不写盘
//
// 退出码：0 全过 / 1 有断言失败 / 2 未判定
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-tune-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })
writeFileSync(join(home, 'state.json'), JSON.stringify({
  bots: { b_chief: { name: 'Chief', sessionId: 's-chief' }, b_career: { name: '求职顾问', sessionId: 's-career' } },
  rooms: {},
}), 'utf8')

const captured = []
const targeted = []          // resolveAgent 实际问到的会话 id：抓「静默改投 Chief」
const failSessions = new Set()
const routes = []
let agentReady = true
const noop = () => {}

const ctx = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  on: noop,
  effect: (fn) => { try { fn() } catch {} },
  get: () => undefined,
  tools: { register: noop },
  systemPrompt: { section: noop },
  schedule: { register: noop },
  workspaceRegistry: {},
  sessionTitle: {},
  sessionController: {},
  inject: (deps, cb) => {
    const list = Array.isArray(deps) ? deps : [deps]
    if (list.includes('connection')) {
      cb({
        connection: { fetch: { register: (def) => { routes.push(def); return () => {} } } },
        effect: (fn) => { try { fn() } catch {} },
      })
      return
    }
    cb({
      sessionController: {
        resolveAgent: async (sid) => {
          targeted.push(sid)
          if (failSessions.has(sid)) return { error: { message: 'no such session' } }
          return agentReady ? { agent: { followup: (msg) => { captured.push(msg) } } } : { agent: {} }
        },
      },
      effect: noop,
    })
  },
}

apply(ctx, {
  statePath: join(home, 'state.json'),
  l0: { homeDir: home, sources: [], intervalMs: 3600000 },
  l1: { targets: [], targetBot: 'Chief', intervalMs: 3600000 },
})

const route = routes.find((r) => r.path === '/api/reflex')
if (!route) { console.error('未判定：/api/reflex 路由没注册上'); process.exit(2) }

// 造两个源：demo 有 L1；onlycollect 只有采集器。
writeFileSync(join(home, 'collectors', 'demo.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
writeFileSync(join(home, 'targets', 'demo.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
writeFileSync(join(home, 'collectors', 'onlycollect.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
const collectBefore = readdirSync(join(home, 'collectors')).sort()
const targetBefore = readdirSync(join(home, 'targets')).sort()

let pass = 0
let total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}
const call = async (body) => {
  const res = await route.fetch({ json: async () => body })
  return { status: res.status, body: await res.json() }
}
const textOf = (msg) => (msg?.content ?? []).map((p) => p?.text ?? '').join('\n')

// ---- ① 有 L1 的源：拼提示词、投给 Chief ----
const sent = await call({ op: 'tune', name: 'demo' })
ok('P30 有 L1 的源返回 ok 并指明投给了谁', sent.body.ok === true && sent.body.target === 'Chief', JSON.stringify(sent.body))
ok('P30 没写偏好时回执 prefApplied=false（界面据此判断有没有被丢掉）', sent.body.prefApplied === false, JSON.stringify(sent.body))
ok('P30 真的投出去一条', captured.length === 1, `captured=${captured.length}`)
const text = textOf(captured[0] ?? { content: [] })
ok('P30 提示词带 [调优请求]', text.startsWith('[调优请求]'), text.slice(0, 40))
ok('P30 源名原样进提示词', text.includes('demo'))
ok('P30 先读阈值登记表', text.includes('shadow_targets.json'))
ok('P30 带信号量分档与 A/B 规矩', /100/.test(text) && /30/.test(text) && /pc_inject/.test(text))
ok('P30 消息 source.role=post', captured[0]?.source?.role === 'post', String(captured[0]?.source?.role))

// ---- ①b 用户在弹窗里写的偏好：原样进提示词；超长在入口挡住 ----
const prefText = '宁可少叫我几次，也别漏掉事故'
const withPref = await call({ op: 'tune', name: 'demo', preference: prefText })
const prefMsg = textOf(captured[captured.length - 1] ?? { content: [] })
ok('P30b 偏好原样进提示词', withPref.body.ok === true && prefMsg.includes(prefText), prefMsg.slice(0, 80))
ok('P30b 回执自报这次带上了偏好', withPref.body.prefApplied === true, JSON.stringify(withPref.body))
ok('P30b 偏好排在规矩之前（先看到要什么，再读门槛）',
  prefMsg.indexOf(prefText) > 0 && prefMsg.indexOf(prefText) < prefMsg.indexOf('先读现场'))

const beforeLong = captured.length
const tooLong = await call({ op: 'tune', name: 'demo', preference: '字'.repeat(501) })
ok('P30b 超长偏好 → 400 且不投递',
  tooLong.status === 400 && /最多/.test(tooLong.body.error ?? '') && captured.length === beforeLong,
  JSON.stringify(tooLong.body))

// ---- ② 没有 L1 的源：400，且不投递 ----
const before = captured.length
const noTarget = await call({ op: 'tune', name: 'onlycollect' })
ok('P30 只采集的源 → 400 且说清没有 L1',
  noTarget.status === 400 && /没有 L1|只采集/.test(noTarget.body.error ?? ''),
  JSON.stringify(noTarget.body))
ok('P30 被挡住的不投递', captured.length === before)

// ---- ③ 内置源与不存在的源 ----
const builtin = await call({ op: 'tune', name: 'disk' })
ok('P30 内置源 → 400 且说清由 profile 控制',
  builtin.status === 400 && /内置/.test(builtin.body.error ?? ''), JSON.stringify(builtin.body))
const missing = await call({ op: 'tune', name: 'nope' })
ok('P30 不存在的源 → 400', missing.status === 400 && /没有这个数据源/.test(missing.body.error ?? ''),
  JSON.stringify(missing.body))

// ---- ④ 一句话都不写盘 ----
ok('P30 collectors/ 没多文件', JSON.stringify(readdirSync(join(home, 'collectors')).sort()) === JSON.stringify(collectBefore))
ok('P30 targets/ 没多文件', JSON.stringify(readdirSync(join(home, 'targets')).sort()) === JSON.stringify(targetBefore))

// ---- ⑤ 投不出去 → 400 ----
agentReady = false
const failed = await call({ op: 'tune', name: 'demo' })
ok('P30 投递失败 → 400', failed.status === 400, JSON.stringify(failed.body))
ok('P30 失败原因说"没投到"', /没投|投不到|投递失败/.test(failed.body.error ?? ''), JSON.stringify(failed.body))
agentReady = true

// ---- ⑥ 指定投递对象：P33 ----
// 与建源同一条性质：选了 A 就必须投到 A，投不到就报错，绝不悄悄改投默认目标。
const beforePick = captured.length
const sentTo = await call({ op: 'tune', name: 'demo', target: '求职顾问' })
ok('P33 调优可以指定投递对象', sentTo.body.ok === true && sentTo.body.target === '求职顾问', JSON.stringify(sentTo.body))
ok('P33 调优解析的是被指定的会话', targeted.at(-1) === 's-career', String(targeted.at(-1)))
ok('P33 调优指定对象时真的投出去一条', captured.length === beforePick + 1, `${beforePick} -> ${captured.length}`)

const beforeUnknown = { captured: captured.length, targeted: targeted.length }
const unknownBot = await call({ op: 'tune', name: 'demo', target: '没这个bot' })
ok('P33 调优投给不存在的 Bot → 400 且写清名字',
  unknownBot.status === 400 && /没有这个 Bot/.test(unknownBot.body.error ?? '') && /没这个bot/.test(unknownBot.body.error ?? ''),
  JSON.stringify(unknownBot.body))
ok('P33 调优遇到不存在的 Bot 一条都不投',
  captured.length === beforeUnknown.captured && targeted.length === beforeUnknown.targeted,
  `${beforeUnknown.captured}->${captured.length}`)

failSessions.add('s-career')
const beforeFallback = { captured: captured.length, targeted: targeted.length }
const noFallback = await call({ op: 'tune', name: 'demo', target: '求职顾问' })
failSessions.delete('s-career')
ok('P33 调优指定对象投不出去 → 400', noFallback.status === 400, JSON.stringify(noFallback.body))
ok('P33 调优投不出去时不改投 Chief', targeted.slice(beforeFallback.targeted).every((sid) => sid === 's-career'),
  JSON.stringify(targeted.slice(beforeFallback.targeted)))
ok('P33 调优投不出去时没有多投出一条', captured.length === beforeFallback.captured, `${beforeFallback.captured} -> ${captured.length}`)

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
