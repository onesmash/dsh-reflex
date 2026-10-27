// 测「脚本源 / 脚本 target 不需要写进配置」。
//
// 背景(2026-10-27): 加 github-trending / a-share-theme 时又去改了 profile 的
// l0.sources / l1.targets，理由是"采集源要重读配置"——其实插件早就是 drop-in 自动启用
// (test-hot-add-source.mjs 早就锁过这个行为)。那次多余的 profile 改动反而触发了插件重载,
// 重载窗口里丢了一轮 pending。本文件把这条行为从"没测过"变成"回归锁住":
//   1) 配置里只写内置源(disk)/内置 target(disk) 时: 脚本源照样采集、脚本 target 照样跑;
//   2) 把脚本源/脚本 target 写进配置: 启动日志会点名"这是冗余的, 可以删掉";
//   3) 安装日志里的 sources=[...] 是【实际生效集】(含自动发现的脚本源), 不是配置里那截。
import { writeFileSync, mkdtempSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }
const noop = () => {}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function makeHome(tag) {
  const home = mkdtempSync(join(tmpdir(), `reflex-cfgopt-${tag}-`))
  mkdirSync(join(home, 'collectors'), { recursive: true })
  mkdirSync(join(home, 'targets'), { recursive: true })
  sh(join(home, 'collectors', 'probe.sh'), '#!/bin/bash\necho \'{"metric":"probe","raw":{"n":1}}\'\n')
  writeFileSync(join(home, 'collectors', 'probe.env.json'), JSON.stringify({ intervalMs: 1000 }), 'utf8')
  sh(join(home, 'targets', 'probe-t.sh'),
    '#!/bin/bash\ncat >/dev/null\necho \'{"wake":true,"reason":"probe 命中","fingerprint":{"ids":["p1"]},"items":[{"id":"p1","title":"t","body":"b"}]}\'\n')
  writeFileSync(join(home, 'targets', 'probe-t.env.json'), JSON.stringify({ sources: ['probe'], minIntervalMs: 0 }), 'utf8')
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify({ bots: { 'bot-chief': { name: 'Chief', sessionId: 'session-chief' } } }), 'utf8')
  return { home, statePath, logFile: join(home, 'dsh-reflex.log') }
}

function makeCtx(delivered) {
  const sc = { resolveAgent: async () => ({ agent: { followup: (m) => delivered.push(m) } }) }
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    on: noop, effect: noop, get: () => undefined,
    tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
    workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
    inject: (_deps, cb) => { cb({ sessionController: sc, effect: noop }) },
  }
}

let pass = 0, total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}

// ---------- A. 配置只写内置源/内置 target → 脚本源/target 照样生效 ----------
console.log('=== A. 配置只写 disk, 脚本源与脚本 target 仍然生效 ===')
const a = makeHome('a')
const deliveredA = []
const apiA = apply(makeCtx(deliveredA), {
  statePath: a.statePath,
  l0: { homeDir: a.home, sources: ['disk'], intervalMs: 60000 },
  l1: { targets: ['disk'], targetBot: 'Chief', intervalMs: 60000 },
})
await sleep(250)                       // 等 install 里的首次 scanScriptSources 落盘
await apiA.collectOnce()
await apiA.decideOnce()
const factsA = join(a.home, 'facts', 'probe')
ok('脚本源 probe 被自动采集 (配置里没有它)', existsSync(factsA), existsSync(join(a.home, 'facts')))
ok('脚本 target 被自动启用并唤醒 (配置里没有它)', deliveredA.length >= 1, `delivered=${deliveredA.length}`)
const logA = existsSync(a.logFile) ? readFileSync(a.logFile, 'utf8') : ''
ok('启动日志的 sources=[...] 含自动发现的 probe', /installed:.*sources=\[[^\]]*probe[^\]]*\]/.test(logA),
   logA.split('\n').filter(l => l.includes('installed')).slice(-1)[0] || '(无 installed 日志)')

// ---------- B. 把脚本源/脚本 target 写进配置 → 应被点名"冗余" ----------
console.log('\n=== B. 冗余配置会被点名提醒 ===')
const b = makeHome('b')
apply(makeCtx([]), {
  statePath: b.statePath,
  l0: { homeDir: b.home, sources: ['disk', 'probe'], intervalMs: 60000 },
  l1: { targets: ['disk', 'probe-t'], targetBot: 'Chief', intervalMs: 60000 },
})
await sleep(600)
const logB = existsSync(b.logFile) ? readFileSync(b.logFile, 'utf8') : ''
ok('提示 l0.sources 里 probe 是冗余的', /l0\.sources 里的 \[probe\]/.test(logB),
   logB.split('\n').filter(l => l.includes('l0.sources 里的')).slice(-1)[0] || '(无提示)')
ok('提示 l1.targets 里 probe-t 是冗余的', /l1\.targets 里的 \[probe-t\]/.test(logB),
   logB.split('\n').filter(l => l.includes('l1.targets 里的')).slice(-1)[0] || '(无提示)')

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
