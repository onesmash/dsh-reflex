// 测「加源免重启」: 运行中的插件, 往 collectors/ 与 targets/ 丢新脚本,
// 下一轮采集/决策就应生效 —— 不改配置、不改插件码、不重启。
//
// 背景: 2026-10-16 加 edgar-filings 源时, 除丢脚本外还必须改 profile 的
// l0.sources/l1.targets 并重启 DSH。本次给插件加了目录签名门控的热发现
// (refreshDiscovery), 本文件锁定该行为:
//   1) 运行中新增 脚本源+脚本target → 下一轮即被采集并唤醒;
//   2) 删除 target 脚本 → 立即停叫;
//   3) 既有源不受影响。
import { writeFileSync, mkdtempSync, mkdirSync, chmodSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-hotadd-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })

const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }

// 初始: 一个采集源 probe + 它的 target (基线, 类似既有的 disk)
// probe 每轮产出唯一 n → target 指纹唯一 → 每轮都是"新内容"可唤醒 (冷却去重只压同内容)
sh(join(home, 'collectors', 'probe.sh'), '#!/bin/bash\necho "{\\"metric\\":\\"probe\\",\\"raw\\":{\\"n\\":$RANDOM}}"\n')
writeFileSync(join(home, 'collectors', 'probe.env.json'), JSON.stringify({ intervalMs: 1000 }), 'utf8')
sh(join(home, 'targets', 'probe-t.sh'),
  '#!/bin/bash\nN=$(python3 -c "import sys,json;rows=[json.loads(l) for l in sys.stdin if l.strip()];print(rows[-1][\'raw\'][\'n\'] if rows else 0)")\necho "{\\"wake\\":true,\\"reason\\":\\"probe\\",\\"fingerprint\\":{\\"ids\\":[\\"p$N\\"]},\\"items\\":[{\\"id\\":\\"p$N\\",\\"title\\":\\"t\\",\\"body\\":\\"b\\"}]}"\n')
writeFileSync(join(home, 'targets', 'probe-t.env.json'), JSON.stringify({ sources: ['probe'], minIntervalMs: 0 }), 'utf8')

const statePath = join(home, 'state.json')
writeFileSync(statePath, JSON.stringify({ bots: { 'bot-chief': { name: 'Chief', sessionId: 'session-chief' } } }), 'utf8')

const delivered = []
const workingSc = { resolveAgent: async () => ({ agent: { followup: (m) => delivered.push(m) } }) }
const noop = () => {}
const ctx = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  on: noop, effect: noop, get: () => undefined,
  tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
  workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
  inject: (_deps, cb) => { cb({ sessionController: workingSc, effect: noop }) },
}

const api = apply(ctx, {
  statePath,
  l0: { homeDir: home, sources: ['probe'], intervalMs: 60000 },
  l1: { targets: ['probe-t'], targetBot: 'Chief', intervalMs: 60000 },
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0, total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}

await sleep(200)
await api.collectOnce()
await api.decideOnce()
ok('基线源正常唤醒', delivered.length === 1, `delivered=${delivered.length}`)
let mark = delivered.length

// ---- 热加: 运行中丢一个新 采集器+target (不碰配置, 不重启) ----
sh(join(home, 'collectors', 'hot2.sh'), '#!/bin/bash\necho \'{"metric":"hot2","raw":{"n":1}}\'\n')
writeFileSync(join(home, 'collectors', 'hot2.env.json'), JSON.stringify({ intervalMs: 1000 }), 'utf8')
sh(join(home, 'targets', 'hot2-t.sh'),
  '#!/bin/bash\ncat >/dev/null\necho \'{"wake":true,"reason":"hot2","fingerprint":{"ids":["h1"]},"items":[{"id":"h1","title":"t","body":"b"}]}\'\n')
writeFileSync(join(home, 'targets', 'hot2-t.env.json'), JSON.stringify({ sources: ['hot2'], minIntervalMs: 0 }), 'utf8')

await sleep(1100)                      // 等下一轮节拍
await api.collectOnce()
await api.decideOnce()
// probe 因新指纹 +1, 新 target hot2 +1 → 共 +2
ok('热加的源/target 下一轮即生效 (无重启)', delivered.length === mark + 2, `delivered=${mark}→${delivered.length}`)

// ---- 热删: 删掉新 target → 立即停叫 (只剩 probe 的 +1) ----
unlinkSync(join(home, 'targets', 'hot2-t.sh'))
unlinkSync(join(home, 'targets', 'hot2-t.env.json'))
await sleep(1100)
await api.collectOnce()
await api.decideOnce()
ok('热删 target → 立即停叫 (只剩基线源 +1)', delivered.length === mark + 3, `delivered=${delivered.length}`)

// ---- 既有源不受热加/热删影响 ----
await api.collectOnce()
await api.decideOnce()
ok('既有源仍正常唤醒', delivered.length === mark + 4, `delivered=${delivered.length}`)

console.log(`\n结果: ${pass}/${total} 通过`)
if (pass !== total) console.log(`⚠️ 有 ${total - pass} 项未通过`)
process.exit(pass === total ? 0 : 1)
