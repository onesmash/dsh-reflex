// 端到端：从面板路由走到磁盘上的真实脚本。
//
// 不启动 DSH，用假宿主把 apply() 挂起来，然后像浏览器那样 POST {op:'create'} 到 /api/reflex，
// 再**真的把生成出来的采集器与 target 跑一遍**。这样"界面加源"这件事的每一环都有证据：
//   路由 → 校验 → 写盘（含 bash -n 守门）→ 热发现可见 → 采集器产出事实 → target 命中叫醒
//
// 退出码：0 全过 / 1 有断言失败 / 2 未判定
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-create-route-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })
const statePath = join(home, 'state.json')
writeFileSync(statePath, JSON.stringify({ bots: {} }), 'utf8')

const routes = []
const noop = () => {}
const ctx = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  on: noop,
  effect: (fn) => { try { fn() } catch {} },
  get: () => undefined,
  tools: { register: noop },
  systemPrompt: { section: noop },
  schedule: { register: noop },
  workspaceRegistry: {},
  sessionController: {},
  sessionTitle: {},
  inject: (deps, cb) => {
    const list = Array.isArray(deps) ? deps : [deps]
    if (list.includes('connection')) {
      cb({
        connection: { fetch: { register: (def) => { routes.push(def); return () => {} } } },
        effect: (fn) => { try { fn() } catch {} },
      })
      return
    }
    cb({ sessionController: {}, effect: noop })
  },
}

apply(ctx, {
  statePath,
  l0: { homeDir: home, sources: [], intervalMs: 3600000 },
  l1: { targets: [], targetBot: 'Chief', intervalMs: 3600000 },
})

let pass = 0
let total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}

const route = routes.find((r) => r.path === '/api/reflex')
if (!route) { console.error('未判定：/api/reflex 路由没注册上'); process.exit(2) }

/** 像浏览器一样调一次面板接口。 */
async function call(body) {
  const res = await route.fetch({ json: async () => body })
  return { status: res.status, body: await res.json() }
}

const run = (path, stdin = '') => {
  const r = spawnSync('/bin/bash', [path], { input: stdin, encoding: 'utf8', env: { ...process.env, REFLEX_HOME: home }, timeout: 60000 })
  return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const jsonLines = (out) => out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

// ---- ① 试跑：不写盘也能知道命令给不给数据 ----
const probe = await call({ op: 'probe', cmd: 'printf \'{"metric":"x"}\nnot json\n\'' })
ok('试跑返回行数/合法行数', probe.body.ok === true && probe.body.lines === 2 && probe.body.valid === 1,
  JSON.stringify(probe.body))
ok('试跑不写任何文件',
  !readdirSync(join(home, 'collectors')).some((f) => f.startsWith('probe-')) && !existsSync(join(home, 'collectors', 'probe.sh')),
  `collectors=${readdirSync(join(home, 'collectors'))}`)

// ---- ② 创建：三段式 → 五个文件 ----
const created = await call({
  op: 'create',
  name: 'demo',
  about: '端到端测试源',
  cmd: 'printf \'{"metric":"hit","raw":{"t":"hit-%s"}}\n\' "$RANDOM"',
  intervalMs: 600000,
  trigger: { mode: 'match', keywords: ['hit'] },
})
ok('create 返回 ok', created.body.ok === true, JSON.stringify(created.body.error ?? created.body))
ok('create 落了 5 个文件', created.body.files?.length === 5, JSON.stringify(created.body.files))
ok('collectors/ 三个文件在盘上',
  ['demo.sh', 'demo.env.json', 'demo.schema.json'].every((f) => existsSync(join(home, 'collectors', f))))
ok('targets/ 两个文件在盘上',
  ['demo.sh', 'demo.env.json'].every((f) => existsSync(join(home, 'targets', f))))
ok('采集器可执行', (spawnSync('stat', ['-f', '%Lp', join(home, 'collectors', 'demo.sh')], { encoding: 'utf8' }).stdout ?? '').trim().match(/7[0-9]{2}/) !== null)

// ---- ③ 列表：热发现之后界面能看到它 ----
const listed = await call({ op: 'list' })
const row = (listed.body.sources ?? []).find((r) => r.name === 'demo')
ok('list 里出现新源，且间隔来自 env.json', row && row.intervalMs === 600000, JSON.stringify(row))
ok('新源默认是采集中（不是暂停）', row && row.paused === false)

// ---- ④ 生成物真的能跑：采集器首跑建水位、第二轮发新数据 ----
const first = run(join(home, 'collectors', 'demo.sh'))
ok('采集器首跑退出 0', first.rc === 0, first.stderr)
const seedRows = jsonLines(first.stdout)
ok('首跑只发 scan 且标记 seeded', seedRows.length === 1 && seedRows[0].raw.seeded === true, first.stdout)

const second = run(join(home, 'collectors', 'demo.sh'))
const dataRows = jsonLines(second.stdout)
const scan = dataRows.find((r) => String(r.metric).endsWith('-scan'))
const data = dataRows.filter((r) => !String(r.metric).endsWith('-scan'))
ok('第二轮发了 1 条新数据 + 1 条 scan', data.length === 1 && scan?.raw?.new === 1, second.stdout)

// ---- ⑤ target：拿第二轮的事实喂进去，命中就唤醒 ----
const fed = dataRows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const decided = run(join(home, 'targets', 'demo.sh'), fed)
ok('target 退出 0', decided.rc === 0, decided.stderr)
const decision = JSON.parse(decided.stdout.trim() || '{}')
ok('target 命中并给出条目', decision.wake === true && decision.items?.length === 1, decided.stdout)
ok('指纹与条目 id 对齐', JSON.stringify(decision.fingerprint?.ids) === JSON.stringify((decision.items ?? []).map((i) => i.id)))

// scan 行不进条目（否则每轮都会叫醒）
const scanOnly = run(join(home, 'targets', 'demo.sh'), JSON.stringify(scan) + '\n')
ok('只有 scan 行时不叫醒', scanOnly.stdout.trim() === '', scanOnly.stdout)

// ---- ⑥ 守门：坏命令在写盘前就被 bash -n 挡住 ----
const bad = await call({
  op: 'create', name: 'broken', cmd: 'if [ ; then', intervalMs: 600000, trigger: { mode: 'off' },
})
ok('语法错的命令被拒', bad.body.ok === false && /语法/.test(bad.body.error ?? ''), JSON.stringify(bad.body))
ok('被拒时不留半成品', !existsSync(join(home, 'collectors', 'broken.sh'))
  && readdirSync(join(home, 'collectors')).filter((f) => f.startsWith('broken')).length === 0,
  String(readdirSync(join(home, 'collectors'))))

// ---- ⑦ 重名不许覆盖 ----
const dup = await call({ op: 'create', name: 'demo', cmd: 'echo 1', intervalMs: 600000, trigger: { mode: 'off' } })
ok('重名被拒', dup.body.ok === false && /已存在/.test(dup.body.error ?? ''), JSON.stringify(dup.body))
ok('原来那份一字未改', readFileSync(join(home, 'collectors', 'demo.env.json'), 'utf8').includes('600000'))

// ---- ⑧ 未知 op 仍然是 400，且不写盘 ----
const unknown = await call({ op: 'nope' })
ok('未知 op → 400', unknown.status === 400 && unknown.body.ok === false, JSON.stringify(unknown.body))

console.log(`\n结果: ${pass}/${total} 通过`)
if (pass !== total) console.log(`⚠️ 有 ${total - pass} 项未通过`)
process.exit(pass === total ? 0 : 1)
