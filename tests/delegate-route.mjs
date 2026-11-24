// 一句话建源：从面板请求一路走到真正的投递（不启动 DSH）。
//
// 这条链上真正会坏的都不是"算法"，是接线：
//   ① 原句要原样进提示词 —— 换了措辞就等于替用户改了需求
//   ② 消息必须 role=post / kind=bot / 带 senderSessionId —— 缺一个正文就不显示，
//      再严重一点会把 Chief 的回复一起吞掉（2026-11-11、11-16 各踩过一次）
//   ③ 投不出去必须 400 + 人话，绝不能回 ok:true 之后什么都没有发生
//   ④ 空句子/超长句子在宿主侧就挡住，且一个字都不写盘
//
// 退出码：0 全过 / 1 有断言失败 / 2 未判定
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'reflex-delegate-'))
mkdirSync(join(home, 'collectors'), { recursive: true })
mkdirSync(join(home, 'targets'), { recursive: true })
const statePath = join(home, 'state.json')
writeFileSync(statePath, JSON.stringify({
  bots: { b_chief: { name: 'Chief', sessionId: 's-chief' } },
  rooms: {},
}), 'utf8')

const captured = []
const routes = []
let agentReady = true          // 切成 false 模拟"投不出去"
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
  sessionTitle: {},
  sessionController: {},
  inject: (deps, cb) => {
    const list = Array.isArray(deps) ? deps : [deps]
    if (list.includes('connection')) {
      cb({
        connection: { fetch: { register: (def) => { routes.push(def); return () => {} } } },
        effect: (fn) => { try { fn() } catch {} },
      })
      return
    }
    cb({
      sessionController: {
        resolveAgent: async () => (agentReady
          ? { agent: { followup: (msg) => { captured.push(msg) } } }
          : { agent: {} }),
      },
      effect: noop,
    })
  },
}

apply(ctx, {
  statePath,
  l0: { homeDir: home, sources: [], intervalMs: 3600000 },
  l1: { targets: [], targetBot: 'Chief', intervalMs: 3600000 },
})

const route = routes.find((r) => r.path === '/api/reflex')
if (!route) { console.error('未判定：/api/reflex 路由没注册上'); process.exit(2) }

// 插件启动时会往 home 里部署种子文件（reflex-health 的健康源），所以"目录为空"是错的判据；
// 正确的是"投一条建源请求，目录里一个文件都不许多"。
const collectBefore = readdirSync(join(home, 'collectors')).sort()
const targetBefore = readdirSync(join(home, 'targets')).sort()

let pass = 0
let total = 0
// 输出 PASS/FAIL + 性质编号：破坏变体核对器按 `FAIL P26` 认这条性质被谁守住。
const ok = (label, cond, extra = '') => {
  total++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}
const call = async (body) => {
  const res = await route.fetch({ json: async () => body })
  return { status: res.status, body: await res.json() }
}
const textOf = (msg) => (msg?.content ?? []).map((p) => p?.text ?? '').join('\n')

// ---- ① 正常一句话：拼成提示词、投给 Chief ----
const sentence = '盯着 https://example.com/changelog 有更新就叫我'
const sent = await call({ op: 'delegate', sentence })
ok('P26 delegate 返回 ok 并指明投给了谁', sent.body.ok === true && sent.body.target === 'Chief', JSON.stringify(sent.body))
ok('P26 真的投出去了一条', captured.length === 1, `captured=${captured.length}`)

const msg = captured[0] ?? { content: [] }
const text = textOf(msg)
ok('提示词带 [建源请求] 标记', text.startsWith('[建源请求]'), text.slice(0, 40))
ok('原句原样进了提示词', text.includes(sentence), '原句被改了')
ok('要求加载 reflex-datasource', text.includes('reflex-datasource'))
ok('写了提交点与语义禁令',
  /collectors\/<name>\.sh/.test(text) && /最后/.test(text) && /semantic/.test(text) && /(不叫醒|只记账)/.test(text))

// 投递契约：这三项错一个，消息就只显示一行提示、正文与回复都看不到
ok('P26 消息角色是 user', msg.role === 'user', String(msg.role))
ok('P26 source.role=post（正文才会画成气泡）', msg.source?.role === 'post', String(msg.source?.role))
ok('P26 source.kind=bot', msg.source?.kind === 'bot', String(msg.source?.kind))
ok('P26 senderSessionId 非空（否则不进 texts2）',
  typeof msg.source?.senderSessionId === 'string' && msg.source.senderSessionId.length > 0,
  String(msg.source?.senderSessionId))

// ---- ② 一句话建源不该在宿主侧写任何文件 ----
ok('P26 collectors/ 一个文件都没多', JSON.stringify(readdirSync(join(home, 'collectors')).sort()) === JSON.stringify(collectBefore),
  String(readdirSync(join(home, 'collectors'))))
ok('P26 targets/ 一个文件都没多', JSON.stringify(readdirSync(join(home, 'targets')).sort()) === JSON.stringify(targetBefore),
  String(readdirSync(join(home, 'targets'))))

// ---- ③ 空句子 / 超长句子：挡住，且不投递 ----
const before = captured.length
const empty = await call({ op: 'delegate', sentence: '   ' })
ok('P26 空句子 → 400 且说清缺什么',
  empty.status === 400 && empty.body.ok === false && /一句话/.test(empty.body.error ?? ''),
  JSON.stringify(empty.body))
const long = await call({ op: 'delegate', sentence: 'x'.repeat(501) })
ok('P26 超长句子 → 400 且说清上限',
  long.status === 400 && /太长/.test(long.body.error ?? ''),
  JSON.stringify(long.body))
ok('P26 被挡住的两条都没有投出去', captured.length === before, `${before} -> ${captured.length}`)

// ---- ④ 投不出去：400 + 人话，绝不 ok:true ----
agentReady = false
const failed = await call({ op: 'delegate', sentence: '盯着 b.com' })
ok('P26 投递失败 → 400', failed.status === 400, JSON.stringify(failed.body))
ok('P26 失败原因说的是「没投到」，不是内部黑话',
  failed.body.ok === false && /没投|投不到|投递失败/.test(failed.body.error ?? ''),
  JSON.stringify(failed.body))
agentReady = true

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
