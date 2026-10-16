// 测「每个源的去重游标要各自前进」。
//
// 背景(2026-10-16 实测): readNewFacts 把每个源未读的行都扫进一个数组, 但只返回
// 最后那个有新行的源的位置, advanceCursor 于是只推进【一个】源。其余源每轮都把
// 历史全量重投一遍; 数组末尾 .slice(-100) 一截, 排在字母表前面的源(cpu-top /
// jira-my-tasks)永远进不了批次 —— 它们的 target 因此一次都没跑过, 是死代码。
//
// 这个文件锁定两条行为:
//   1) 每个源处理完都留下自己的游标(不是只留一个);
//   2) 一个"排在最前、但每轮都有新事实"的源, 它的 target 每轮都要跑 ——
//      哪怕同轮里还有一个话痨源在吐数据。
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-cursor-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })

const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }

// aaa: 每轮 1 条 —— 名字排最前, 就是被测对象 (现实里对应 cpu-top)
sh(join(home, 'collectors', 'aaa.sh'), '#!/bin/bash\necho \'{"metric":"m","raw":{"src":"aaa"}}\'\n')
// mmm: 每轮 30 条 —— 话痨源, 现实里对应 disk/swap
sh(join(home, 'collectors', 'mmm.sh'),
  '#!/bin/bash\nfor i in $(seq 1 30); do echo \'{"metric":"m","raw":{"src":"mmm"}}\'; done\n')
// zzz: 每轮 1 条 —— 名字排最后, 现实里对应 zoom-im
sh(join(home, 'collectors', 'zzz.sh'), '#!/bin/bash\necho \'{"metric":"m","raw":{"src":"zzz"}}\'\n')
for (const s of ['aaa', 'mmm', 'zzz']) {
  writeFileSync(join(home, 'collectors', `${s}.env.json`), JSON.stringify({ intervalMs: 1000 }), 'utf8')
}

// target 只关心 aaa。它被调用一次就在 $REFLEX_HOME/invocations.log 记一行,
// 并记下这一轮真正收到几条 aaa 事实 —— 历史重投会让这个数字越滚越大。
sh(join(home, 'targets', 'aaa-t.sh'), [
  '#!/bin/bash',
  'input=$(cat)',
  'n=$(printf "%s\\n" "$input" | grep -c \'"src":"aaa"\')',
  'echo "$n" >> "$REFLEX_HOME/invocations.log"',
  'echo \'{"wake":true,"reason":"aaa 本轮 \'"$n"\' 条","fingerprint":{"ids":["aaa-\'"$n"\'"]},"items":[{"id":"i","title":"t","body":"b"}]}\'',
  '',
].join('\n'))
writeFileSync(join(home, 'targets', 'aaa-t.env.json'),
  JSON.stringify({ sources: ['aaa'], minIntervalMs: 0 }), 'utf8')

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
  l0: { homeDir: home, sources: ['aaa', 'mmm', 'zzz'], intervalMs: 60000 },
  l1: { targets: ['aaa-t'], targetBot: 'Chief', intervalMs: 60000 },
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const readJson = (f) => { try { return JSON.parse(readFileSync(join(home, f), 'utf8')) } catch { return {} } }
const invocations = () => {
  try { return readFileSync(join(home, 'invocations.log'), 'utf8').trim().split('\n').filter(Boolean) } catch { return [] }
}

let pass = 0, total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}

// 跑 5 轮: 第 1 轮三方全量入库, 之后话痨源 mmm 的历史会把批次越撑越大。
// 老代码在第 4 轮前后就把 aaa 挤出 slice(-100), aaa 的 target 从此不再被调用。
const ROUNDS = 5
for (let i = 1; i <= ROUNDS; i++) {
  await sleep(1100)
  await api.collectOnce()
  await api.decideOnce()
}

const inv = invocations()
const cur = readJson('cursor.json')

console.log('=== A. 每个源都要留下自己的游标 ===')
for (const s of ['aaa', 'mmm', 'zzz']) {
  ok(`${s} 有游标`, !!cur[s], `cursor.json=${JSON.stringify(cur)}`)
}

console.log('\n=== B. 排在最前的源, 每轮都要送到它的 target ===')
ok(`跑了 ${ROUNDS} 轮就该被调用 ${ROUNDS} 次`, inv.length === ROUNDS, `实际 ${inv.length} 次: [${inv.join(',')}]`)

console.log('\n=== C. 送进去的必须是新事实, 不是历史重投 ===')
// 第 1 轮可能是 2: apply() 自己会先采一次, 那一轮的两条都是真·新事实。
ok('首轮之后每轮恰好 1 条 aaa 新事实', inv.slice(1).every(n => n === '1'), `每轮收到: [${inv.join(',')}]`)
ok('数字不随轮次增长 (历史重投的典型症状)', Math.max(...inv.map(Number)) <= 2, `每轮收到: [${inv.join(',')}]`)

console.log('\n=== D. 决策能投出去 ===')
ok('至少投出一次告警', delivered.length >= 1, `delivered=${delivered.length}`)

console.log(`\n结果: ${pass}/${total} 通过`)
if (pass !== total) console.log(`⚠️ 有 ${total - pass} 项未通过`)
process.exit(pass === total ? 0 : 1)
