// 快车道: 源/target 声明比全局节拍更小的间隔时, 调度节拍必须真的降到那里。
//
// 背景(2026-11-19 实测, live-asr 要「检测到一句就唤醒」):
//   ① 采集源只能比全局节拍【慢】—— collectOnce 的 everyMs 只在
//      intervalMs > l0.intervalMs 时生效, 声明 200ms 的源实际按 60s 跑;
//   ② target 侧根本没有「多久跑一次判定」的旋钮, minIntervalMs 管的是
//      「叫不叫醒」, 判定仍然每个 L1 节拍都跑。
//   所以第二轮墙是 60s 的调度节拍本身, 光把 target 的 minIntervalMs 从 10 分钟
//   改小, 最快也只能 60s 一次 —— 那还是不算实时。
//
// 这个文件锁定三条行为:
//   1) 声明 intervalMs=200 的源, 在 l0.intervalMs=60000 下 700ms 内至少采到 2 次;
//   2) 声明 evalIntervalMs=200 + minIntervalMs=0 的 target, 同样在 700ms 内至少跑到 2 次;
//   3) 没声明 evalIntervalMs 的 target 仍按 l1.intervalMs 跑 —— 只跑 1 次,
//      不能被快车道顺手拖成 2Hz(磁盘那个 jev 判定每 200ms 一次是要花钱的)。
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-fastlane-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })

const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }

// 快源: 每次被调用就把计数 +1, 并吐一条带序号的 fact (指纹要变, 否则去重会挡掉唤醒)
sh(join(home, 'collectors', 'fast.sh'), [
  '#!/bin/bash',
  'n=$(( $(cat "$REFLEX_HOME/collects" 2>/dev/null || echo 0) + 1 ))',
  'echo "$n" > "$REFLEX_HOME/collects"',
  'echo "{\\"metric\\":\\"m\\",\\"raw\\":{\\"seq\\":$n}}"',
  '',
].join('\n'))
writeFileSync(join(home, 'collectors', 'fast.env.json'),
  JSON.stringify({ intervalMs: 200 }), 'utf8')

// 快 target: 声明 evalIntervalMs=200 + minIntervalMs=0, 每次被调用记一行
sh(join(home, 'targets', 'fast-t.sh'), [
  '#!/bin/bash',
  'input=$(cat)',
  'echo x >> "$REFLEX_HOME/fast-t.log"',
  'n=$(wc -l < "$REFLEX_HOME/fast-t.log" | tr -d " ")',
  'echo "{\\"wake\\":true,\\"reason\\":\\"fast $n\\",\\"fingerprint\\":{\\"ids\\":[\\"f$n\\"]},\\"items\\":[{\\"id\\":\\"f$n\\",\\"title\\":\\"t\\",\\"body\\":\\"b\\"}]}"',
  '',
].join('\n'))
writeFileSync(join(home, 'targets', 'fast-t.env.json'),
  JSON.stringify({ sources: ['fast'], minIntervalMs: 0, evalIntervalMs: 200 }), 'utf8')

// 慢源: 只在启动那一轮吐一条, 之后 60s 内不再吐 —— 用来验证「没有自己的新事实时不评估」。
sh(join(home, 'collectors', 'slow-src.sh'), '#!/bin/bash\necho \'{"metric":"m","raw":{"seq":1}}\'\n')
writeFileSync(join(home, 'collectors', 'slow-src.env.json'),
  JSON.stringify({ intervalMs: 60000 }), 'utf8')

// 慢 target: 不声明 evalIntervalMs, 绑慢源 → 只在它的新事实到来时评估一次,
// 之后既没有相关事实、又没到 60s 的 due, 必须跳过。这条是防回归:
// 快车道不能把所有 target 都拖成 1Hz(磁盘那个 jev 判定每秒一次是要花钱的)。
sh(join(home, 'targets', 'slow-t.sh'), [
  '#!/bin/bash',
  'cat > /dev/null',
  'echo x >> "$REFLEX_HOME/slow-t.log"',
  'echo \'{"wake":false}\'',
  '',
].join('\n'))
writeFileSync(join(home, 'targets', 'slow-t.env.json'),
  JSON.stringify({ sources: ['slow-src'], minIntervalMs: 0 }), 'utf8')

const statePath = join(home, 'state.json')
writeFileSync(statePath, JSON.stringify({ bots: { 'bot-chief': { name: 'Chief', sessionId: 'session-chief' } } }), 'utf8')

const delivered = []
const workingSc = { resolveAgent: async () => ({ agent: { followup: (m) => delivered.push(m) } }) }
const noop = () => {}
const dbg = (...a) => { if (process.env.DEBUG) console.log('[dbg]', ...a) }
const ctx = {
  logger: { info: dbg, warn: dbg, error: dbg, debug: dbg },
  on: noop,
  // 真实宿主里 effect(setup) 会立即执行 setup; 这个用例测的就是调度节拍, 必须照此实现。
  effect: (fn) => { try { return fn() } catch (e) { console.error('effect setup threw', e) } },
  get: () => undefined,
  tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
  workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
  inject: (_deps, cb) => { cb({ sessionController: workingSc, effect: noop }) },
}

apply(ctx, {
  statePath,
  l0: { homeDir: home, sources: [], intervalMs: 60000 },
  l1: { targets: ['fast-t', 'slow-t'], targetBot: 'Chief', intervalMs: 60000 },
})

const count = (f) => {
  try { return readFileSync(join(home, f), 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}
// collects 存的是计数器数字(不是追加行), 别用 count()
const collects = () => { try { return Number(readFileSync(join(home, 'collects'), 'utf8').trim()) } catch { return 0 } }

await new Promise(r => setTimeout(r, 900))

const nCollects = collects()
const fastRuns = count('fast-t.log')
const slowRuns = count('slow-t.log')

const fails = []
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `  <- ${detail}`))
  if (!cond) fails.push(name)
}

check('快源 900ms 内至少采 2 次', nCollects >= 2, `collects=${nCollects}`)
check('快 target 900ms 内至少跑 2 次', fastRuns >= 2, `fastRuns=${fastRuns}`)
check('没有相关新事实且未到期的 target 不评估(只 1 次)', slowRuns === 1, `slowRuns=${slowRuns}`)
check('快 target 真的投出去了', delivered.length >= 2, `delivered=${delivered.length}`)

if (fails.length) { console.error(`\n${fails.length} 项失败`); process.exit(1) }
console.log('\n全部通过')
process.exit(0)
