// 测「积压事实按顺序排干，不静默丢弃」。
//
// 背景(2026-11-19 实测): readNewFacts 一次读入超过 MAX_FACTS_PER_ROUND(1000) 条时,
// 旧实现 return { facts: out.slice(-1000), next } —— 只返回【最后】1000 条, 但 next
// 覆盖的是【全部读到的】行, advanceCursor 于是一路推到文件末尾。超出的部分被标记
// 已消费, 之后永远读不到。复现: 2500 条 → 首条 seq = 1501, 前 1500 条永久消失。
//
// 这个文件锁定三条行为:
//   1) 积压按【最前】N 条分批消费, 1000 → 1000 → 500, seq 连续;
//   2) 全部消费完之前不许推进游标越过未返回的部分(无缺口、无重复);
//   3) 多源场景下话痨源不能把另一个源挤出批次(守住 2026-10-16 那条)。
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const noop = () => {}
const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }
const lines = (p) => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] } }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} } }

const mkHome = (tag) => {
  const home = mkdtempSync(join(tmpdir(), `reflex-drain-${tag}-`))
  mkdirSync(join(home, 'collectors'), { recursive: true })
  mkdirSync(join(home, 'targets'), { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({ bots: { b: { name: 'Chief', sessionId: 's' } } }), 'utf8')
  return home
}
const mkCtx = () => ({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  on: noop, effect: noop, get: () => undefined,
  tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
  workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
  inject: (_d, cb) => cb({ sessionController: { resolveAgent: async () => ({ agent: { followup: noop } }) }, effect: noop }),
})
const mkApi = (home, targets) => apply(mkCtx(), {
  statePath: join(home, 'state.json'),
  l0: { homeDir: home, sources: [], intervalMs: 60000 },
  l1: { targets, targetBot: 'Chief', intervalMs: 60000 },
})

let pass = 0, total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}

// ---------- A. 单源 2500 条按顺序排干 ----------
{
  const home = mkHome('bulk')
  sh(join(home, 'collectors', 'bulk.sh'), [
    '#!/bin/bash',
    'if [ -f "$REFLEX_HOME/bulk-done" ]; then exit 0; fi',
    'touch "$REFLEX_HOME/bulk-done"',
    'i=1; while [ $i -le 2500 ]; do echo "{\\"metric\\":\\"m\\",\\"raw\\":{\\"seq\\":$i}}"; i=$((i+1)); done',
    '',
  ].join('\n'))
  writeFileSync(join(home, 'collectors', 'bulk.env.json'), JSON.stringify({ intervalMs: 60000 }), 'utf8')
  sh(join(home, 'targets', 'bulk-t.sh'), [
    '#!/bin/bash',
    'input=$(cat)',
    'n=$(printf "%s\\n" "$input" | grep -c \'"seq"\')',
    'first=$(printf "%s\\n" "$input" | grep -o \'"seq":[0-9]*\' | head -1 | cut -d: -f2)',
    'last=$(printf "%s\\n" "$input" | grep -o \'"seq":[0-9]*\' | tail -1 | cut -d: -f2)',
    'echo "${n:-0}|${first:--}|${last:--}" >> "$REFLEX_HOME/received.log"',
    'echo \'{"wake":false}\'',
    '',
  ].join('\n'))
  writeFileSync(join(home, 'targets', 'bulk-t.env.json'), JSON.stringify({ sources: ['bulk'], minIntervalMs: 0 }), 'utf8')

  const api = mkApi(home, ['bulk-t'])
  await api.collectOnce()
  for (let i = 0; i < 6; i++) await api.decideOnce()

  const recs = lines(join(home, 'received.log'))
  const cur = readJson(join(home, 'cursor.json'))
  const logTxt = (() => { try { return readFileSync(join(home, 'dsh-reflex.log'), 'utf8') } catch { return '' } })()

  console.log('=== A. 单源 2500 条按顺序排干 ===')
  ok('分三轮 1000 / 1000 / 500', recs.join(',') === '1000|1|1000,1000|1001|2000,500|2001|2500', `实际 [${recs.join(',')}]`)
  ok('排干后不再调用 target', recs.length === 3, `实际 ${recs.length} 轮`)

  const covered = new Map()
  for (const r of recs) {
    const [n, f, l] = r.split('|').map(Number)
    if (!Number.isFinite(f) || !Number.isFinite(l)) continue
    for (let s = f; s <= l; s++) covered.set(s, (covered.get(s) ?? 0) + 1)
  }
  ok('无缺口', covered.size === 2500, `覆盖 ${covered.size}/2500`)
  ok('无重复', [...covered.values()].every(v => v === 1), `重复 ${[...covered.values()].filter(v => v > 1).length} 条`)
  ok('游标停在最后一行', cur.bulk?.line === 2500, JSON.stringify(cur.bulk))
  ok('截断写日志, 不静默', (logTxt.match(/超过单轮上限/g) ?? []).length === 2, `实际 ${(logTxt.match(/超过单轮上限/g) ?? []).length} 次`)
}

// ---------- B. 多源: 话痨源不能把另一源挤出批次 ----------
{
  const home = mkHome('multi')
  sh(join(home, 'collectors', 'aaa.sh'), '#!/bin/bash\necho \'{"metric":"m","raw":{"src":"aaa"}}\'\n')
  sh(join(home, 'collectors', 'zzz.sh'), [
    '#!/bin/bash',
    'if [ -f "$REFLEX_HOME/zzz-done" ]; then exit 0; fi',
    'touch "$REFLEX_HOME/zzz-done"',
    'i=1; while [ $i -le 1500 ]; do echo "{\\"metric\\":\\"m\\",\\"raw\\":{\\"src\\":\\"zzz\\",\\"seq\\":$i}}"; i=$((i+1)); done',
    '',
  ].join('\n'))
  for (const s of ['aaa', 'zzz']) writeFileSync(join(home, 'collectors', `${s}.env.json`), JSON.stringify({ intervalMs: 60000 }), 'utf8')

  sh(join(home, 'targets', 'aaa-t.sh'), [
    '#!/bin/bash',
    'input=$(cat)',
    'n=$(printf "%s\\n" "$input" | grep -c \'"src":"aaa"\')',
    'echo "$n" >> "$REFLEX_HOME/aaa-inv.log"',
    'echo \'{"wake":false}\'',
    '',
  ].join('\n'))
  writeFileSync(join(home, 'targets', 'aaa-t.env.json'), JSON.stringify({ sources: ['aaa'], minIntervalMs: 0 }), 'utf8')

  const api = mkApi(home, ['aaa-t'])
  await api.collectOnce()
  for (let i = 0; i < 4; i++) { await api.collectOnce(); await api.decideOnce() }

  const inv = lines(join(home, 'aaa-inv.log'))
  console.log('\n=== B. 多源: 话痨源不能把另一源挤出批次 ===')
  ok('aaa 的 target 每轮都被调用', inv.length >= 3, `实际 ${inv.length} 次: [${inv.join(',')}]`)
  ok('每轮都能看到 aaa 的新事实', inv.filter(x => x !== '0').length >= 3, `实际 [${inv.join(',')}]`)
}

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
