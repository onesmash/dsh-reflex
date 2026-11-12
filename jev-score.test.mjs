// jev-score CLI 的行为测试：起一个本地 HTTP 假端点，跑真实进程。
// 跑法：node --test dsh-reflex/jev-score.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'jev-score.mjs')

let server
let baseUrl
let handler

before(async () => {
  server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => new Promise((resolve) => server.close(resolve)))

/** 让假端点回放：按请求里的 criteria 生成概率。 */
function respondWith(map = () => ({ yes: 0.8, no: 0.2 })) {
  handler = (req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        const pick = map(parsed)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          answers: { q: { type: 'choice', probabilities: pick } },
          latency_ms: 1,
        }))
      } catch (error) {
        res.writeHead(500)
        res.end(`handler error: ${error.message}`)
      }
    })
  }
}

const workdir = () => mkdtempSync(join(tmpdir(), 'jev-score-test-'))

const inputRows = [
  { id: 'a', state: { gb: 10 }, question: 'q1', options: [{ id: 'yes', description: 'y' }, { id: 'no', description: 'n' }] },
  { id: 'b', state: { gb: 200 }, question: 'q2', options: [{ id: 'yes', description: 'y' }, { id: 'no', description: 'n' }] },
]

function writeInput(dir, rows = inputRows) {
  const path = join(dir, 'in.jsonl')
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return path
}

const run = (args, env = {}) => execFileP(process.execPath, [CLI, ...args], {
  env: { ...process.env, ...env },
})

// ---------------------------------------------------------------- 正常路径

test('输出行：option_ids 与输入同序，probabilities 和为 1', async () => {
  respondWith(() => ({ yes: 0.86, no: 0.14 }))
  const dir = workdir()
  const input = writeInput(dir)
  const output = join(dir, 'out.jsonl')
  await run(['--input', input, '--output', output, '--base-url', baseUrl, '--model', 'm1'])
  const rows = readFileSync(output, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.deepEqual(row.option_ids, ['yes', 'no'])
    assert.equal(row.probabilities.length, 2)
    assert.ok(Math.abs(row.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-5)
  }
  assert.equal(rows[0].model.backend, 'jev')
  assert.equal(rows[0].model.source, 'm1')
})

test('列表顺序按 option_ids，不按端点返回顺序', async () => {
  respondWith(() => ({ no: 0.9, yes: 0.1 }))
  const dir = workdir()
  const input = writeInput(dir, [inputRows[0]])
  const output = join(dir, 'out.jsonl')
  await run(['--input', input, '--output', output, '--base-url', baseUrl])
  const row = JSON.parse(readFileSync(output, 'utf8').trim())
  assert.deepEqual(row.probabilities.map((p) => Number(p.toFixed(2))), [0.1, 0.9])
})

test('端点缺某个选项时补 0 并重新归一', async () => {
  respondWith(() => ({ yes: 0.4 }))
  const dir = workdir()
  const input = writeInput(dir, [inputRows[0]])
  const output = join(dir, 'out.jsonl')
  await run(['--input', input, '--output', output, '--base-url', baseUrl])
  const row = JSON.parse(readFileSync(output, 'utf8').trim())
  assert.deepEqual(row.probabilities, [1, 0])
})

test('summary 默认落在同名 .summary.md，且 stdout 报 RESULT/SUMMARY', async () => {
  respondWith(() => ({ yes: 0.7, no: 0.3 }))
  const dir = workdir()
  const input = writeInput(dir)
  const output = join(dir, 'out.jsonl')
  const { stdout } = await run(['--input', input, '--output', output, '--base-url', baseUrl])
  const summary = join(dir, 'out.summary.md')
  assert.ok(existsSync(summary), 'summary 未生成')
  assert.match(stdout, /^RESULT=/m)
  assert.match(stdout, /^SUMMARY=/m)
  assert.match(readFileSync(summary, 'utf8'), /Validation: passed\./)
})

test('裸 host 会被补成 /v1/systemone', async () => {
  const seen = []
  handler = (req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ answers: { q: { probabilities: { yes: 1, no: 0 } } } }))
  }
  const dir = workdir()
  const input = writeInput(dir, [inputRows[0]])
  await run(['--input', input, '--output', join(dir, 'o.jsonl'), '--base-url', baseUrl])
  assert.equal(seen[0], '/v1/systemone')
})

// ---------------------------------------------------------------- 拒绝路径

test('输出已存在时拒绝（create-only），不覆盖', async () => {
  respondWith()
  const dir = workdir()
  const input = writeInput(dir, [inputRows[0]])
  const output = join(dir, 'out.jsonl')
  writeFileSync(output, 'PRE-EXISTING', 'utf8')
  await assert.rejects(() => run(['--input', input, '--output', output, '--base-url', baseUrl]), /create-only/)
  assert.equal(readFileSync(output, 'utf8'), 'PRE-EXISTING')
})

test('端点报错时不留输出文件', async () => {
  handler = (req, res) => { res.writeHead(500); res.end('boom') }
  const dir = workdir()
  const input = writeInput(dir, [inputRows[0]])
  const output = join(dir, 'out.jsonl')
  await assert.rejects(() => run(['--input', input, '--output', output, '--base-url', baseUrl]))
  assert.equal(existsSync(output), false)
})

test('任一行失败即整体失败，不提交半成品', async () => {
  let call = 0
  handler = (req, res) => {
    call += 1
    if (call === 2) { res.writeHead(500); res.end('second fails'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ answers: { q: { probabilities: { yes: 1, no: 0 } } } }))
  }
  const dir = workdir()
  const input = writeInput(dir)
  const output = join(dir, 'out.jsonl')
  // JEV_RETRIES=0：这条测的是【原子语义】（失败即不落盘），不是重试行为。
  // 重试默认 2 次会让第 2 次 500 后重试成功，从而测不到原子语义。
  // 重试本身由 jev-adapter.test.mjs 的「网络抖动」用例覆盖。
  await assert.rejects(() => run(['--input', input, '--output', output, '--base-url', baseUrl],
                                 { JEV_RETRIES: '0' }))
  assert.equal(existsSync(output), false)
})

test('重试后仍失败才整体失败（默认 retries=2 生效）', async () => {
  let call = 0
  handler = (req, res) => {
    call += 1
    res.writeHead(500); res.end('always fails')
  }
  const dir = workdir()
  const input = writeInput(dir)
  const output = join(dir, 'out.jsonl')
  await assert.rejects(() => run(['--input', input, '--output', output, '--base-url', baseUrl]))
  assert.equal(existsSync(output), false)
  // 每个 input 行 1 次请求 + 2 次重试；writeInput 默认 1 行
  assert.equal(call, 3, `期望 3 次请求（1 + 2 重试），实际 ${call}`)
})

test('输入行选项少于两个时拒绝', async () => {
  const dir = workdir()
  const input = writeInput(dir, [{ id: 'x', state: {}, question: 'q', options: [{ id: 'yes' }] }])
  await assert.rejects(
    () => run(['--input', input, '--output', join(dir, 'o.jsonl'), '--base-url', baseUrl]),
    /at least two options/,
  )
})

test('输入行有重复 option id 时拒绝', async () => {
  const dir = workdir()
  const input = writeInput(dir, [
    { id: 'x', state: {}, question: 'q', options: [{ id: 'a' }, { id: 'a' }] },
  ])
  await assert.rejects(
    () => run(['--input', input, '--output', join(dir, 'o.jsonl'), '--base-url', baseUrl]),
    /duplicate option ids/,
  )
})

test('run_score.sh 的旗标被接受而不报错', async () => {
  respondWith()
  const dir = workdir()
  const input = writeInput(dir, [inputRows[0]])
  const output = join(dir, 'out.jsonl')
  await run([
    '--input', input, '--output', output, '--base-url', baseUrl,
    '--mode', 'direct', '--backend', 'jev', '--revision', 'deadbeef', '--offline',
  ])
  assert.ok(existsSync(output))
})

test('缺 --base-url 时明确报错', async () => {
  const dir = workdir()
  const input = writeInput(dir, [inputRows[0]])
  await assert.rejects(
    () => run(['--input', input, '--output', join(dir, 'o.jsonl')], { JEV_BASE_URL: '', REFLEX_JEV_BASE_URL: '' }),
    /--base-url/,
  )
})
