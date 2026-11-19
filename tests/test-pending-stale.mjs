// 测「暂存条目可以过期作废」。
//
// 背景(2026-11-19 实测): live-asr 旧句子被补投。当时打分器因为一个空环境变量全挂,
// 句子以「未打分」状态进了 pending; 十几分钟后修好, 那条 **12 分钟前的句子** 才叫醒我。
// 对实时转写这种流式源, 迟到的补投没有任何价值 —— 用户听到的是早已过去的话。
//
// 这个文件锁定两条行为:
//   1) 声明了 pendingMaxAgeMs 的 target, 暂存里超过保鲜期的条目必须丢弃(整批都过期 → 不唤醒);
//   2) 没声明(或声明 0)的 target 保持旧语义: 攒多久都补投, 一条不少。
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const fails = []
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `  <- ${detail}`))
  if (!cond) fails.push(name)
}

const noop = () => {}
const delivered = []
const workingSc = { resolveAgent: async () => ({ agent: { followup: (m) => delivered.push(m) } }) }
const ctx = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  on: noop, effect: noop, get: () => undefined,
  tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
  workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
  inject: (_d, cb) => cb({ sessionController: workingSc, effect: noop }),
}

const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }

function setUp(tag, targetEnv, pendingItems) {
  const home = mkdtempSync(join(tmpdir(), `reflex-stale-${tag}-`))
  mkdirSync(join(home, 'collectors'), { recursive: true })
  mkdirSync(join(home, 'targets'), { recursive: true })
  // 一次性源: 只吐一条, 之后不再有事实 —— 于是唤醒只能来自 pending 补发
  sh(join(home, 'collectors', 'one.sh'), '#!/bin/bash\necho \'{"metric":"m","raw":{"n":1}}\'\n')
  writeFileSync(join(home, 'collectors', 'one.env.json'), JSON.stringify({ intervalMs: 3600000 }), 'utf8')
  // target: 本轮没有新事实(one 源只吐一次), 所以它不会产出新 ctx
  sh(join(home, 'targets', 'feed.sh'),
    '#!/bin/bash\ncat >/dev/null\necho \'{"wake":false}\'\n')
  writeFileSync(join(home, 'targets', 'feed.env.json'),
    JSON.stringify({ sources: ['one'], minIntervalMs: 0, ...targetEnv }), 'utf8')
  writeFileSync(join(home, 'state.json'),
    JSON.stringify({ bots: { 'bot-chief': { name: 'Chief', sessionId: 'session-chief' } } }), 'utf8')
  writeFileSync(join(home, 'pending-wakes.json'), JSON.stringify({
    feed: {
      kind: 'script-target', reason: '暂存补发', header: null, fingerprint: null,
      items: pendingItems, noticed: [], scanned: 1, rounds: 1, carried: 0,
    },
  }), 'utf8')
  return home
}

const api = (home) => apply(ctx, {
  statePath: join(home, 'state.json'),
  l0: { homeDir: home, sources: ['one'], intervalMs: 60000 },
  l1: { targets: ['feed'], targetBot: 'Chief', intervalMs: 60000 },
})

const textOf = (m) => JSON.stringify(m?.content ?? m ?? '')

// ① 全部过期 → 不许唤醒
const oldTs = Date.now() - 12 * 60 * 1000
const homeA = setUp('a', { pendingMaxAgeMs: 120000 }, [
  { id: 'live-asr:1.00', title: '旧', body: '十二分钟前的旧句子', ts: oldTs },
])
const apiA = api(homeA)
await apiA.collectOnce()          // 让源把唯一一条事实吐掉
await new Promise(r => setTimeout(r, 50))
await apiA.decideOnce()
check('过期的暂存不补投', delivered.length === 0, `delivered=${delivered.length} ${textOf(delivered[0]).slice(0, 60)}`)
check('过期条目被清出 pending', !existsSync(join(homeA, 'pending-wakes.json')) ||
  !JSON.stringify(JSON.parse(readFileSync(join(homeA, 'pending-wakes.json'), 'utf8'))).includes('十二分钟前的旧句子'),
  readFileSync(join(homeA, 'pending-wakes.json'), 'utf8').slice(0, 100))

// ② 没过期 → 照常补投
delivered.length = 0
const homeB = setUp('b', { pendingMaxAgeMs: 120000 }, [
  { id: 'live-asr:2.00', title: '新', body: '一分钟前的新句子', ts: Date.now() - 60000 },
])
const apiB = api(homeB)
await apiB.collectOnce()
await new Promise(r => setTimeout(r, 50))
await apiB.decideOnce()
check('未过期的暂存照常补投', delivered.length === 1 && textOf(delivered[0]).includes('一分钟前的新句子'),
  `delivered=${delivered.length} ${textOf(delivered[0]).slice(0, 80)}`)

// ③ 声明了保鲜期却【没有 ts】的条目 → 按过期处理
// （实测 2026-11-19: 老格式条目没有 ts，于是 12 分钟前的句子照样补投了两次。
//   不知道多旧 = 不能投，这条必须是硬的，不能靠"没有 ts 就当新鲜"。）
delivered.length = 0
const homeD = setUp('d', { pendingMaxAgeMs: 120000 }, [
  { id: 'live-asr:4.00', title: '无戳', body: '没有时间戳的旧格式条目' },
])
const apiD = api(homeD)
await apiD.collectOnce()
await new Promise(r => setTimeout(r, 50))
await apiD.decideOnce()
check('声明了保鲜期但条目无 ts → 不补投', delivered.length === 0, `delivered=${delivered.length}`)

// ④ 没声明 pendingMaxAgeMs → 旧语义, 攒多久都补投
delivered.length = 0
const homeC = setUp('c', {}, [
  { id: 'live-asr:3.00', title: '旧', body: '没声明保鲜期的旧句子', ts: Date.now() - 12 * 60 * 1000 },
])
const apiC = api(homeC)
await apiC.collectOnce()
await new Promise(r => setTimeout(r, 50))
await apiC.decideOnce()
check('未声明保鲜期时照旧补投', delivered.length === 1 && textOf(delivered[0]).includes('没声明保鲜期的旧句子'),
  `delivered=${delivered.length}`)

console.log()
if (fails.length) { console.log(`${fails.length} 项失败：${fails}`); process.exit(1) }
console.log('全部通过')
process.exit(0)
