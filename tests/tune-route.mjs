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
  bots: { b_chief: { name: 'Chief', sessionId: 's-chief' } },
  rooms: {},
}), 'utf8')

const captured = []
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
        resolveAgent: async () => (agentReady
          ? { agent: { followup: (msg) => { captured.push(msg) } } }
          : { agent: {} }),
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
ok('P30 真的投出去一条', captured.length === 1, `captured=${captured.length}`)
const text = textOf(captured[0] ?? { content: [] })
ok('P30 提示词带 [调优请求]', text.startsWith('[调优请求]'), text.slice(0, 40))
ok('P30 源名原样进提示词', text.includes('demo'))
ok('P30 先读阈值登记表', text.includes('shadow_targets.json'))
ok('P30 带信号量分档与 A/B 规矩', /100/.test(text) && /30/.test(text) && /pc_inject/.test(text))
ok('P30 消息 source.role=post', captured[0]?.source?.role === 'post', String(captured[0]?.source?.role))

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

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
