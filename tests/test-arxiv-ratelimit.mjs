#!/usr/bin/env node
// arxiv 采集器遇到 429 时的行为：整轮立即放弃。
//
// 为什么这条必须守：2026-11-24 实测，arXiv 的 429 是 IP 级限流，重试与「换类目继续」
// 只会把限流窗口烧得更长（那一轮 5 类目 × 3 次 = 15 个请求全 429，水位原地不动，
// reflex-health 连报两次 collector-failure）。所以：第一个 429 出现就必须收手，
// 只发一个请求、不写水位、退出非 0，把重试交给下一个 tick。
//
// 判据（都是行为）：① 退出码非 0；② 只请求了一次；③ 没有写 seen-arxiv.json。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// 采集器不在仓库里，它在运行时的状态目录下（collectors/ 是用户目录里的文件）。
// 解析顺序：显式 ARXIV_COLLECTOR → $REFLEX_HOME/collectors → ~/.dsh/dsh-reflex/collectors。
// 找不到就报「未判定」，不能当成通过。
const HOME_DIR = process.env.REFLEX_HOME || join(homedir(), '.dsh', 'dsh-reflex')
const COLLECTOR = process.env.ARXIV_COLLECTOR || join(HOME_DIR, 'collectors', 'arxiv.sh')
if (!existsSync(COLLECTOR)) {
  console.error(`未判定：找不到采集器 ${COLLECTOR}（用 ARXIV_COLLECTOR 指过去）`)
  process.exit(2)
}

function assert(cond, why) { if (!cond) throw new Error(why) }

const root = mkdtempSync(join(tmpdir(), 'arxiv-429-'))
const bin = join(root, 'bin')
mkdirSync(bin)
const calls = join(root, 'calls.log')

// curl 替身：把每次调用的参数记下来，然后按真实 curl 的 -w '\n%{http_code}' 形状输出 429。
// 真 curl 带 -f 时，HTTP 429 会以退出码 22 收场；不带 -f 时退出 0 但状态码是 429。
// 替身必须照这个差异走，否则测不出「靠退出码分辨不出限流」这个根因。
writeFileSync(join(bin, 'curl'), `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
printf 'Rate exceeded.\\n429'
case "$*" in *sfL*|*" -f "*) exit 22 ;; esac
exit 0
`, { mode: 0o755 })

let code = 0
let stderr = ''
try {
  execFileSync('/bin/bash', [COLLECTOR], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REFLEX_HOME: root, ARXIV_CATEGORIES: 'cs.SE' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
} catch (e) {
  code = e.status
  stderr = String(e.stderr || '')
}

const tried = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0
const state = existsSync(join(root, 'seen-arxiv.json'))

assert(code !== 0, `429 之后应以非 0 退出，实际退出码 ${code}`)
assert(tried === 1, `429 之后只该发 1 个请求，实际发了 ${tried} 个`)
assert(!state, '429 那一轮不该写 seen-arxiv.json（水位不能前进）')
assert(/429/.test(stderr), `stderr 里没有说清是 429：${stderr.slice(0, 200)}`)

console.log('PASS 429 立即整轮放弃：1 个请求、非 0 退出、水位未写')
