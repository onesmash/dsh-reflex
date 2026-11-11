// Jev (SystemOne) 决策后端适配器 for dsh-reflex L1
//
// 为什么需要它：v0.3.18 的 semifScoreBatch() 把 run_score.sh 写死，
// 内置 target（disk）绕过了 REFLEX_DECIDE_BACKEND，于是"配了 jev 也不生效"。
// 另外包里承诺的 tools/semif-adapt.py 根本没随包发布（npm files 未包含 tools/）。
//
// 对外契约与 SemIf 输出同构：{ winning, pYes, probs }，调用方无需区分后端。
//
// 线格式（实测，阿里云 MaaS 托管 SystemOne）：
//   POST {base}  {"model","state","questions":{"q":{"type","question","criteria"}}}
//   → {"answers":{"q":{"type","choice","choice":"yes","confidence":0.73,
//                     "probabilities":{"yes":0.86,"no":0.14}}}}
// 注意：criteria 的值不能是 null（会被 400 拒），没有 description 时回退用 id 文本。

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_QUESTION_TYPE = 'choice'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_CONCURRENCY = 4
const SHADOW_RETENTION_DAYS = 30
const SHADOW_STATE_CHARS = 1200
const SHADOW_QUESTION_CHARS = 600
const ANSWER_KEY = 'q'

// ---------------------------------------------------------------- 纯函数

/**
 * 端点 base 归一到可直接 POST 的 URL。
 * 用户可能贴完整端点（.../v1/systemone）或只给 host；后者才补 /v1/systemone，
 * 否则会拼出 .../v1/systemone/v1/systemone（实测 HTTP 400 url error）。
 */
export function normalizeUrl(raw) {
  const base = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('jev base URL is empty')
  return /\/systemone$/i.test(base) ? base : `${base}/v1/systemone`
}

/** 选项 → SystemOne criteria。无 description 时回退成 id 文本（null 会被 400 拒）。 */
function buildCriteria(options) {
  const criteria = {}
  for (const option of options ?? []) {
    const id = String(option?.id ?? '').trim()
    if (!id) continue
    const description = typeof option?.description === 'string' ? option.description.trim() : ''
    criteria[id] = description || id
  }
  if (Object.keys(criteria).length === 0) throw new Error('no options to score')
  return criteria
}

/** 一行决策 → 请求体。纯函数，不碰网络。 */
function buildRequestBody(row, model) {
  return {
    model,
    state: typeof row.state === 'string' ? row.state : JSON.stringify(row.state),
    questions: {
      [ANSWER_KEY]: {
        type: DEFAULT_QUESTION_TYPE,
        question: String(row.question ?? ''),
        criteria: buildCriteria(row.options),
      },
    },
  }
}

/** 概率最大项。 */
function argmax(probabilities) {
  const ids = Object.keys(probabilities)
  if (ids.length === 0) return null
  return ids.reduce((best, id) => (probabilities[id] > probabilities[best] ? id : best), ids[0])
}

/** 端点声明的 choice 优先，否则取最大项。 */
function pickWinning(probabilities, declaredChoice) {
  if (declaredChoice && Object.prototype.hasOwnProperty.call(probabilities, declaredChoice)) {
    return declaredChoice
  }
  return argmax(probabilities) ?? 'insufficient'
}

/** 判定用的 p(yes)：没有 yes 就是 0（这份值给阈值比较用）。 */
function pYesOf(probabilities) {
  return typeof probabilities?.yes === 'number' ? probabilities.yes : 0
}

/**
 * 影子记录用的 score：与 shadow_record.py 的 score_of 同规则 ——
 * 有 yes 取 yes，否则取最大概率。与 pYesOf 是两个问题，故分开命名。
 */
function scoreOf(probabilities) {
  if (Object.prototype.hasOwnProperty.call(probabilities ?? {}, 'yes')) return pYesOf(probabilities)
  const best = argmax(probabilities ?? {})
  return best == null ? 0 : probabilities[best]
}

/** 响应体 → { winning, probs }。缺 answers 时报错并带片段，便于对照端点行为。 */
function parseAnswer(data) {
  const answer = data?.answers?.[ANSWER_KEY]
  if (!answer) throw new Error(`jev response missing answers.${ANSWER_KEY}: ${JSON.stringify(data).slice(0, 300)}`)
  const probs = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
  return { winning: pickWinning(probs, answer.choice), probs }
}

// ---------------------------------------------------------------- 网络

/**
 * 打一行。网络边界只在这里，其余全是纯函数。
 * @returns {Promise<{winning:string, pYes:number, probs:Record<string,number>}>}
 */
export async function scoreRow(row, opts) {
  const { url, model, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = opts
  if (typeof fetchImpl !== 'function') throw new Error('global fetch unavailable (need Node 18+)')

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildRequestBody(row, model)),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`jev HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  const { winning, probs } = parseAnswer(await res.json())
  return { winning, pYes: pYesOf(probs), probs }
}

// ---------------------------------------------------------------- 批量

/** 固定并发跑完一组任务，逐项回调结果。 */
async function forEachConcurrent(items, concurrency, worker) {
  const queue = [...items]
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item)
    }
  })
  await Promise.all(runners)
}

/**
 * 批量打分。部分行失败保留成功结果并回调 onError；全部失败才整体抛出。
 */
export async function scoreBatch(rows, opts = {}) {
  const results = new Map()
  if (!Array.isArray(rows) || rows.length === 0) return results

  const url = normalizeUrl(opts.baseUrl)
  const failures = []
  await forEachConcurrent(rows, opts.concurrency ?? DEFAULT_CONCURRENCY, async (row) => {
    try {
      results.set(String(row.id), await scoreRow(row, { ...opts, url }))
    } catch (error) {
      failures.push(`${row.id}: ${error.message}`)
    }
  })

  if (results.size === 0 && failures.length > 0) throw new Error(failures.join('; '))
  if (failures.length > 0) opts.onError?.(failures)
  return results
}

// ---------------------------------------------------------------------------
// Shadow 记录（阈值拟合用的旁路样本）
//
// 为什么写在这里：原版只有 shadow-semif.sh 这一条 bash 旁路，它绑死在
// run_score.sh 上；内置 target（disk）从来不走它，jev 分支更不会经过。
// 结果就是"判定能跑，但没有可用来拟合阈值的样本"。
//
// 落盘格式与 reflex-tuning/scripts/shadow_record.py 逐字段一致：
//   $REFLEX_HOME/shadow/<tag>-<YYYY-MM-DD>.jsonl，一行一条，只追加。
// 这里用 JS 直写，不调 python —— 少一个子进程，且本机 python 不是硬依赖。
// ---------------------------------------------------------------------------

function sha1hex(value) {
  return createHash('sha1').update(String(value), 'utf8').digest('hex')
}

function localDate(epochMs) {
  const d = new Date(epochMs)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 一行评测 → shadow 记录。纯函数：字段映射只此一处。 */
function toShadowRecord({ row, result, tag, threshold, mode, now, stateChars, questionChars }) {
  const state = typeof row.state === 'string' ? row.state : JSON.stringify(row.state ?? '')
  const question = typeof row.question === 'string' ? row.question : ''
  const score = scoreOf(result.probs)
  return {
    ts: now,
    mode,
    tag,
    key: sha1hex(`${tag}\u0000${question}\u0000${state}`).slice(0, 16),
    state_hash: sha1hex(state).slice(0, 16),
    id: String(row.id ?? ''),
    score: Number(score.toFixed(6)),
    threshold,
    passed: threshold == null ? null : score >= Number(threshold),
    p_yes: Number(pYesOf(result.probs).toFixed(6)),
    question: question.slice(0, questionChars),
    state: state.slice(0, stateChars),
  }
}

/** 清理超过保留期的按日期命名文件；labels/报告等手工产物不动。 */
function pruneOldShadowFiles(outdir, keepDays, now) {
  if (!(keepDays > 0)) return
  const cutoff = now - keepDays * 86400_000
  for (const name of readdirSync(outdir)) {
    if (!/-\d{4}-\d\d-\d\d\.jsonl$/.test(name)) continue
    const path = join(outdir, name)
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    } catch {}
  }
}

/**
 * 追加本批 shadow 记录。Best-effort：内部吞掉一切异常，绝不影响判定。
 * @returns {number} 写入条数
 */
export function writeShadow(opts = {}) {
  const {
    homeDir,
    tag = 'unknown',
    rows = [],
    results,
    threshold = null,
    mode = 'live',
    now = Date.now(),
    stateChars = SHADOW_STATE_CHARS,
    questionChars = SHADOW_QUESTION_CHARS,
  } = opts
  try {
    if (!homeDir || !results || results.size === 0) return 0

    const records = []
    for (const row of rows) {
      const result = results.get(String(row?.id ?? ''))
      if (!result) continue
      records.push(toShadowRecord({ row, result, tag, threshold, mode, now, stateChars, questionChars }))
    }
    if (records.length === 0) return 0

    const outdir = join(homeDir, 'shadow')
    mkdirSync(outdir, { recursive: true })
    appendFileSync(join(outdir, `${tag}-${localDate(now)}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n', {
      encoding: 'utf8',
    })

    try {
      pruneOldShadowFiles(outdir, Number(process.env.REFLEX_SHADOW_RETENTION_DAYS ?? SHADOW_RETENTION_DAYS), now)
    } catch {}

    return records.length
  } catch {
    return 0
  }
}
