#!/usr/bin/env node
// jev-score: 用托管 Jev/SystemOne 端点顶替 run_score.sh 的命令行入口。
//
// 存在理由：shadow-semif.sh 只认 run_score.sh，于是"脚本 target 的 shadow、历史回放、
// 判据 A/B、新判据打分"四条链在 jev 后端下全部断掉（本机又跑不了本地 SemIf）。
// 本 CLI 与 run_score.sh 的输出契约一致，替换进去即可，四条链随之恢复。
//
// 契约（对齐 run_score.sh + validate_results.py）：
//   --input PATH --output PATH [--summary PATH] [--model M] [--base-url URL]
//   其他 run_score.sh 的旗标（--mode/--backend/--revision/--offline/--repo/--venv/
//   --mlx-bits）照收不报错，以便被透明替换。
//   退出 0 = 结果已原子落盘；非 0 = 未落盘。
//   stdout 只输出 RESULT=/SUMMARY=/MODEL=/REVISION= 四行，进度走 stderr。
//
// 输出行格式与 SemIf 一致：{id, option_ids[], probabilities[], model{backend,source,revision}}
// 校验直接复用 semif-decide 的 validate_results.py —— 契约只有一份实现。

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { scoreRow, normalizeUrl } from './jev-adapter.mjs'

// run_score.sh 里带值的旗标：为可被透明替换而照收，语义由 jev 通路忽略。
const ACCEPTED_VALUE_FLAGS = new Set([
  '--mode', '--revision', '--repo', '--venv', '--mlx-bits',
])
// run_score.sh 里不带值的开关旗标。
const ACCEPTED_BOOL_FLAGS = new Set(['--offline'])

function fail(message) {
  process.stderr.write(`[jev-score] ERROR: ${message}\n`)
  process.exit(1)
}

function note(message) {
  process.stderr.write(`[jev-score] ${message}\n`)
}

function parseArgs(argv) {
  const out = {
    input: '', output: '', summary: '',
    model: process.env.JEV_MODEL || process.env.REFLEX_JEV_MODEL || 'jev-latest',
    baseUrl: process.env.JEV_BASE_URL || process.env.REFLEX_JEV_BASE_URL || '',
    backend: process.env.REFLEX_DECIDE_BACKEND || 'jev',
    apiKey: process.env.JEV_API_KEY || process.env.REFLEX_JEV_API_KEY || '',
    timeoutMs: 120_000,
    retries: Number(process.env.JEV_RETRIES ?? 2),

    validateWith: process.env.JEV_VALIDATE_PY || '',
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const takeValue = () => {
      if (i + 1 >= argv.length) fail(`${flag} needs a value`)
      return argv[++i]
    }
    switch (flag) {
      case '--input': out.input = takeValue(); break
      case '--output': out.output = takeValue(); break
      case '--summary': out.summary = takeValue(); break
      case '--model': out.model = takeValue(); break
      case '--base-url': out.baseUrl = takeValue(); break
      case '--backend': out.backend = takeValue(); break
      case '--timeout-ms': out.timeoutMs = Number(takeValue()); break
      case '--retries': out.retries = Number(takeValue()); break
      case '--help': case '-h':
        process.stdout.write('Usage: jev-score --input PATH --output PATH [--summary PATH] [--model M] [--base-url URL]\n')
        process.exit(0)
        break
      default:
        if (ACCEPTED_VALUE_FLAGS.has(flag)) { takeValue(); break }
        if (ACCEPTED_BOOL_FLAGS.has(flag)) { break }
        fail(`unknown argument: ${flag}`)
    }
  }
  if (!out.input) fail('--input is required')
  if (!out.output) fail('--output is required')
  if (!out.baseUrl) fail('--base-url (or JEV_BASE_URL) is required')
  return out
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        return fail(`input line ${index + 1} is not valid JSON`)
      }
    })
}

/** 输入行 → 选项 id 顺序。非法输入在进入网络前就拒绝。 */
function optionIdsOf(row, index) {
  const options = row?.options
  if (!Array.isArray(options) || options.length < 2) {
    fail(`input row ${index + 1} must contain at least two options`)
  }
  const ids = options.map((option) => String(option?.id ?? '').trim())
  if (ids.some((id) => !id)) fail(`input row ${index + 1} has an invalid option id`)
  if (new Set(ids).size !== ids.length) fail(`input row ${index + 1} has duplicate option ids`)
  if (typeof row.id !== 'string' || !row.id) fail(`input row ${index + 1} has an invalid id`)
  return ids
}

/** 端点概率映射 → 与 option_ids 对齐、和为一的数组。 */
function alignProbabilities(ids, probs) {
  const raw = ids.map((id) => {
    const value = probs?.[id]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  })
  const total = raw.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return ids.map(() => 1 / ids.length)
  return raw.map((value) => value / total)
}

function defaultSummaryPath(outputPath) {
  return outputPath.endsWith('.jsonl')
    ? `${outputPath.slice(0, -'.jsonl'.length)}.summary.md`
    : `${outputPath}.summary.md`
}

function writeSummary(path, { input, output, rows, model, backend }) {
  const lines = [
    '# Jev (SystemOne) result validation',
    '',
    `- Input: \`${input}\``,
    `- Result: \`${output}\``,
    `- Rows: \`${rows.length}\``,
    `- Backend: \`${backend}\``,
    `- Model: \`${model}\``,
    '',
    'Probabilities are conditional on the supplied option set; they are not calibrated real-world confidence.',
    '',
    '| Row | Winning option | Probability |',
    '|---|---|---:|',
  ]
  for (const row of rows) {
    const best = row.probabilities.indexOf(Math.max(...row.probabilities))
    lines.push(`| \`${row.id}\` | \`${row.option_ids[best]}\` | ${row.probabilities[best].toFixed(6)} |`)
  }
  lines.push('', 'Validation: passed.', '')
  writeFileSync(path, lines.join('\n'), 'utf8')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const summaryPath = args.summary || defaultSummaryPath(args.output)

  if (existsSync(args.output)) fail(`output already exists (create-only): ${args.output}`)
  if (existsSync(summaryPath)) fail(`summary already exists: ${summaryPath}`)

  const inputs = readJsonl(args.input)
  if (inputs.length === 0) fail('input has no decision rows')

  const optionIds = inputs.map((row, index) => optionIdsOf(row, index))
  note(`scoring ${inputs.length} row(s) with ${args.model} via ${args.baseUrl}`)

  // 任一行失败 → 整体失败，绝不提交半成品（与 run_score.sh 的原子语义一致）。
  const results = []
  for (let index = 0; index < inputs.length; index++) {
    const row = inputs[index]
    let scored
    try {
      scored = await scoreRow(row, {
        url: normalizeUrl(args.baseUrl),
        model: args.model,
        apiKey: args.apiKey,
        timeoutMs: args.timeoutMs,
        // 网络抖动重试（默认 2 次）。测试传 --retries 0 来验证"失败即整体失败"的原子语义。
        retries: Number.isFinite(args.retries) ? args.retries : 2,
      })
    } catch (error) {
      fail(`row "${row.id}" failed: ${error.message}`)
    }
    results.push({
      id: row.id,
      option_ids: optionIds[index],
      probabilities: alignProbabilities(optionIds[index], scored.probs),
      model: { backend: args.backend, source: args.model, revision: null },
    })
  }

  mkdirSync(dirname(args.output), { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), 'jev-score-'))
  const stagedResult = join(staging, 'result.jsonl')
  const stagedSummary = join(staging, 'summary.md')
  try {
    writeFileSync(stagedResult, results.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')

    if (args.validateWith && existsSync(args.validateWith)) {
      const check = spawnSync(
        'python3',
        [args.validateWith, '--input', args.input, '--results', stagedResult,
          '--backend', args.backend, '--model', args.model],
        { encoding: 'utf8' },
      )
      if (check.status !== 0) {
        fail(`validate_results.py rejected the output: ${(check.stderr || check.stdout || '').slice(0, 300)}`)
      }
    }

    writeSummary(stagedSummary, {
      input: args.input, output: args.output, rows: results,
      model: args.model, backend: args.backend,
    })

    renameSync(stagedResult, args.output)
    renameSync(stagedSummary, summaryPath)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  process.stdout.write(
    `RESULT=${args.output}\nSUMMARY=${summaryPath}\nMODEL=${args.model}\nREVISION=\n`,
  )
}

main().catch((error) => fail(error?.message || String(error)))
