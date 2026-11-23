#!/usr/bin/env node
// 数据源开关的不变量核对器（S3 守门 + S5 可重跑证据）。
//
// 两件事，缺一件都不算通过：
//   ① 基座绿：sources.test.mjs 在真实模块上全过
//   ② 每条性质都有一个破坏变体，并且【亲眼见它按那条性质报红】——
//      从没红过的检查证明不了它有分辨力。
//
// 退出码三态（别合并）：
//   0 = 基座绿，且每个变体都被对应性质抓到
//   1 = 基座红，或有变体漏抓 / 红错了性质（那条性质其实没人守）
//   2 = 未判定：找不到测试或模块、变体集为空（不是通过）
//
// 用法： node tools/invariant-check.mjs
// 环境： NODE_BIN=<node 可执行文件> 可覆盖（默认 process.execPath）
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const NODE = process.env.NODE_BIN || process.execPath
const MODULE = join(REPO, 'sources.mjs')
const TEST = join(REPO, 'sources.test.mjs')

function undecided(why) {
  console.error(`未判定：${why}`)
  process.exit(2)
}

function runTests(cwd) {
  const r = spawnSync(NODE, ['--test', 'sources.test.mjs'], { cwd, encoding: 'utf8' })
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

// 每条变体：改名 + 目标性质 + 一处必然破坏该性质的改动。
// 改动写在副本上，真实文件不动。
const MUTATIONS = [
  {
    name: 'P1 枚举改成按 .env.json',
    prop: 'P1',
    from: "entries.filter((f) => f.endsWith('.sh')).map((f) => f.slice(0, -3)).sort()",
    to: "entries.filter((f) => f.endsWith('.env.json')).map((f) => f.slice(0, -9)).sort()",
  },
  {
    name: 'P2 paused 写死 false（改读内存/忽略文件）',
    prop: 'P2',
    from: 'paused: existsSync(join(dir, `${name}.paused`))',
    to: 'paused: false',
  },
  {
    name: 'P3 恢复时不删标记',
    prop: 'P3',
    from: 'else rmSync(marker, { force: true })',
    to: 'else { /* 忘了删 */ }',
  },
  {
    name: 'P4 去掉内置源守卫',
    prop: 'P4',
    from: 'if (builtins.includes(name))',
    to: 'if (false)',
  },
  {
    name: 'P5 去掉名字与存在性校验',
    prop: 'P5',
    from: 'if (typeof name !== \'string\' || !NAME.test(name))',
    to: 'if (false)',
    extra: { from: 'if (!existsSync(join(dir, `${name}.sh`)))', to: 'if (false)' },
  },
  {
    name: 'P7 pause/resume 方向写反',
    prop: 'P7',
    from: 'io.commit(name, op === \'pause\')',
    to: 'io.commit(name, op !== \'pause\')',
  },
  {
    name: 'P6 没有 manifest 就返回空',
    prop: 'P6',
    from: 'const names = entries.filter(',
    to: "if (!existsSync(join(dir, 'manifest.json'))) return []\n  const names = entries.filter(",
  },
]

function applyMutations(dir, mutation) {
  const file = join(dir, 'sources.mjs')
  let src = readFileSync(file, 'utf8')
  for (const step of [mutation, ...(mutation.extra ? [mutation.extra] : [])]) {
    if (!src.includes(step.from)) return `替换串没匹配上：${step.from.slice(0, 60)}`
    src = src.replace(step.from, step.to)
  }
  writeFileSync(file, src)
  return null
}

for (const [label, path] of [['模块', MODULE], ['测试', TEST]]) {
  try { readFileSync(path) } catch { undecided(`找不到${label} ${path}`) }
}

console.log('== ① 基座')
const base = runTests(REPO)
if (base.rc !== 0) {
  console.error(`FAIL 基座测试红（exit ${base.rc}）：先把实现修绿，再来谈守门`)
  console.error(base.out.split('\n').filter((l) => /✖|not ok|Error/.test(l)).slice(0, 8).join('\n'))
  process.exit(1)
}
const passedCount = (base.out.match(/^✔ /gm) || []).length
console.log(`PASS 基座 ${passedCount} 条全过`)

if (MUTATIONS.length === 0) undecided('变体集为空，什么都没检查')

console.log('\n== ② 破坏变体（每条都要按名字报红）')
const tmp = mkdtempSync(join(tmpdir(), 'reflex-invariants-'))
let caught = 0
const misses = []
try {
  for (const mutation of MUTATIONS) {
    const dir = join(tmp, mutation.prop)
    cpSync(REPO, dir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes('.git') })
    const failure = applyMutations(dir, mutation)
    if (failure) { misses.push(`${mutation.name}：${failure}`); console.log(`ERROR ${mutation.name}：${failure}`); continue }
    const r = runTests(dir)
    if (r.rc === 0) {
      misses.push(`${mutation.name}：改坏了仍全绿`)
      console.log(`MISS  ${mutation.name} —— 改坏了还是全绿，这条性质没人守`)
      continue
    }
    if (r.out.includes(`✖ ${mutation.prop}`)) {
      caught += 1
      console.log(`CAUGHT ${mutation.name}`)
    } else {
      misses.push(`${mutation.name}：红了但不是 ${mutation.prop} 先红`)
      console.log(`CAUGHT-WRONG ${mutation.name} —— 红了，但不是 ${mutation.prop}（记下待查）`)
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n候选变体 ${MUTATIONS.length} 条：抓到 ${caught}，问题 ${misses.length}`)
if (misses.length > 0) {
  for (const m of misses) console.error(` - ${m}`)
  process.exit(1)
}
process.exit(0)
