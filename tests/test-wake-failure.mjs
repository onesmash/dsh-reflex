// 测「投递失败不能吞掉告警」。
//
// 背景(2026-10-15 实测): 插件重载时 sessionController 短暂不可用 → wakeL2 失败 →
// 老代码照样把指纹写进 last-wake.json → 同一条内容被永久去重, 那条"有人在等你回话"
// 就此消失, 没有任何人知道。
//
// 这个文件锁定两条行为:
//   1) 投递失败 → 不记指纹, 内容进 pending;
//   2) 通道恢复 → 下一轮必须补投, 且投出后才记指纹。
// 同时给一条反例: 投出之后同样内容不得重复投递。
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-wake-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })

const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }

// 采集器: 每轮产出一条事实 (facts 目录自建)
sh(join(home, 'collectors', 'probe.sh'), '#!/bin/bash\necho \'{"metric":"probe","raw":{"n":1}}\'\n')
writeFileSync(join(home, 'collectors', 'probe.env.json'), JSON.stringify({ intervalMs: 60000 }), 'utf8')

// target: 恒定命中 + 固定指纹 + 无冷却 (最坏情况: 每轮都想唤醒)
sh(join(home, 'targets', 'probe.sh'),
  '#!/bin/bash\ncat >/dev/null\necho \'{"wake":true,"reason":"probe 命中","fingerprint":{"ids":["p1"]},"items":[{"id":"p1","title":"t","body":"b"}]}\'\n')
writeFileSync(join(home, 'targets', 'probe.env.json'), JSON.stringify({ sources: ['probe'], minIntervalMs: 0 }), 'utf8')

// 让 botSessionId("Chief") 找得到会话
const statePath = join(home, 'state.json')
writeFileSync(statePath, JSON.stringify({ bots: { 'bot-chief': { name: 'Chief', sessionId: 'session-chief' } } }), 'utf8')

const delivered = []
const workingSc = { resolveAgent: async () => ({ agent: { followup: (m) => delivered.push(m) } }) }

// 模拟 cordis 注入: 先注入一个"没有 resolveAgent"的服务(= 插件重载窗口), 之后可重挂
let attach = null
const noop = () => {}
const ctx = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  on: noop, effect: noop, get: () => undefined,
  tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
  workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
  inject: (_deps, cb) => { attach = cb; cb({ sessionController: null, effect: noop }) },
}

const api = apply(ctx, {
  statePath,
  l0: { homeDir: home, sources: ['probe'] },
  l1: { targets: ['probe'], targetBot: 'Chief', intervalMs: 60000 },
})

const readJson = (f) => { try { return JSON.parse(readFileSync(join(home, f), 'utf8')) } catch { return {} } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let pass = 0, total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}

console.log('=== A. 唤醒通道不可用(插件重载窗口) ===')
await sleep(200)                       // 让 apply 内部的首次采集落盘
await api.collectOnce()
await api.decideOnce()
ok('没有投出去', delivered.length === 0, `delivered=${delivered.length}`)
ok('投递失败时不写指纹', !readJson('last-wake.json').probe, JSON.stringify(readJson('last-wake.json')))
ok('内容进 pending 等重试', (readJson('pending-wakes.json').probe?.items ?? []).length === 1,
   JSON.stringify(readJson('pending-wakes.json')).slice(0, 120))

console.log('\n=== B. 通道恢复 → 必须补投 ===')
attach({ sessionController: workingSc, effect: noop })   // 服务重新注入
await api.collectOnce()
await api.decideOnce()
ok('恢复后补投成功', delivered.length === 1, `delivered=${delivered.length}`)
ok('投出去了才记指纹', !!readJson('last-wake.json').probe, JSON.stringify(readJson('last-wake.json')))
ok('投出后清掉 pending', !readJson('pending-wakes.json').probe, JSON.stringify(readJson('pending-wakes.json')).slice(0, 120))

console.log('\n=== C. 反例: 同一内容不得重复投递 ===')
await api.collectOnce()
await api.decideOnce()
ok('指纹生效, 不重复打扰', delivered.length === 1, `delivered=${delivered.length}`)

console.log(`\n结果: ${pass}/${total} 通过`)
if (pass !== total) console.log(`⚠️ 有 ${total - pass} 项未通过`)
process.exit(pass === total ? 0 : 1)
