// 锁「manifest 必须跟着【内容】刷新, 而不是只跟【源名集合】刷新」。
//
// 背景 (2026-11-27 建 baba-move 源时踩到): collectors/<name>.sh 先落盘、<name>.schema.json
// 后补; 两次之间源名集合没变, 于是 index.js 的 refreshDiscovery 里
//   if (before !== after) writeManifest()
// 不成立 → manifest.json 里该源的 schema 永久停在 null、l1Targets 的 minIntervalMs 停在旧值。
// 运行时内存读的是新 schema, 所以功能正常、界面上看不出来 —— 正是最难发现的那种坏。
//
// 本文件两条断言:
//   1) 源脚本已存在后再补 <name>.schema.json → manifest 里该源 schema 必须变成非 null;
//   2) 改 targets/<name>.env.json 的 minIntervalMs → manifest l1Targets 必须跟着变。

import { writeFileSync, mkdtempSync, mkdirSync, chmodSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-manifest-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })

const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 基线: probe 采集器(带 schema) + 它的 target
sh(join(home, 'collectors', 'probe.sh'), '#!/bin/bash\necho \'{"metric":"probe","raw":{"n":1}}\'\n')
writeFileSync(join(home, 'collectors', 'probe.env.json'), JSON.stringify({ intervalMs: 50 }), 'utf8')
writeFileSync(join(home, 'collectors', 'probe.schema.json'), JSON.stringify({ metric: 'probe', fields: { n: '数字' } }), 'utf8')
sh(join(home, 'targets', 'probe-t.sh'),
  '#!/bin/bash\ncat >/dev/null\necho \'{"wake":false,"reason":"x","fingerprint":{"ids":[]},"items":[]}\'\n')
const probeTargetEnv = (minIntervalMs) =>
  JSON.stringify({ sources: ['probe'], minIntervalMs })
writeFileSync(join(home, 'targets', 'probe-t.env.json'), probeTargetEnv(60000), 'utf8')

const statePath = join(home, 'state.json')
writeFileSync(statePath, JSON.stringify({ bots: { 'bot-chief': { name: 'Chief', sessionId: 'session-chief' } } }), 'utf8')

const workingSc = { resolveAgent: async () => ({ agent: { followup: () => {} } }) }
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
  l0: { homeDir: home, sources: ['probe'], intervalMs: 50 },
  l1: { targets: ['probe-t'], targetBot: 'Chief', intervalMs: 50 },
})

let pass = 0, total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}

// manifest 路径: <storeDir>/manifest.json, 不写死名字, 在 home 下找
function findManifest() {
  for (const d of readdirSync(home)) {
    try {
      const p = join(home, d, 'manifest.json')
      readFileSync(p)
      return p
    } catch {}
  }
  return null
}
const readManifest = () => JSON.parse(readFileSync(findManifest(), 'utf8'))
const srcEntry = (src) => (readManifest().schema.sources || []).find(s => s.source === src)
const tgtEntry = (t) => (readManifest().schema.l1Targets || []).find(s => s.target === t)

await sleep(120)
await api.collectOnce()
ok('基线 manifest 已生成', findManifest() !== null)
ok('基线源的 schema 已写入 manifest', (srcEntry('probe') || {}).schema !== null,
  `schema=${JSON.stringify((srcEntry('probe') || {}).schema)}`)

// ---- 场景 1: 源脚本先落盘(无 schema), schema 后补 ----
sh(join(home, 'collectors', 'late.sh'), '#!/bin/bash\necho \'{"metric":"late","raw":{"v":2}}\'\n')
writeFileSync(join(home, 'collectors', 'late.env.json'), JSON.stringify({ intervalMs: 50 }), 'utf8')
await sleep(120)
await api.collectOnce()
ok('late 源被发现(此时无 schema)', srcEntry('late') !== undefined)
ok('late 无 schema 时 manifest 记 null(符合预期)', (srcEntry('late') || {}).schema === null,
  `schema=${JSON.stringify((srcEntry('late') || {}).schema)}`)

// 关键: 只补 schema, 源名集合不变
writeFileSync(join(home, 'collectors', 'late.schema.json'),
  JSON.stringify({ metric: 'late', fields: { v: '数值' } }), 'utf8')
await sleep(120)
await api.collectOnce()
ok('补了 .schema.json 后 manifest 必须刷新(源名集合未变)', (srcEntry('late') || {}).schema !== null,
  `schema=${JSON.stringify((srcEntry('late') || {}).schema)}`)

// ---- 场景 2: target 的 minIntervalMs 改了 ----
writeFileSync(join(home, 'targets', 'probe-t.env.json'), probeTargetEnv(5000), 'utf8')
await sleep(120)
await api.collectOnce()
ok('target minIntervalMs 改动后 manifest 必须刷新', (tgtEntry('probe-t') || {}).minIntervalMs === 5000,
  `minIntervalMs=${JSON.stringify((tgtEntry('probe-t') || {}).minIntervalMs)}`)

console.log(`\n结果: ${pass}/${total} 通过`)
if (pass !== total) console.log(`⚠️ 有 ${total - pass} 项未通过`)
process.exit(pass === total ? 0 : 1)
