// 重新设置投递目标：从面板请求走到真正的落盘（不启动 DSH）。
//
// 这条链要守的四件事：
//   ① 选中的群必须现在就存在 —— 否则 resolveWakeTarget 拿不到 session，
//      wakeL2 会退回默认私聊，等于让告警【悄悄改道】却不报错
//   ② 只动 wakeTo 一个键；displayName / interruptAlways / sources 一个字都不许丢
//   ③ wakeTo=null 是「跟随默认」，要把键【删掉】而不是留一个 null
//   ④ 没有对应 target 的源不许设 —— 设了也没有任何东西会读它
//
// 退出码：0 全过 / 1 有断言失败 / 2 未判定
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-waketo-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })
writeFileSync(join(home, 'state.json'), JSON.stringify({
  bots: { b_chief: { name: 'Chief', sessionId: 's-chief' }, b_hold: { name: '持仓管家', sessionId: 's-hold' } },
  rooms: { roomA: { name: '美股持仓' } },
}), 'utf8')

const noop = () => {}
const routes = []
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
      cb({ connection: { fetch: { register: (def) => { routes.push(def); return () => {} } } }, effect: (fn) => { try { fn() } catch {} } })
      return
    }
    cb({ sessionController: { resolveAgent: async () => ({ agent: {} }) }, effect: noop })
  },
}

apply(ctx, {
  statePath: join(home, 'state.json'),
  l0: { homeDir: home, sources: [], intervalMs: 3600000 },
  l1: { targets: [], targetBot: 'Chief', intervalMs: 3600000 },
})

const route = routes.find((r) => r.path === '/api/reflex')
if (!route) { console.error('未判定：/api/reflex 路由没注册上'); process.exit(2) }

const call = async (body) => {
  const res = await route.fetch({ json: async () => body })
  return { status: res.status, body: await res.json() }
}

// 两个源：demo 有 target；onlycollect 只有采集器。
writeFileSync(join(home, 'collectors', 'demo.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
writeFileSync(join(home, 'targets', 'demo.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
writeFileSync(join(home, 'targets', 'demo.env.json'), JSON.stringify({
  displayName: '原样保留', sources: ['demo'], minIntervalMs: 1800000, interruptAlways: true, env: { K: 'V' },
}, null, 2) + '\n', 'utf8')
writeFileSync(join(home, 'collectors', 'onlycollect.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })

const envPath = join(home, 'targets', 'demo.env.json')
const readEnv = () => JSON.parse(readFileSync(envPath, 'utf8'))
let pass = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return }
  console.error(`✖ ${name}${extra ? ' → ' + extra : ''}`); process.exitCode = 1
}

// ① 设成存在的群：落盘 + 其它键保留 + list 里读得到
{
  const r = await call({ op: 'setWakeTo', name: 'demo', wakeTo: { kind: 'group', name: '美股持仓' } })
  const env = readEnv()
  ok('设群：ok=true', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 160))
  ok('设群：env.wakeTo 写对', env.wakeTo?.kind === 'group' && env.wakeTo?.name === '美股持仓', JSON.stringify(env))
  ok('设群：displayName 原样', env.displayName === '原样保留')
  ok('设群：interruptAlways 原样', env.interruptAlways === true)
  ok('设群：env.K 原样', env.env?.K === 'V')
  const row = (r.body.sources ?? []).find((s) => s.name === 'demo')
  ok('设群：list 回读该行 wakeTo', row?.wakeTo?.name === '美股持仓', JSON.stringify(row))
  ok('设群：destinations 带群与 Bot', (r.body.destinations?.groups ?? []).includes('美股持仓') && (r.body.destinations?.bots ?? []).includes('持仓管家'))
}

// ② 不存在的群：400 + 人话 + 文件不动
{
  const before = readFileSync(envPath, 'utf8')
  const r = await call({ op: 'setWakeTo', name: 'demo', wakeTo: { kind: 'group', name: '不存在的群' } })
  ok('坏群：400', r.status === 400, String(r.status))
  ok('坏群：消息点名', /没有这个群/.test(r.body.error ?? ''), r.body.error)
  ok('坏群：文件未改', readFileSync(envPath, 'utf8') === before)
}

// ③ 清空 = 跟随默认：键要删掉
{
  const r = await call({ op: 'setWakeTo', name: 'demo', wakeTo: null })
  const env = readEnv()
  ok('清空：ok=true', r.body.ok === true)
  ok('清空：wakeTo 键已删除', !('wakeTo' in env), JSON.stringify(env))
  ok('清空：其它键仍在', env.displayName === '原样保留' && env.interruptAlways === true && env.sources?.[0] === 'demo')
}

// ④ 没有 target 的源：拒绝
{
  const r = await call({ op: 'setWakeTo', name: 'onlycollect', wakeTo: { kind: 'bot', name: 'Chief' } })
  ok('无 target：400', r.status === 400, String(r.status))
  ok('无 target：消息点名', /没有这个 target/.test(r.body.error ?? ''), r.body.error)
}

// ⑤ 不存在的 Bot：拒绝（与坏群同理，避免悄悄退回私聊）
{
  const r = await call({ op: 'setWakeTo', name: 'demo', wakeTo: { kind: 'bot', name: '查无此Bot' } })
  ok('坏 Bot：400', r.status === 400)
  ok('坏 Bot：消息点名', /没有这个 Bot/.test(r.body.error ?? ''), r.body.error)
}

if (process.exitCode === undefined) console.log(`✔ wake-to-route: ${pass} 条断言全过`)
