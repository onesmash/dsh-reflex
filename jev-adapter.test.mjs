// 行为测试：锁住 jev 适配器的对外契约，重构前后必须逐条不变。
// 跑法：node --test dsh-reflex/jev-adapter.test.mjs
//
// 测试只调用模块的公开导出的方式，断言调用方会看到的结果（ub-mode: Test Behavior,
// Not Implementation）。不 mock 内部函数，只用假 fetch 截住网络边界。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scoreRow, scoreBatch, writeShadow } from './jev-adapter.mjs'

const okBody = (probs, choice) => ({
  model: 'decision-model-preview',
  answers: { q: { type: 'choice', choice, confidence: 0.73, probabilities: probs } },
  latency_ms: 36.5,
})

/** 假 fetch：记录请求，回放固定响应。 */
function fakeFetch(response, sink = {}) {
  return async (url, init) => {
    sink.url = url
    sink.body = JSON.parse(init.body)
    sink.headers = init.headers
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.json,
      text: async () => response.text ?? '',
    }
  }
}

const baseOpts = (fetchImpl) => ({
  url: 'https://example.test/v1/systemone',
  model: 'decision-model-preview',
  apiKey: 'sk-test',
  fetchImpl,
})

const row = (over = {}) => ({
  id: 'r1',
  state: { availableGB: 10 },
  question: '磁盘可用空间是否不足？',
  options: [
    { id: 'yes', description: '不足' },
    { id: 'no', description: '充足' },
  ],
  ...over,
})

// ---------------------------------------------------------------- 请求构造

test('请求体：state 对象被序列化，criteria 用 description', async () => {
  const sink = {}
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 0.9, no: 0.1 }, 'yes') }, sink)
  await scoreRow(row(), baseOpts(fetchImpl))
  assert.equal(sink.body.model, 'decision-model-preview')
  assert.equal(sink.body.state, '{"availableGB":10}')
  assert.equal(sink.body.questions.q.question, '磁盘可用空间是否不足？')
  assert.deepEqual(sink.body.questions.q.criteria, { yes: '不足', no: '充足' })
  assert.equal(sink.headers.Authorization, 'Bearer sk-test')
})

test('请求体：无 description 时 criteria 回退成 option id，绝不发 null', async () => {
  const sink = {}
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 1, no: 0 }, 'yes') }, sink)
  await scoreRow(row({ options: [{ id: 'yes' }, { id: 'no' }] }), baseOpts(fetchImpl))
  assert.deepEqual(sink.body.questions.q.criteria, { yes: 'yes', no: 'no' })
})

test('无可用选项时拒绝发请求', async () => {
  let called = false
  const fetchImpl = async () => { called = true; throw new Error('should not run') }
  await assert.rejects(() => scoreRow(row({ options: [] }), baseOpts(fetchImpl)), /no options to score/)
  assert.equal(called, false)
})

// ---------------------------------------------------------------- 响应解析

test('解析：choice 命中时以 choice 为准', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 0.9, no: 0.1 }, 'yes') })
  const r = await scoreRow(row(), baseOpts(fetchImpl))
  assert.equal(r.winning, 'yes')
  assert.equal(r.pYes, 0.9)
  assert.deepEqual(r.probs, { yes: 0.9, no: 0.1 })
})

test('解析：无 choice 时取概率最大项', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 0.2, no: 0.7, mid: 0.1 }, undefined) })
  const r = await scoreRow(row(), baseOpts(fetchImpl))
  assert.equal(r.winning, 'no')
  assert.equal(r.pYes, 0.2)
})

test('解析：概率里没有 yes 时 pYes 为 0，且不抛错', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ a: 0.6, b: 0.4 }, 'a') })
  const r = await scoreRow(row(), baseOpts(fetchImpl))
  assert.equal(r.winning, 'a')
  assert.equal(r.pYes, 0)
})

test('解析：缺 answers.q 时报错并带响应片段', async () => {
  const fetchImpl = fakeFetch({ status: 200, json: { oops: true } })
  await assert.rejects(() => scoreRow(row(), baseOpts(fetchImpl)), /missing answers\.q/)
})

test('HTTP 非 2xx 时抛出带状态码与正文的错误', async () => {
  const fetchImpl = fakeFetch({ status: 400, text: 'invalid SystemOne request: Field required: state' })
  await assert.rejects(() => scoreRow(row(), baseOpts(fetchImpl)), /jev HTTP 400.*Field required: state/)
})

// ---------------------------------------------------------------- URL 拼装

test('URL：裸 host 自动补 /v1/systemone', async () => {
  const sink = {}
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 1, no: 0 }, 'yes') }, sink)
  await scoreBatch([row()], { baseUrl: 'https://api.example.com/', model: 'm', fetchImpl })
  assert.equal(sink.url, 'https://api.example.com/v1/systemone')
})

test('URL：已以 /systemone 结尾时不再重复拼接', async () => {
  const sink = {}
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 1, no: 0 }, 'yes') }, sink)
  await scoreBatch([row()], {
    baseUrl: 'https://x.test/compatible-mode/v1/systemone',
    model: 'm',
    fetchImpl,
  })
  assert.equal(sink.url, 'https://x.test/compatible-mode/v1/systemone')
})

test('URL：只写到 .../v1（少 /systemone）时明确拒绝，不发请求', async () => {
  // 2026-11-23 实测：这种写法会被补成 .../v1/v1/systemone → HTTP 404，
  // 而报错出现在 L1 日志里、离配置很远。归一化这一层就该拒绝并说清怎么改。
  const sink = {}
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 1, no: 0 }, 'yes') }, sink)
  await assert.rejects(
    () => scoreBatch([row()], { baseUrl: 'https://x.test/compatible-mode/v1', model: 'm', fetchImpl }),
    /v1.*systemone|多了一段版本路径/i,
  )
  assert.equal(sink.url, undefined, '拒绝时不许发出任何请求')
})

test('URL：模板占位符（[workspace-id]）明确拒绝，不发请求', async () => {
  const sink = {}
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 1, no: 0 }, 'yes') }, sink)
  await assert.rejects(
    () => scoreBatch([row()], { baseUrl: 'https://[workspace-id].cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'm', fetchImpl }),
    /合法|invalid|workspace-id/i,
  )
  assert.equal(sink.url, undefined, '拒绝时不许发出任何请求')
})

test('URL：路径前缀 .../compatible-mode 补成 canonical（与裸 host 同类）', async () => {
  const sink = {}
  const fetchImpl = fakeFetch({ status: 200, json: okBody({ yes: 1, no: 0 }, 'yes') }, sink)
  await scoreBatch([row()], { baseUrl: 'https://x.test/compatible-mode', model: 'm', fetchImpl })
  assert.equal(sink.url, 'https://x.test/compatible-mode/v1/systemone')
})

// ---------------------------------------------------------------- 批量语义

test('批量：部分失败时保留成功行并回调 onError', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.state.includes('bad')) {
      return { ok: false, status: 500, text: async () => 'boom' }
    }
    return { ok: true, status: 200, json: async () => okBody({ yes: 0.8, no: 0.2 }, 'yes') }
  }
  const errs = []
  const res = await scoreBatch(
    [row({ id: 'ok1' }), row({ id: 'bad1', state: { x: 'bad' } })],
    { baseUrl: 'https://x.test', model: 'm', fetchImpl, onError: (e) => errs.push(...e) },
  )
  assert.equal(res.size, 1)
  assert.ok(res.has('ok1'))
  assert.equal(errs.length, 1)
  assert.match(errs[0], /bad1/)
})

test('批量：全部失败时整体抛出', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' })
  await assert.rejects(
    () => scoreBatch([row()], { baseUrl: 'https://x.test', model: 'm', fetchImpl }),
    /jev HTTP 500/,
  )
})

test('批量：空输入返回空 Map 且不发请求', async () => {
  let called = false
  const fetchImpl = async () => { called = true }
  const res = await scoreBatch([], { baseUrl: 'https://x.test', model: 'm', fetchImpl })
  assert.equal(res.size, 0)
  assert.equal(called, false)
})

// ---------------------------------------------------------------- shadow

const SHADOW_FIELDS = [
  'ts', 'mode', 'tag', 'key', 'state_hash', 'id',
  'score', 'threshold', 'passed', 'p_yes', 'question', 'state',
]

test('shadow：字段集合与 shadow_record.py 完全一致', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-'))
  const results = new Map([['r1', { winning: 'no', pYes: 0.09, probs: { yes: 0.09, no: 0.91 } }]])
  const n = writeShadow({ homeDir: home, tag: 'disk', rows: [row()], results, threshold: 0.8 })
  assert.equal(n, 1)
  const file = readdirSync(join(home, 'shadow'))[0]
  const rec = JSON.parse(readFileSync(join(home, 'shadow', file), 'utf8').trim())
  assert.deepEqual(Object.keys(rec).sort(), [...SHADOW_FIELDS].sort())
  assert.equal(rec.tag, 'disk')
  assert.equal(rec.mode, 'live')
  assert.equal(rec.score, 0.09)
  assert.equal(rec.p_yes, 0.09)
  assert.equal(rec.threshold, 0.8)
  assert.equal(rec.passed, false)
  assert.equal(rec.key.length, 16)
  assert.equal(rec.state_hash.length, 16)
})

test('shadow：passed 依阈值翻转', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-'))
  const results = new Map([['r1', { winning: 'yes', pYes: 0.91, probs: { yes: 0.91, no: 0.09 } }]])
  writeShadow({ homeDir: home, tag: 'disk', rows: [row()], results, threshold: 0.8 })
  const file = readdirSync(join(home, 'shadow'))[0]
  const rec = JSON.parse(readFileSync(join(home, 'shadow', file), 'utf8').trim())
  assert.equal(rec.passed, true)
})

test('shadow：阈值缺省时 passed 为 null', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-'))
  const results = new Map([['r1', { winning: 'no', pYes: 0.1, probs: { yes: 0.1, no: 0.9 } }]])
  writeShadow({ homeDir: home, tag: 'disk', rows: [row()], results })
  const file = readdirSync(join(home, 'shadow'))[0]
  const rec = JSON.parse(readFileSync(join(home, 'shadow', file), 'utf8').trim())
  assert.equal(rec.threshold, null)
  assert.equal(rec.passed, null)
})

test('shadow：同一文件追加而不覆盖', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-'))
  const results = new Map([['r1', { winning: 'no', pYes: 0.1, probs: { yes: 0.1 } }]])
  writeShadow({ homeDir: home, tag: 'disk', rows: [row()], results, threshold: 0.8, now: Date.now() })
  writeShadow({ homeDir: home, tag: 'disk', rows: [row()], results, threshold: 0.8, now: Date.now() })
  const file = readdirSync(join(home, 'shadow'))[0]
  const lines = readFileSync(join(home, 'shadow', file), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

test('shadow：无结果时不写文件、不抛错', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-'))
  assert.equal(writeShadow({ homeDir: home, tag: 'disk', rows: [row()], results: new Map() }), 0)
  assert.deepEqual(readdirSync(home), [])
})

test('shadow：未被打分的行被跳过', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-'))
  const results = new Map([['r1', { winning: 'no', pYes: 0.1, probs: { yes: 0.1 } }]])
  const n = writeShadow({
    homeDir: home, tag: 'disk', threshold: 0.8, results,
    rows: [row(), row({ id: 'r2' })],
  })
  assert.equal(n, 1)
})

test('shadow：写盘失败时静默返回 0（绝不影响判定）', () => {
  const n = writeShadow({
    homeDir: '/dev/null/not-a-dir',
    tag: 'disk',
    rows: [row()],
    results: new Map([['r1', { winning: 'no', pYes: 0.1, probs: { yes: 0.1 } }]]),
    threshold: 0.8,
  })
  assert.equal(n, 0)
})

// ---------------------------------------------------------------- 多 question

const multiBody = (answers) => ({
  model: 'decision-model-preview',
  answers,
})

const multiRow = (over = {}) => ({
  id: 'm1',
  state: '推文正文',
  questions: [
    { id: 'q1', type: 'choice', question: '值得打断吗？',
      options: [{ id: 'yes', description: '值得' }, { id: 'no', description: '不值得' }] },
    { id: 'q2', type: 'noul', question: '技术价值(0-1)' },
  ],
  ...over,
})

test('多 question：请求体按 id 展开，choice 带 criteria、noul 不带', async () => {
  const sink = {}
  const ff = fakeFetch({ status: 200, json: multiBody({
    q1: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
    q2: { type: 'noul', noul: 0.42 },
  }) }, sink)
  await scoreRow(multiRow(), baseOpts(ff))
  assert.deepEqual(Object.keys(sink.body.questions).sort(), ['q1', 'q2'])
  assert.deepEqual(sink.body.questions.q1.criteria, { yes: '值得', no: '不值得' })
  assert.equal(sink.body.questions.q2.criteria, undefined, 'noul 不应带 criteria')
  assert.equal(sink.body.questions.q2.type, 'noul')
})

test('多 question：perQuestion 返回每一个的结果', async () => {
  const ff = fakeFetch({ status: 200, json: multiBody({
    q1: { type: 'choice', choice: 'no', probabilities: { yes: 0.2, no: 0.8 } },
    q2: { type: 'noul', noul: 0.42 },
  }) })
  const r = await scoreRow(multiRow(), baseOpts(ff))
  assert.equal(r.perQuestion.q1.winning, 'no')
  assert.equal(r.perQuestion.q1.probs.yes, 0.2)
  assert.equal(r.perQuestion.q2.noul, 0.42)
  // noul 数值即概率，不应被当作 confidence 丢失
  assert.equal(r.perQuestion.q2.probs.yes, 0.42)
})

test('多 question：顶层字段取第一个 question，老调用方解构不炸', async () => {
  const ff = fakeFetch({ status: 200, json: multiBody({
    q1: { type: 'choice', choice: 'yes', probabilities: { yes: 0.77, no: 0.23 } },
    q2: { type: 'noul', noul: 0.5 },
  }) })
  const r = await scoreRow(multiRow(), baseOpts(ff))
  assert.equal(r.winning, 'yes')
  assert.equal(r.pYes, 0.77)
  assert.deepEqual(r.probs, { yes: 0.77, no: 0.23 })
})

test('多 question：缺任一 qid 的 answers 时报错并带片段', async () => {
  const ff = fakeFetch({ status: 200, json: multiBody({
    q1: { type: 'choice', choice: 'yes', probabilities: { yes: 1, no: 0 } },
  }) })
  await assert.rejects(() => scoreRow(multiRow(), baseOpts(ff)),
    /missing answers\.q2/)
})

test('多 question：question 缺 id 时本地就拒绝，不发请求', async () => {
  let called = false
  const ff = async () => { called = true; throw new Error('不该发请求') }
  await assert.rejects(
    () => scoreRow(multiRow({ questions: [{ type: 'noul', question: 'x' }] }), baseOpts(ff)),
    /question without id/)
  assert.equal(called, false)
})

test('单 question 行为不受多 question 支持影响（回归）', async () => {
  const sink = {}
  const ff = fakeFetch({ status: 200, json: okBody({ yes: 0.6, no: 0.4 }, 'yes') }, sink)
  const r = await scoreRow(row(), baseOpts(ff))
  assert.deepEqual(Object.keys(sink.body.questions), ['q'], '仍是单个 q')
  assert.equal(r.pYes, 0.6)
  assert.equal(r.perQuestion, undefined, '单 question 不带 perQuestion')
})
