// 守「脚手架能生成【纯确定性 target】」这条性质。
//
// 背景（2026-11-27 加 baba-move 源时暴露）：new-source.sh 生成的 target 永远带
// 一段 SemIf 影子打分（第二层语义判定）。但很多源根本不需要语义层——判据是确定的
// 数值规则（阈值移动、余额比、状态位），影子层只会多起一次模型进程、多写一批影子分，
// 而写源的人要手工把那段删掉；删漏了，`SEMIF` 为空时静默跳过，看不出错，但
// 下次有人照着这份模板改时会以为「影子是必须的」。
//
// 本测试锁定两件事：
//   1) `--no-semantic` 生成的 target 里【一个 SEMIF/影子 引用都没有】，且行为仍是
//      合法的单行决策协议（空输入→空输出；命中→恰好一行 JSON，items[].id 非空）；
//   2) 不带该 flag 时，语义层仍在（不把既有能力悄悄改掉）。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const TOOL = join(REPO, 'defaults', 'tools', 'new-source.sh')

function gen(name, extraArgs = []) {
  const home = mkdtempSync(join(tmpdir(), 'reflex-nosem-'))
  const r = spawnSync('bash', [TOOL, name, ...extraArgs], {
    env: { ...process.env, REFLEX_HOME: home },
    encoding: 'utf8',
  })
  return { home, res: r }
}

function runSh(file, stdin) {
  return spawnSync('bash', [file], { input: stdin, encoding: 'utf8' })
}

test('--no-semantic: target 不含语义影子层，且仍是合法单行决策协议', () => {
  const { home, res } = gen('probe1', ['--no-semantic'])
  assert.equal(res.status, 0, `脚手架应接受 --no-semantic，stderr=${res.stderr}`)

  const tgt = join(home, 'targets', 'probe1.sh')
  assert.ok(existsSync(tgt), 'target 应已生成')
  const body = readFileSync(tgt, 'utf8')
  assert.ok(!/SEMIF/i.test(body), '纯确定性 target 里不该出现 SEMIF')
  assert.ok(!/影子/.test(body), '纯确定性 target 里不该出现「影子」')

  // 语法必须过
  assert.equal(spawnSync('bash', ['-n', tgt]).status, 0, 'target 应通过 bash -n')

  // 空输入 → 空输出（不唤醒）
  const empty = runSh(tgt, '')
  assert.equal(empty.status, 0)
  assert.equal(empty.stdout.trim(), '', '空输入不该产出决策')

  // 说明：模板里的判定条件还是 TODO 占位符（生成后必须由人来填），所以这里
  // 不假装能跑命中路径——那样只能测出「替身不炸」。命中/不命中的真实行为由
  // 具体源自己的反例测试守（见 baba-move 源的三组 fixture）。
})

test('默认（不带 flag）仍生成语义影子层，能力不被悄悄改掉', () => {
  const { home, res } = gen('probe2')
  assert.equal(res.status, 0, res.stderr)
  const body = readFileSync(join(home, 'targets', 'probe2.sh'), 'utf8')
  assert.ok(/SEMIF/.test(body), '默认模板应保留 SemIf 影子层')
})
