// 测「投递方式」：followup 排队 vs steer 插话。
//
// 背景(2026-11-19 实测): 实时转写的三条唤醒在 16:00:40~16:04:29 发出, 我却在
// 16:10 / 16:14 / 16:17 才读到 —— 因为 wake 走 agent.followup, 排在当前回合之后。
// 对实时流, 瓶颈不在采集/判定, 在「我的回合有多长」。
//
// 这个文件锁定两条行为:
//   1) 缺省仍然 followup 排队(不打断正在干的活);
//   2) target 声明 wakeMode:"steer" 时改用 steer 插话(agent 两个方法都在的情况下)。
import { writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const fails = []
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `  <- ${detail}`))
  if (!cond) fails.push(name)
}

const noop = () => {}
const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }

function scenario(tag, targetEnv) {
  const home = mkdtempSync(join(tmpdir(), `reflex-mode-${tag}-`))
  mkdirSync(join(home, 'collectors'), { recursive: true })
  mkdirSync(join(home, 'targets'), { recursive: true })
  sh(join(home, 'collectors', 'p.sh'), '#!/bin/bash\necho \'{"metric":"m","raw":{"n":1}}\'\n')
  writeFileSync(join(home, 'collectors', 'p.env.json'), JSON.stringify({ intervalMs: 60000 }), 'utf8')
  sh(join(home, 'targets', 'p-t.sh'),
    '#!/bin/bash\ncat >/dev/null\necho \'{"wake":true,"reason":"命中","fingerprint":{"ids":["p1"]},"items":[{"id":"p1","title":"t","body":"b","ts":' + Date.now() + '}]}\'\n')
  writeFileSync(join(home, 'targets', 'p-t.env.json'),
    JSON.stringify({ sources: ['p'], minIntervalMs: 0, ...targetEnv }), 'utf8')
  writeFileSync(join(home, 'state.json'),
    JSON.stringify({ bots: { 'bot-chief': { name: 'Chief', sessionId: 'session-chief' } } }), 'utf8')

  const calls = { followup: 0, steer: 0 }
  const agent = {
    followup: () => { calls.followup++ },
    steer: () => { calls.steer++ },
  }
  const sc = { resolveAgent: async () => ({ agent }) }
  const ctx = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    on: noop, effect: noop, get: () => undefined,
    tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
    workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
    inject: (_d, cb) => cb({ sessionController: sc, effect: noop }),
  }
  const api = apply(ctx, {
    statePath: join(home, 'state.json'),
    l0: { homeDir: home, sources: ['p'], intervalMs: 60000 },
    l1: { targets: ['p-t'], targetBot: 'Chief', intervalMs: 60000 },
  })
  return { api, calls }
}

const a = scenario('default', {})
await a.api.collectOnce()
await a.api.decideOnce()
check('缺省走 followup 排队', a.calls.followup === 1 && a.calls.steer === 0,
  JSON.stringify(a.calls))

const b = scenario('steer', { wakeMode: 'steer' })
await b.api.collectOnce()
await b.api.decideOnce()
check('wakeMode=steer 时插话', b.calls.steer === 1 && b.calls.followup === 0,
  JSON.stringify(b.calls))

console.log()
if (fails.length) { console.log(`${fails.length} 项失败：${fails}`); process.exit(1) }
console.log('全部通过')
process.exit(0)
