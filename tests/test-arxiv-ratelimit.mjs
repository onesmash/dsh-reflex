#!/usr/bin/env node
// arxiv 采集器被限流时的行为：429 不重试，**改走 RSS 端点**把这一轮救回来。
//
// 背景（2026-11-24 实测）：arXiv API 的 429 是 IP 级限流，重试只会把窗口烧得更长；
// 同一天 rss.arxiv.org/rss/<cat> 返回 200 / 0.2s / 88 条，是另一套服务、没被限。
// 所以契约是：见到 429 → 不再碰 API（整轮切 RSS）→ 用 RSS 的条目补齐这一轮。
//
// 两条断言（都是行为，不看实现）：
//   T1 API 429 + RSS 可用 → 退出 0、产出 1 条 fact、API 只被调 1 次、水位前进
//   T2 API 429 + RSS 也挂  → 退出非 0、不写水位、API 仍只被调 1 次（不许重试）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// 采集器不在仓库里，它在运行时的状态目录下。
const HOME_DIR = process.env.REFLEX_HOME || join(homedir(), '.dsh', 'dsh-reflex')
const COLLECTOR = process.env.ARXIV_COLLECTOR || join(HOME_DIR, 'collectors', 'arxiv.sh')
if (!existsSync(COLLECTOR)) {
  console.error(`未判定：找不到采集器 ${COLLECTOR}（用 ARXIV_COLLECTOR 指过去）`)
  process.exit(2)
}

const RSS_FIXTURE = `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" version="2.0">
  <channel>
    <title>cs.SE</title>
    <item>
      <title>Fallback Paper On Rate Limits</title>
      <link>https://arxiv.org/abs/2611.28153</link>
      <description>arXiv:2611.28153v1 Announce Type: new
Abstract: A paper fetched through RSS because the API said 429.</description>
      <pubDate>Mon, 24 Nov 2026 00:00:00 -0500</pubDate>
      <arxiv:announce_type>new</arxiv:announce_type>
    </item>
  </channel>
</rss>`

function run(mode) {
  const root = mkdtempSync(join(tmpdir(), `arxiv-${mode}-`))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const calls = join(root, 'calls.log')
  writeFileSync(join(root, 'rss.xml'), RSS_FIXTURE)

  // curl 替身：按 URL 分流。API 恒 429；RSS 在 mode=ok 时给 fixture，否则 500。
  writeFileSync(join(bin, 'curl'), `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in
  *export.arxiv.org*) printf 'Rate exceeded.\\n429' ;;
  *rss.arxiv.org*)
    if [ "${mode}" = "ok" ]; then cat ${JSON.stringify(join(root, 'rss.xml'))}; printf '\\n200'
    else printf 'boom\\n500'; fi ;;
  *) printf 'nope\\n404' ;;
esac
exit 0
`, { mode: 0o755 })

  // 已经建过水位：让这一轮直接走"有新增"的分支，而不是"首跑只建水位"
  writeFileSync(join(root, 'seen-arxiv.json'),
    JSON.stringify({ ids: ['2600.00001'], sinceIso: '2026-11-01T00:00:00Z' }))

  let code = 0, stdout = '', stderr = ''
  try {
    stdout = execFileSync('/bin/bash', [COLLECTOR], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REFLEX_HOME: root, ARXIV_CATEGORIES: 'cs.SE' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, encoding: 'utf8',
    })
  } catch (e) {
    code = e.status
    stdout = String(e.stdout || '')
    stderr = String(e.stderr || '')
  }
  const apiCalls = existsSync(calls)
    ? readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('export.arxiv.org')).length : 0
  const rssCalls = existsSync(calls)
    ? readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('rss.arxiv.org')).length : 0
  const state = existsSync(join(root, 'seen-arxiv.json'))
    ? JSON.parse(readFileSync(join(root, 'seen-arxiv.json'), 'utf8')) : null
  return { code, stdout, stderr, apiCalls, rssCalls, state }
}

function assert(cond, why) { if (!cond) throw new Error(why) }

// T1：429 → RSS 兜底
{
  const r = run('ok')
  assert(r.apiCalls === 1, `API 只该被调 1 次（429 之后不许重试），实际 ${r.apiCalls}`)
  assert(r.rssCalls >= 1, '没有回退到 RSS 端点')
  assert(r.code === 0, `RSS 兜底成功后应以 0 退出，实际 ${r.code}；stderr=${r.stderr.slice(0, 200)}`)
  const lines = r.stdout.split('\n').filter(Boolean)
  assert(lines.length === 1, `应产出 1 条 fact，实际 ${lines.length}`)
  const fact = JSON.parse(lines[0])
  assert(fact.raw && String(fact.raw.id).includes('2611.28153'), `fact 的 id 不对：${JSON.stringify(fact.raw?.id)}`)
  assert(r.state && r.state.ids.includes('2611.28153'), '水位没前进（RSS 那条没记进 seen）')
}

// T2：RSS 也挂 → 老实失败，但不许重试 API、也不许写水位
{
  const r = run('fail')
  assert(r.apiCalls === 1, `RSS 也挂时 API 仍只该被调 1 次，实际 ${r.apiCalls}`)
  assert(r.code !== 0, `两条路都挂应以非 0 退出，实际 ${r.code}`)
  assert(r.state && !r.state.ids.includes('2611.28153'), '失败那一轮不许把新 id 写进水位')
}

console.log('PASS 429 → RSS 兜底（1 次 API 调用、产出 fact、水位前进）')
console.log('PASS 429 + RSS 失败 → 非 0 退出、不重试 API、水位不动')
