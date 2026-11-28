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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const NODE = process.env.NODE_BIN || process.execPath
const MODULE = join(REPO, 'sources.mjs')
const TEST = join(REPO, 'sources.test.mjs')
// P10–P14 是「新增数据源（三段式）」的性质，守门测试在另一个文件里；两条都要跑，
// 否则新性质在这份核对器里等于没登记。
const TEST_NEW_SOURCE = join(REPO, 'tests', 'create-source.test.mjs')

function undecided(why) {
  console.error(`未判定：${why}`)
  process.exit(2)
}

// 两类核对器：node --test 的守门测试，和 bundle 冒烟（客户端接线/文案只能在那里验）。
function runTests(cwd, kind) {
  const args = kind === 'panel'
    ? ['tests/check-sources-panel.mjs']
    : kind === 'delegate'
      ? ['tests/delegate-route.mjs']
      : kind === 'tune'
        ? ['tests/tune-route.mjs']
        : ['--test', 'sources.test.mjs', 'tests/create-source.test.mjs']
  const r = spawnSync(NODE, args, { cwd, encoding: 'utf8' })
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
    name: 'P9 客户端地址与宿主路由脱钩',
    prop: 'P9',
    file: 'client.js',
    from: 'const SRC_ROUTE = "api/reflex"',
    to: 'const SRC_ROUTE = "api/other"',
  },
  {
    name: 'P10 去重失效（已知水位不再跳过）',
    prop: 'P10',
    from: '    if key in known:\n        continue',
    to: '    if False:\n        continue',
  },
  {
    name: 'P10 首跑不建水位（把存量也发出去）',
    prop: 'P10',
    from: 'if seeded:\n    for t in fresh:',
    to: 'if True:\n    for t in fresh:',
  },
  {
    name: 'P11 间隔写死（不读用户选的）',
    prop: 'P11',
    from: 'return JSON.stringify({ intervalMs: spec.intervalMs, timeoutMs: 120_000, env: {} }, null, 2)',
    to: 'return JSON.stringify({ intervalMs: 900000, timeoutMs: 120_000, env: {} }, null, 2)',
  },
  {
    name: 'P12 scan 汇总行被当成数据',
    prop: 'P12',
    from: '    if not isinstance(rec, dict) or rec.get("metric") == SCAN:\n        continue\n    scanned += 1',
    to: '    if not isinstance(rec, dict):\n        continue\n    scanned += 1',
  },
  {
    name: 'P12 关键词不过滤（不命中也叫）',
    prop: 'P12',
    from: '    if KEYWORDS and not any(k in text for k in KEYWORDS):\n        continue',
    to: '    if False:\n        continue',
  },
  {
    name: 'P13 名字校验去掉（越界名可写盘）',
    prop: 'P13',
    from: '  if (!NAME.test(name)) {',
    to: '  if (false) {',
  },
  {
    name: 'P13 覆盖守卫去掉（重名会盖掉旧源）',
    prop: 'P13',
    from: '    if (existsSync(path)) throw new Error(`已存在：${item.dir}/${item.file}（不覆盖已有数据源）`)',
    to: '    if (false) throw new Error(`已存在：${item.dir}/${item.file}（不覆盖已有数据源）`)',
  },
  {
    name: 'P14 试跑摘要把每一行都算成合法',
    prop: 'P14',
    from: 'return { lines: lines.length, valid, bad: lines.length - valid, sample: lines.slice(0, Math.max(0, limit)) }',
    to: 'return { lines: lines.length, valid: lines.length, bad: 0, sample: lines.slice(0, Math.max(0, limit)) }',
  },
  {
    name: 'P15 一句话请求体的 op 写错',
    prop: 'P15',
    file: 'client.js',
    runner: 'panel',
    from: 'const body = { op: \"delegate\", sentence: String(sentence || \"\").trim() };',
    to: 'const body = { op: \"add\", sentence: String(sentence || \"\").trim() };',
  },
  {
    name: 'P16 本地不再拦空句子',
    prop: 'P16',
    file: 'client.js',
    runner: 'panel',
    from: 'if (!s) return \"addAskNeedSentence\";',
    to: 'if (false) return \"addAskNeedSentence\";',
  },
  {
    name: 'P17 英文兜底缺一条文案',
    prop: 'P17',
    file: 'client.js',
    runner: 'panel',
    from: '\naddAskSend: \"Send to {target}\",',
    to: '\naddAskSendX: \"Send to {target}\",',
  },
  {
    name: 'P18 一句话输入框的 id 改坏（首屏找不到入口）',
    prop: 'P18',
    file: 'client.js',
    runner: 'panel',
    from: 'id: \"rfx-ask\", type: \"text\"',
    to: 'id: \"rfx-nope\", type: \"text\"',
  },
  {
    name: 'P20 播报区去掉 aria-live（读屏不再播报）',
    prop: 'P20',
    file: 'client.js',
    runner: 'panel',
    from: 'className: send.phase === "ok" ? "rfx-saveMsg rfx-saveMsg--ok" : "rfx-saveMsg",\n\t\t\t\t\t\t\t\trole: "status", "aria-live": "polite",',
    to: 'className: send.phase === "ok" ? "rfx-saveMsg rfx-saveMsg--ok" : "rfx-saveMsg",\n\t\t\t\t\t\t\t\trole: "status",',
  },
  {
    name: 'P21 主按钮文字色写死 #fff（深色主题下隐形）',
    prop: 'P21',
    file: 'client.js',
    runner: 'panel',
    from: '.rfx-btnPrimary{border-color:var(--rfx-brand);background:var(--rfx-brand);color:var(--rfx-on-brand)}',
    to: '.rfx-btnPrimary{border-color:var(--rfx-brand);background:var(--rfx-brand);color:#fff}',
  },
  {
    name: 'P19 采集器不再最后落盘（提交点回到最前）',
    prop: 'P19',
    from: 'return [...collectorConfig, ...targetFiles, commitPoint]',
    to: 'return [commitPoint, ...collectorConfig, ...targetFiles]',
  },
  {
    name: 'P23 提示词不再要求加载 reflex-datasource',
    prop: 'P23',
    from: '1. 加载 skill reflex-datasource',
    to: '1. 加载 skill reflex-anything',
  },
  {
    name: 'P24 一句话长度上限放宽到 700（与测试约定不一致）',
    prop: 'P24',
    from: 'sentenceMax: 500,',
    to: 'sentenceMax: 700,',
  },
  {
    name: 'P25 delegate 未接线时假装成功',
    prop: 'P25',
    from: "if (typeof io?.delegate !== 'function') {",
    to: 'if (false) {',
  },
  {
    name: 'P26 投递消息角色写错（post → request）',
    prop: 'P26',
    file: 'index.js',
    runner: 'delegate',
    from: "source: { kind: 'bot', form: 'relay', role: 'post',",
    to: "source: { kind: 'bot', form: 'relay', role: 'request',",
  },
  {
    name: 'P27 调优提示词不再要求加载 reflex-tuning',
    prop: 'P27',
    from: '1. 加载 skill reflex-tuning',
    to: '1. 加载 skill reflex-anything',
  },
  {
    name: 'P28 调优请求不再校验源名',
    prop: 'P28',
    from: "if (!NAME.test(target)) throw new Error(`名字不合法：${JSON.stringify(target)}`)",
    to: 'if (false) throw new Error(`名字不合法：${JSON.stringify(target)}`)',
  },
  {
    name: 'P-W1 接受任意 kind（不再只认 group/bot）',
    prop: 'P-W1',
    file: 'sources.mjs',
    from: "if ((kind === 'group' || kind === 'bot') && name) return { kind, name }",
    to: "if (name) return { kind, name }",
  },
  {
    name: 'P-W2 清空时写成 null 而不是删键（wakeTo:null 会被当成“配了个 null”）',
    prop: 'P-W2',
    file: 'sources.mjs',
    from: 'if (wakeTo === null) delete obj.wakeTo',
    to: 'if (wakeTo === null) obj.wakeTo = null',
  },
  {
    name: 'P-W3 显示恒为默认（界面看不出投给了群还是 Bot）',
    prop: 'P-W3',
    file: 'sources.mjs',
    from: "  return wakeTo.kind === 'group' ? `群：${wakeTo.name}` : `Bot：${wakeTo.name}`",
    to: "  return '默认（跟随宿主）'",
  },
  {
    name: 'P30 没有 L1 的源也放行（跳过 target 存在性检查）',
    prop: 'P30',
    file: 'index.js',
    runner: 'tune',
    from: "if (!existsSync(join(targetsDir, `${name}.sh`))) {",
    to: "if (false) {",
  },
  {
    name: 'P31 只采集的行按钮也可点（去掉 hasTarget 判断）',
    prop: 'P31',
    file: 'client.js',
    runner: 'panel',
    from: 'disabled: !r.hasTarget || tuning === r.name,',
    to: 'disabled: tuning === r.name,',
  },
  {
    name: 'P33 忽略请求里的投递对象（照旧投默认目标）',
    prop: 'P33',
    file: 'index.js',
    runner: 'delegate',
    from: 'function resolveRequestTarget(raw) {',
    to: 'function resolveRequestTarget(raw) {\n    return cfg.l1.targetBot',
  },
  {
    name: 'P33 目标不存在也放行（不校验 Bot 是否存在）',
    prop: 'P33',
    file: 'index.js',
    runner: 'delegate',
    from: 'if (!botSessionId(picked)) throw new Error(`没有这个 Bot：${picked}`)',
    to: 'if (false) throw new Error(`没有这个 Bot：${picked}`)',
  },
  {
    name: 'P33 客户端不把选中的对象放进请求体',
    prop: 'P33',
    file: 'client.js',
    runner: 'panel',
    from: 'if (to) body.target = to;',
    to: 'if (false) body.target = to;',
  },
  {
    name: 'P6 没有 manifest 就返回空',
    prop: 'P6',
    from: 'const names = entries.filter(',
    to: "if (!existsSync(join(dir, 'manifest.json'))) return []\n  const names = entries.filter(",
  },
]

function applyMutations(dir, mutation) {
  const file = join(dir, mutation.file || 'sources.mjs')
  let src = readFileSync(file, 'utf8')
  for (const step of [mutation, ...(mutation.extra ? [mutation.extra] : [])]) {
    if (!src.includes(step.from)) return `替换串没匹配上：${step.from.slice(0, 60)}`
    src = src.replace(step.from, step.to)
  }
  writeFileSync(file, src)
  return null
}

for (const [label, path] of [['模块', MODULE], ['测试', TEST], ['三段式测试', TEST_NEW_SOURCE]]) {
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
    // 依赖不复制，但要接上：进 index.js 的运行器（delegate 端到端）缺 node_modules 时会在 import 处
    // 直接崩，那种红不是断言给的 —— 曾经因此把一次「假抓到」记成 CAUGHT。
    if (existsSync(join(REPO, 'node_modules'))) {
      try { symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules')) } catch {}
    }
    const failure = applyMutations(dir, mutation)
    if (failure) { misses.push(`${mutation.name}：${failure}`); console.log(`ERROR ${mutation.name}：${failure}`); continue }
    const r = runTests(dir, mutation.runner)
    if (r.rc === 0) {
      misses.push(`${mutation.name}：改坏了仍全绿`)
      console.log(`MISS  ${mutation.name} —— 改坏了还是全绿，这条性质没人守`)
      continue
    }
    // node --test 用 ✖ 前缀报失败名；bundle 冒烟用 FAIL。
    const marker = mutation.runner === 'panel' || mutation.runner === 'delegate' || mutation.runner === 'tune'
      ? `FAIL ${mutation.prop}`
      : `✖ ${mutation.prop}`
    if (r.out.includes(marker)) {
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
