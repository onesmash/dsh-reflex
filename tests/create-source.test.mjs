// 「在 Trigger 页新增数据源」的守门测试（S3）。
//
// 三段式 = give / when / trigger：
//   give    采集命令（stdout 每行一个 JSON fact）
//   when    intervalMs
//   trigger 判定方式，决定要不要生成 targets/<name>.sh
//
// 每条测试对应 docs/property-register-sources.md 里的一条性质（编号在测试名里，便于对表）。
// 这里不测「字符串长得对不对」，而是把生成的脚本**真的跑起来**，看它的行为：
// 首跑建水位、第二轮只发新增、第三轮幂等、target 命中才叫醒。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseNewSource,
  createSource,
  summarizeProbe,
  respondToOp,
  BUILTIN_SOURCES,
} from '../sources.mjs'

/** 造一对目录：collectors/ 与 targets/ 都空。 */
function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'reflex-newsrc-'))
  const collectors = join(root, 'collectors')
  const targets = join(root, 'targets')
  mkdirSync(collectors, { recursive: true })
  mkdirSync(targets, { recursive: true })
  return { root, collectors, targets }
}

const ctx = (d) => ({ collectorsDir: d.collectors, targetsDir: d.targets, builtins: BUILTIN_SOURCES })

/** 跑一个 bash 脚本，可选喂 stdin，返回 {rc, stdout, stderr}。 */
function run(path, { stdin = '', env = {} } = {}) {
  const r = spawnSync('/bin/bash', [path], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000,
  })
  return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 把采集器的 stdout 解析成 facts 数组（只保留合法 JSON 行）。 */
const facts = (stdout) => stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

/** 造一个「命令读文件」的源；文件内容即采集命令的输出。 */
function makeFileSource(d, extra = {}, fileBody = '') {
  const spec = parseNewSource({ name: 'probe', about: '测试源', cmd: 'cat "$RH/fixture.txt"', intervalMs: 900000, trigger: { mode: 'off' }, ...extra }, ctx(d))
  const out = createSource({ collectorsDir: d.collectors, targetsDir: d.targets }, spec)
  writeFileSync(join(d.root, 'fixture.txt'), fileBody)
  return { spec, out }
}

// ---------- P10 give：采集器的水位与幂等 ----------

test('P10 首跑只建水位：第一次跑不发数据行，只发一条 scan 汇总', () => {
  const d = dirs()
  try {
    makeFileSource(d, {}, ['{"metric":"item","raw":{"k":"a"}}', '{"metric":"item","raw":{"k":"b"}}'].join('\n') + '\n')
    const r = run(join(d.collectors, 'probe.sh'), { env: { REFLEX_HOME: d.root } })
    assert.equal(r.rc, 0, `采集器退出码 ${r.rc}：${r.stderr}`)
    const rows = facts(r.stdout)
    assert.equal(rows.length, 1, `首跑应只发 1 条 scan，实际 ${rows.length} 条：${r.stdout}`)
    assert.equal(rows[0].metric, 'probe-scan')
    assert.equal(rows[0].raw.seeded, true)
    assert.equal(rows[0].raw.new, 0)
    assert.equal(rows[0].raw.total, 2)
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

test('P10 第二轮只发新增行（原样转发），已有行不再发；第三轮幂等', () => {
  const d = dirs()
  try {
    makeFileSource(d, {}, '{"metric":"item","raw":{"k":"a"}}\n{"metric":"item","raw":{"k":"b"}}\n')
    run(join(d.collectors, 'probe.sh'), { env: { REFLEX_HOME: d.root } })      // 建水位

    writeFileSync(join(d.root, 'fixture.txt'),
      '{"metric":"item","raw":{"k":"a"}}\n{"metric":"item","raw":{"k":"b"}}\n{"metric":"item","raw":{"k":"c"}}\n')
    const r2 = run(join(d.collectors, 'probe.sh'), { env: { REFLEX_HOME: d.root } })
    assert.equal(r2.rc, 0, r2.stderr)
    const rows2 = facts(r2.stdout)
    assert.equal(rows2.length, 2, `应只发 1 条新数据 + 1 条 scan，实际：${r2.stdout}`)
    assert.deepEqual(rows2[0].raw, { k: 'c' })          // 数据行原样转发
    assert.equal(rows2[1].metric, 'probe-scan')
    assert.equal(rows2[1].raw.new, 1)

    const r3 = run(join(d.collectors, 'probe.sh'), { env: { REFLEX_HOME: d.root } })
    const rows3 = facts(r3.stdout)
    assert.equal(rows3.length, 1, `没有新行时应只发 scan，实际：${r3.stdout}`)
    assert.equal(rows3[0].raw.new, 0)
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

test('P10 采集命令失败且没输出 → 退出非 0（记 failed），不伪装成"本轮无数据"', () => {
  const d = dirs()
  try {
    const spec = parseNewSource({ name: 'broken', cmd: 'exit 3', intervalMs: 900000, trigger: { mode: 'off' } }, ctx(d))
    createSource({ collectorsDir: d.collectors, targetsDir: d.targets }, spec)
    const r = run(join(d.collectors, 'broken.sh'), { env: { REFLEX_HOME: d.root } })
    assert.notEqual(r.rc, 0, '命令失败还退出 0 = 静默失败')
    assert.equal(r.stdout.trim(), '', '失败时不应往 stdout 写任何东西')
    assert.match(r.stderr, /broken/, 'stderr 要说明是哪个源')
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

test('P10 输出全是非法 JSON → 退出非 0，不把垃圾当数据', () => {
  const d = dirs()
  try {
    makeFileSource(d, { name: 'junk' }, 'not json\nnope\n')
    run(join(d.collectors, 'junk.sh'), { env: { REFLEX_HOME: d.root } })     // 首跑建水位（此时无所谓）
    const r = run(join(d.collectors, 'junk.sh'), { env: { REFLEX_HOME: d.root } })
    assert.notEqual(r.rc, 0, '没有一行是合法 JSON 也不能退出 0')
    assert.equal(r.stdout.trim(), '')
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

// ---------- P11 when：间隔落到 env.json，不写也别丢 ----------

test('P11 采集间隔落到 <name>.env.json，缺省也带 timeoutMs', () => {
  const d = dirs()
  try {
    makeFileSource(d, { intervalMs: 300000 })
    const env = JSON.parse(readFileSync(join(d.collectors, 'probe.env.json'), 'utf8'))
    assert.equal(env.intervalMs, 300000)
    assert.ok(Number.isFinite(env.timeoutMs) && env.timeoutMs >= 60000, 'timeoutMs 太小会把慢源杀在半路')
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

// ---------- P12 trigger：判定脚本只在命中时叫醒 ----------

test('P12 trigger=all：有新数据就叫醒，scan 汇总行不算数据；只有 scan 时不出声', () => {
  const d = dirs()
  try {
    makeFileSource(d, { trigger: { mode: 'all' } })
    const tgt = join(d.targets, 'probe.sh')
    assert.ok(existsSync(tgt), 'trigger 不是 off 就必须生成 target 脚本')

    const onlyScan = JSON.stringify({ source: 'probe', metric: 'probe-scan', raw: { ok: true, new: 0 } }) + '\n'
    const r1 = run(tgt, { stdin: onlyScan })
    assert.equal(r1.rc, 0, r1.stderr)
    assert.equal(r1.stdout.trim(), '', 'scan 汇总行不该叫醒任何人')

    const withData = onlyScan + JSON.stringify({ source: 'probe', metric: 'item', raw: { title: '有新的东西' } }) + '\n'
    const r2 = run(tgt, { stdin: withData })
    assert.equal(r2.rc, 0, r2.stderr)
    const lines = r2.stdout.trim().split('\n')
    assert.equal(lines.length, 1, `target 的 stdout 必须恰好一行决策，实际 ${lines.length} 行`)
    const decision = JSON.parse(lines[0])
    assert.equal(decision.wake, true)
    assert.equal(decision.items.length, 1)
    assert.match(decision.items[0].body, /有新的东西/)
    assert.deepEqual(decision.fingerprint.ids, [decision.items[0].id], '指纹必须与条目 id 对齐，否则去重失效')
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

test('P12 trigger=match：命中关键词才叫醒，不命中必须一个字都不输出', () => {
  const d = dirs()
  try {
    makeFileSource(d, { trigger: { mode: 'match', keywords: ['裁员', '仲裁'] } })
    const tgt = join(d.targets, 'probe.sh')
    const miss = JSON.stringify({ source: 'probe', metric: 'item', raw: { title: '公司年会抽奖' } }) + '\n'
    const r1 = run(tgt, { stdin: miss })
    assert.equal(r1.rc, 0, r1.stderr)
    assert.equal(r1.stdout.trim(), '', '没命中还在 stdout 输出 = 会乱叫')

    const hit = miss + JSON.stringify({ source: 'probe', metric: 'item', raw: { title: '公司开始裁员' } }) + '\n'
    const r2 = run(tgt, { stdin: hit })
    const decisions = r2.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].items.length, 1)
    assert.match(decisions[0].items[0].body, /裁员/)
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

test('P12 trigger=semantic：只打分记账，不叫醒（影子模式）', () => {
  const d = dirs()
  try {
    makeFileSource(d, { trigger: { mode: 'semantic', criteria: '这条内容是否值得我立刻处理？' } })
    const tgt = join(d.targets, 'probe.sh')
    const stdin = JSON.stringify({ source: 'probe', metric: 'item', raw: { title: '随便一条' } }) + '\n'
    const r = run(tgt, { stdin })
    assert.equal(r.rc, 0, r.stderr)
    assert.equal(r.stdout.trim(), '', '影子模式下不许叫醒')
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

test('P12 trigger=off：只采集不叫醒，不生成任何 target 文件', () => {
  const d = dirs()
  try {
    makeFileSource(d, { trigger: { mode: 'off' } })
    assert.deepEqual(readdirSync(d.targets), [], 'trigger=off 不该在 targets/ 里留东西')
    assert.deepEqual(readdirSync(d.collectors).sort(), ['probe.env.json', 'probe.schema.json', 'probe.sh'])
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

// ---------- P13 名字与输入：非法输入一个文件都不写 ----------

test('P13 非法名字/命令/触发方式一律拒绝，且不产生任何文件', () => {
  const d = dirs()
  try {
    const bad = [
      [{ name: '../escape', cmd: 'echo 1' }, /名称|name/],
      [{ name: 'My Source', cmd: 'echo 1' }, /名称|name/],
      [{ name: '.hidden', cmd: 'echo 1' }, /名称|name/],
      [{ name: 'ok', cmd: '   ' }, /命令/],
      [{ name: 'ok', cmd: 'echo 1', trigger: { mode: 'weird' } }, /trigger|触发/],
      [{ name: 'ok', cmd: 'echo 1', trigger: { mode: 'match', keywords: [] } }, /关键词/],
      [{ name: 'ok', cmd: 'echo 1', trigger: { mode: 'semantic', criteria: ' ' } }, /判据/],
      [{ name: 'ok', cmd: 'echo 1', intervalMs: 10 }, /间隔|interval/],
    ]
    for (const [body, why] of bad) {
      assert.throws(() => parseNewSource({ intervalMs: 900000, trigger: { mode: 'off' }, ...body }, ctx(d)), why,
        `应当拒绝 ${JSON.stringify(body)}`)
    }
    for (const name of BUILTIN_SOURCES) {
      assert.throws(() => parseNewSource({ name, cmd: 'echo 1', intervalMs: 900000, trigger: { mode: 'off' } }, ctx(d)), /内置|builtin/)
    }
    assert.deepEqual(readdirSync(d.collectors), [])
    assert.deepEqual(readdirSync(d.targets), [])
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

test('P13 已存在的源不许覆盖：第二次创建被拒，第一次的文件一字不改', () => {
  const d = dirs()
  try {
    makeFileSource(d, {}, '{"a":1}\n')
    const before = readFileSync(join(d.collectors, 'probe.sh'), 'utf8')
    // 解析层带目录时先拒一次：界面能早报错靠的就是它
    assert.throws(() => parseNewSource({ name: 'probe', cmd: 'echo 2', intervalMs: 900000, trigger: { mode: 'off' } }, ctx(d)), /已存在/)
    // 写盘层必须自己再拒一次 —— createSource 可以被直接调用，不能指望调用方先查重
    const spec = parseNewSource({ name: 'probe', cmd: 'echo 2', intervalMs: 900000, trigger: { mode: 'off' } }, { builtins: BUILTIN_SOURCES })
    assert.throws(() => createSource({ collectorsDir: d.collectors, targetsDir: d.targets }, spec), /已存在/)
    assert.equal(readFileSync(join(d.collectors, 'probe.sh'), 'utf8'), before, '被拒之后旧脚本不能被动过')
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

test('P13 语法检查不通过 → 一个文件都不留（含 .tmp 残渣）', () => {
  const d = dirs()
  try {
    const spec = parseNewSource({ name: 'syntax', cmd: 'echo 1', intervalMs: 900000, trigger: { mode: 'all' } }, ctx(d))
    assert.throws(() => createSource({ collectorsDir: d.collectors, targetsDir: d.targets }, spec, { check: () => { throw new Error('syntax error') } }), /syntax error/)
    assert.deepEqual(readdirSync(d.collectors), [], '检查失败还留下文件 = 半成品数据源')
    assert.deepEqual(readdirSync(d.targets), [])
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})

// ---------- P14 试跑：把命令的输出翻成可判断的摘要 ----------

test('P14 试跑摘要：行数/合法行数/样例行三样都要对得上', () => {
  const s = summarizeProbe('{"a":1}\nnot json\n\n{"b":2}\n')
  assert.equal(s.lines, 3, '空行不算行')
  assert.equal(s.valid, 2)
  assert.equal(s.bad, 1)
  assert.deepEqual(s.sample, ['{"a":1}', 'not json', '{"b":2}'])
  const empty = summarizeProbe('   \n')
  assert.equal(empty.lines, 0)
  assert.equal(empty.valid, 0)
})

// ---------- 路由接线 ----------

test('create/probe 两个 op 走 io 注入，未知 op 仍然不写盘', async () => {
  let refreshed = 0
  const created = []
  const io = {
    list: () => ({ sources: [], builtin: [] }),
    commit: () => {},
    refresh: () => { refreshed += 1 },
    log: () => {},
    create: (body) => { created.push(body); return { created: ['collectors/x.sh'] } },
    probe: (body) => ({ lines: 1, valid: 1, bad: 0, sample: ['{}'], cmd: body.cmd }),
  }
  const r1 = respondToOp('create', { name: 'x', cmd: 'echo {}' }, io)
  assert.equal(r1.ok, true)
  assert.equal(r1.created.length, 1)
  assert.equal(refreshed, 1, '创建完必须立刻重扫，否则界面要等下一轮才看到')

  const r2 = await respondToOp('probe', { cmd: 'echo {}' }, io)
  assert.equal(r2.ok, true)
  assert.equal(r2.valid, 1)

  const before = created.length
  const r3 = respondToOp('nope', {}, io)
  assert.equal(r3.ok, false)
  assert.equal(created.length, before)
})

test('创建后的文件权限可执行（插件用 /bin/bash 跑，但人手也要能直接跑）', () => {
  const d = dirs()
  try {
    makeFileSource(d, {}, '{"a":1}\n')
    const st = spawnSync('stat', ['-f', '%Lp', join(d.collectors, 'probe.sh')], { encoding: 'utf8' })
    assert.match(st.stdout.trim(), /7[0-9]{2}/, `权限不对：${st.stdout.trim()}`)
  } finally { rmSync(d.root, { recursive: true, force: true }) }
})
