// 数据源目录的纯函数层：扫、暂停、恢复。
//
// 为什么单独成文件：这三个动作是「开关」的全部语义，但它们原先埋在 index.js 的闭包里，
// 只能通过跑整个插件来观察。抽出来后可以被测试直接调用，破坏变体也能被机器跑出来
// （见 tests/sources-invariants.mjs）。index.js 只负责把它们接到路由与扫描上。
//
// 硬约束（每条都有测试守着，见 sources.test.mjs）：
//   - 枚举以 <name>.sh 为准：.env.json / .schema.json 都可缺（真实世界里的 tidemark 就是没 env.json）
//   - paused 的唯一真相是 <name>.paused 文件，不读内存、不读 manifest
//   - 内置源（disk/cpu）不可开关，它们由 profile 的 l0.sources 门控
//   - 名字必须落在目录内：挡住 ../、a/b 这类越界写法
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 内置源名：与 index.js 的 BUILTIN_SOURCES 必须一致（测试会拿它们验拒绝）。 */
export const BUILTIN_SOURCES = Object.freeze(['disk', 'cpu'])

/** 宿主注册的 exact Fetch 路由（必须带前导斜杠，否则 assertFetchRoute 拒绝）。 */
export const SOURCE_ROUTE = '/api/reflex'
/** 浏览器侧的相对地址：与 SOURCE_ROUTE 必须是同一个端点，只差前导斜杠。 */
export const SOURCE_ROUTE_CLIENT = SOURCE_ROUTE.replace(/^\//, '')

/** 合法源名：小写字母数字开头，其余允许 . _ -；不允许斜杠与点开头。 */
const NAME = /^[a-z0-9][a-z0-9._-]*$/

/**
 * 扫一个 collectors 目录。
 * @param {string} dir
 * @returns {Array<{name:string, paused:boolean, intervalMs:number|null, hasEnv:boolean, metric:string|null}>}
 */
export function scanSources(dir) {
  if (!existsSync(dir)) return []
  let entries
  try { entries = readdirSync(dir) } catch { return [] }
  const names = entries.filter((f) => f.endsWith('.sh')).map((f) => f.slice(0, -3)).sort()
  return names.map((name) => {
    let intervalMs = null
    let hasEnv = false
    const envFile = join(dir, `${name}.env.json`)
    if (existsSync(envFile)) {
      hasEnv = true
      try {
        const cfg = JSON.parse(readFileSync(envFile, 'utf8'))
        if (Number.isFinite(cfg?.intervalMs)) intervalMs = cfg.intervalMs
      } catch { /* 坏 env.json 不该让整张表塌掉 */ }
    }
    let metric = null
    const schemaFile = join(dir, `${name}.schema.json`)
    if (existsSync(schemaFile)) {
      try { metric = JSON.parse(readFileSync(schemaFile, 'utf8'))?.metric ?? null } catch {}
    }
    return { name, paused: existsSync(join(dir, `${name}.paused`)), intervalMs, hasEnv, metric }
  })
}

/**
 * 暂停或恢复一个脚本源。幂等：重复调用不会抖。
 * @param {string} dir collectors 目录
 * @param {string} name 源名（必须已存在对应 .sh）
 * @param {boolean} paused true=写 .paused，false=删 .paused
 * @returns {{name:string, paused:boolean}}
 */
export function setPaused(dir, name, paused, options = {}) {
  const builtins = Array.isArray(options.builtins) ? options.builtins : BUILTIN_SOURCES
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`invalid name: ${JSON.stringify(name)}`)
  }
  if (builtins.includes(name)) {
    throw new Error(`内置源不可开关（由 profile 的 l0.sources 门控）: ${name}`)
  }
  if (!existsSync(join(dir, `${name}.sh`))) {
    throw new Error(`invalid name: 没有 ${name}.sh`)
  }
  const marker = join(dir, `${name}.paused`)
  if (paused) writeFileSync(marker, '')
  else rmSync(marker, { force: true })
  return { name, paused }
}

/**
 * 把一次面板请求翻成动作。纯逻辑：IO 全部由调用方注入，便于测试与破坏变体。
 * @param {string} op 'list' | 'pause' | 'resume'
 * @param {object} body 面板请求体（含 name）
 * @param {object} io { list(), commit(name,paused), refresh(), log(msg) }
 * @returns {{ok:boolean, error?:string}}
 */
export function respondToOp(op, body, io) {
  const list = io?.list ?? (() => ({ sources: [], builtin: [] }))
  if (op === 'list') return { ok: true, ...list() }
  if (op === 'pause' || op === 'resume') {
    const name = String(body?.name ?? '')
    io.commit(name, op === 'pause')
    io.refresh?.()          // 标记落盘后立刻重扫，界面不必等下一个 tick
    io.log?.(`sources: ${op} ${name}`)
    return { ok: true, ...list() }
  }
  return { ok: false, error: `unknown op: ${op || '(empty)'}` }
}
