// 数据源目录层的守门测试（S3）。
// 每条测试对应 property-register.md 里的一条性质；编号在测试名里，便于对表。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { scanSources, setPaused, respondToOp, buildDelegatePrompt, buildTunePrompt, TUNE_PREFERENCE_MAX, BUILTIN_SOURCES, SOURCE_ROUTE, SOURCE_ROUTE_CLIENT } from './sources.mjs'

const tempRoot = () => mkdtempSync(join(tmpdir(), 'reflex-sources-'))

/** 造一个目录：a 有 env，b 没有 env（真实世界里的 tidemark），c 已暂停，d 只有 schema。 */
function fixture() {
  const dir = tempRoot()
  writeFileSync(join(dir, 'a.sh'), '#!/bin/bash\nexit 0\n')
  writeFileSync(join(dir, 'a.env.json'), JSON.stringify({ intervalMs: 300000 }))
  writeFileSync(join(dir, 'b.sh'), '#!/bin/bash\nexit 0\n')
  writeFileSync(join(dir, 'c.sh'), '#!/bin/bash\nexit 0\n')
  writeFileSync(join(dir, 'c.paused'), '')
  writeFileSync(join(dir, 'd.sh'), '#!/bin/bash\nexit 0\n')
  writeFileSync(join(dir, 'd.schema.json'), JSON.stringify({ metric: 'paper', fields: {} }))
  return dir
}

test('P1 完备性：枚举以 *.sh 为准，没有 .env.json 的源也在列表里', () => {
  const dir = fixture()
  try {
    const rows = scanSources(dir)
    assert.deepEqual(rows.map((r) => r.name).sort(), ['a', 'b', 'c', 'd'])
    const a = rows.find((r) => r.name === 'a')
    const b = rows.find((r) => r.name === 'b')
    assert.equal(a.intervalMs, 300000)
    assert.equal(b.intervalMs, null)          // 缺 env.json → 跟随全局
    assert.equal(b.hasEnv, false)
    assert.equal(rows.find((r) => r.name === 'd').metric, 'paper')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P2 真相性：paused 字段等于 .paused 文件是否存在', () => {
  const dir = fixture()
  try {
    const pausedOf = () => Object.fromEntries(scanSources(dir).map((r) => [r.name, r.paused]))
    assert.deepEqual(pausedOf(), { a: false, b: false, c: true, d: false })
    writeFileSync(join(dir, 'b.paused'), '')
    assert.equal(pausedOf().b, true)          // 不读缓存，直接看盘
    rmSync(join(dir, 'c.paused'))
    assert.equal(pausedOf().c, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P3 可逆幂等：pause/resume 任意次后状态等于文件状态', () => {
  const dir = fixture()
  try {
    setPaused(dir, 'a', true)
    setPaused(dir, 'a', true)                 // 重复暂停不报错、不抖
    assert.ok(existsSync(join(dir, 'a.paused')))
    setPaused(dir, 'a', false)
    setPaused(dir, 'a', false)                // 重复恢复同样幂等
    assert.ok(!existsSync(join(dir, 'a.paused')))
    const rows = scanSources(dir)
    assert.equal(rows.find((r) => r.name === 'a').paused, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P4 内置源不可写：对内置源 pause 必须被拒，且不产生任何文件', () => {
  const dir = fixture()
  try {
    for (const name of BUILTIN_SOURCES) {
      assert.throws(() => setPaused(dir, name, true), /内置|builtin/i, `${name} 应当被拒绝`)
      assert.ok(!existsSync(join(dir, `${name}.paused`)))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P5 名不可越界：含 / .. 或未知的名字一律拒绝，不写任何文件', () => {
  const dir = fixture()
  try {
    for (const bad of ['../escape', 'a/b', '', 'nope', '.hidden']) {
      assert.throws(() => setPaused(dir, bad, true), /invalid|invalid name|非法/i, `应当拒绝 ${JSON.stringify(bad)}`)
    }
    assert.ok(!existsSync(join(dir, '..paused')))
    assert.ok(!existsSync(join(dir, 'a', '..paused')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P6 不依赖 manifest：目录里没有 manifest 时依然返回全量源', () => {
  const dir = fixture()
  try {
    assert.equal(existsSync(join(dir, 'manifest.json')), false)
    assert.equal(scanSources(dir).length, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P7 操作正确接线：pause/resume 落到 commit(name, 对应布尔)，未知 op 不写盘', () => {
  const calls = []
  let refreshed = 0
  const io = {
    list: () => ({ sources: [{ name: 'a', paused: false }], builtin: [] }),
    commit: (name, paused) => calls.push([name, paused]),
    refresh: () => { refreshed += 1 },
    log: () => {},
  }
  const r1 = respondToOp('pause', { name: 'a' }, io)
  const r2 = respondToOp('resume', { name: 'a' }, io)
  assert.deepEqual(calls, [['a', true], ['a', false]])   // 方向不能反
  assert.equal(refreshed, 2)                             // 每次改完都要重扫
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)

  const before = calls.length
  const r3 = respondToOp('nope', {}, io)
  assert.equal(r3.ok, false)
  assert.match(r3.error, /unknown op/)
  assert.equal(calls.length, before)                     // 未知 op 一个字都不许写
})

test('P9 宿主路由与客户端地址指向同一端点（差一个前导斜杠）', () => {
  assert.match(SOURCE_ROUTE, /^\/api\/[a-z][a-z0-9-]*$/, `宿主路由必须形如 /api/x，实际 ${SOURCE_ROUTE}`)
  const clientSrc = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  const m = clientSrc.match(/const SRC_ROUTE = "([^"]+)"/)
  assert.ok(m, 'client.js 里找不到 SRC_ROUTE')
  assert.equal(m[1], SOURCE_ROUTE_CLIENT, `客户端 ${m[1]} 与宿主 ${SOURCE_ROUTE} 不是同一个端点`)
})

// ---------------------------------------------------------------------------
// 一句话建源：用户只说一句，建源交给 bot 按 reflex-datasource 落盘。
// 这里守的是【提示词本身】——它是这条路上唯一的契约载体，缺一句就是一次隐性失败。
// ---------------------------------------------------------------------------

test('P23 一句话建源：原句原样进提示词，带标记与三条硬约束', () => {
  const sentence = '盯着 https://a.com 有更新就叫我'
  const p = buildDelegatePrompt(`  ${sentence}  `)
  assert.equal(typeof p, 'string')
  assert.ok(p.startsWith('[建源请求]'), `提示词没带标记（和 L1 告警混在一个收件箱里）：${p.slice(0, 40)}`)
  assert.ok(p.includes(sentence), '原句没原样进提示词（换了措辞就等于替用户改需求）')
  assert.ok(p.includes('reflex-datasource'), '没让 bot 加载 skill：契约在 skill 里，不加载就只能凭记忆写')
  assert.ok(/collectors\/<name>\.sh/.test(p) && /最后/.test(p), '没写「采集器最后落盘」这个提交点')
  assert.ok(/semantic/.test(p) && /(不叫醒|只记账)/.test(p), '没写语义判据的禁令与原因')
  assert.ok(/第二次|幂等/.test(p), '没要求双跑验幂等')
  assert.equal(p.includes('{{SENTENCE}}'), false, '占位符没替换干净')
})

test('P24 空句子与超长句子都建不出来（不做「帮用户兜一下」的猜测）', () => {
  assert.throws(() => buildDelegatePrompt('   '), /一句话/)
  assert.throws(() => buildDelegatePrompt('x'.repeat(501)), /太长/)
  assert.doesNotThrow(() => buildDelegatePrompt('x'.repeat(500)))
})

test('P25 delegate 只负责接线：交给注入的投递函数，没接线就明确失败', async () => {
  let seen = null
  const ok = await respondToOp('delegate', { sentence: '看 b.com' }, {
    delegate: async (body) => { seen = body; return { target: 'Chief' } },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.target, 'Chief')
  assert.equal(seen.sentence, '看 b.com')

  await assert.rejects(
    async () => { await respondToOp('delegate', { sentence: '看 b.com' }, {}) },
    /未接线/,
  )
})

// ---------------------------------------------------------------------------
// 逐行「L1 调优」：按钮只发请求，调优由 Chief 按 reflex-tuning 走四层。
// 提示词是这条路上唯一的契约载体：门槛不写进去，就等于靠现场的人现场拍脑袋。
// ---------------------------------------------------------------------------

test('P27 调优提示词：带标记、原样带源名、门槛与硬规矩都在', () => {
  const p = buildTunePrompt('x-timeline')
  assert.ok(p.startsWith('[调优请求]'), `没带标记：${p.slice(0, 40)}`)
  assert.ok(p.includes('x-timeline'), '源名没进提示词')
  assert.ok(p.includes('reflex-tuning'), '没让 bot 加载调优 skill')
  assert.ok(p.includes('shadow_targets.json'), '没让先读阈值登记表（拍脑袋换阈值的源头）')
  assert.ok(/100/.test(p) && /30/.test(p), '没有样本量分档（100 / 30）')
  assert.ok(/不许改任何文件/.test(p), '没有「样本太少不许改文件」这条')
  assert.ok(/A\/B|shadow_ab/.test(p), '没要求改判据先 A/B')
  assert.ok(/pc_inject/.test(p), '没要求重跑判据指纹')
  assert.ok(/不许自动转成叫醒|不许自动转正/.test(p), '没禁止语义 target 自动转正')
  assert.ok(/回滚/.test(p), '回报里没要求给回滚方式')
})

test('P28 调优请求的名字不合法就拒绝（不做兜底猜测）', () => {
  assert.throws(() => buildTunePrompt(''), /数据源/)
  assert.throws(() => buildTunePrompt('   '), /数据源/)
  assert.throws(() => buildTunePrompt('X-Timeline'), /名字/)
  assert.throws(() => buildTunePrompt('../etc'), /名字/)
})

test('P29b 用户偏好原样进提示词，且出现在规矩之前', () => {
  const pref = '宁可少叫我几次，也别漏掉事故'
  const p = buildTunePrompt('x-timeline', pref)

  assert.ok(p.includes(pref), '偏好没进提示词')
  assert.ok(p.indexOf(pref) < p.indexOf('先读现场'), '偏好排在规矩之后——bot 会先按旧口径动手')
  assert.ok(/原话/.test(p.slice(0, p.indexOf(pref))), '没说明这段是用户原话')
  assert.ok(p.indexOf(pref) < p.indexOf('不许改任何文件'), '偏好被写在了硬规矩后面，读起来像补充说明')

  // 空 / 纯空白偏好：与旧行为逐字一致（老调用方不受影响）
  const base = buildTunePrompt('x-timeline')
  assert.equal(buildTunePrompt('x-timeline', ''), base, '空串偏好改变了提示词')
  assert.equal(buildTunePrompt('x-timeline', '   '), base, '空白偏好改变了提示词')
  assert.equal(buildTunePrompt('x-timeline', null), base, 'null 偏好改变了提示词')

  // 长度闸：超一个就拒绝，正好等于上限放行
  assert.throws(() => buildTunePrompt('x-timeline', '字'.repeat(TUNE_PREFERENCE_MAX + 1)), /最多/)
  assert.ok(buildTunePrompt('x-timeline', '字'.repeat(TUNE_PREFERENCE_MAX)).includes('字'.repeat(TUNE_PREFERENCE_MAX)))
  assert.equal(TUNE_PREFERENCE_MAX, 500, '上限与客户端 PREFERENCE_MAX 必须同一个数（两处都写 500）')
})

test('P29 tune 只负责接线：交给注入的投递函数，没接线就明确失败', async () => {
  let seen = null
  const ok = await respondToOp('tune', { name: 'x-timeline' }, {
    tune: async (body) => { seen = body; return { target: 'Chief', name: body.name } },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.target, 'Chief')
  assert.equal(seen.name, 'x-timeline')

  await assert.rejects(async () => { await respondToOp('tune', { name: 'x' }, {}) }, /未接线/)
})
