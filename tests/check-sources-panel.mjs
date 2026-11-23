#!/usr/bin/env node
// 客户端插件的冒烟测试：不启动 DSH，也能证明
//   ① client.js 能被模块加载器收下（语法/包装层没坏）
//   ② apply() 真的把入口注册进 sidebar.footer.action 槽
//   ③ 面板的请求打到 `api/reflex`，同源、POST、body 是 {op,...}
//   ④ 宿主回 {ok:false,error} 时，面板拿到的是可显示的失败原因
//
// 退出码：0 全过 / 1 有断言失败 / 2 未判定（文件缺失、候选 0）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, '..', 'client.js')
const CASES = ['加载器收下', 'apply 注册侧栏入口', '请求打到 api/reflex', '失败原因可显示']

let code
try { code = readFileSync(FILE, 'utf8') } catch { console.error(`未判定：读不到 ${FILE}`); process.exit(2) }

const fetches = []
let nextReply = { ok: true, sources: [{ name: 'a', paused: false, factsToday: 1, lastFactAt: Date.now() }], builtin: [], scannedAt: Date.now() }
const sandbox = {
  console,
  fetch: async (url, init) => {
    fetches.push({ url, init })
    const body = typeof nextReply === 'function' ? nextReply() : nextReply
    return { ok: true, status: 200, json: async () => body }
  },
  window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def } } },
  document: { documentElement: { dataset: {} }, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } },
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

const results = []
const check = (name, fn) => {
  try { fn(); results.push([name, true, '']) } catch (e) { results.push([name, false, e?.message ?? String(e)]) }
}
function assert(cond, why) { if (!cond) throw new Error(why) }

const def = sandbox.__def
check(CASES[0], () => {
  assert(def && typeof def.factory === 'function', '没有拿到 { id, factory }')
  assert(def.id === 'dsh-reflex', `id 不对：${def.id}`)
})

let mod = null
const react = {
  useState: (v) => [v, () => {}],
  useCallback: (f) => f,
  useEffect: () => {},
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  Fragment: 'Fragment',
}
const requireFn = (name) => {
  if (name === 'react') return react
  if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    // 配置卡会调用一批 primitives（settingsTextField 等）；这一轮只验侧栏入口与请求形状，
    // 所以给一个"任何属性都是空组件/空函数"的代理，而不是逐个补桩。
    // 实例也要能接任意方法调用（form.bind/subscribe/dispose 等）：返回一个"什么方法都有"的代理。
    function Stub() { return new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) }
    return new Proxy({}, { get: () => Stub })
  }
  throw new Error(`unexpected require: ${name}`)
}
try { mod = def.factory(requireFn) } catch (e) { console.error(`未判定：factory 抛错 ${e.message}`); process.exit(2) }

const registered = []
const ctx = {
  effect: (fn) => { try { fn() } catch {} return () => {} },
  slots: {
    inject: (_name, reg) => { reg(); return () => {} },
    register: (definition, component) => { registered.push({ definition, component }); return () => {} },
  },
  locale: { register: () => () => {}, bind: () => (k) => k },
  configForms: {
    // 配置卡的 scope 需要 mutate（CardController 会包一层记录失败原因）
    get: () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, mutate: async () => true }),
    whileServed: () => () => {},
  },
  remote: { credentials: { set: async () => {}, describe: async () => ({ value: {} }) } },
}

const checkStack = (name, fn) => {
  try { fn(); results.push([name, true, '']) } catch (e) { results.push([name, false, `${e?.message} @ ${(e?.stack || '').split('\n')[1]?.trim()}`]) }
}
checkStack(CASES[1], () => {
  assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 里没有 slots')
  mod.apply(ctx)
  const entry = registered.find((r) => r.definition?.name === 'sidebar.footer.action')
  assert(entry, `没有注册 sidebar.footer.action，实际注册了：${registered.map((r) => r.definition?.name).join(', ')}`)
  assert(typeof entry.component === 'function', '入口没有挂组件')
})


const runAsync = async () => {
  // ③ 请求形状
  try {
    const data = await mod.reflexCall('list')
    const call = fetches.at(-1)
    assert(call, '没有发出请求')
    assert(call.url === 'api/reflex', `请求地址不对：${call.url}`)
    assert(call.init?.method === 'POST', '不是 POST')
    assert(call.init?.credentials === 'same-origin', '缺 credentials: same-origin')
    assert(JSON.parse(call.init.body).op === 'list', 'body 里没有 op')
    results.push([CASES[2], true, ''])
  } catch (e) { results.push([CASES[2], false, e.message]) }

  // ④ 失败形态
  try {
    const saved = nextReply
    nextReply = { ok: false, error: 'invalid name: 没有 nope.sh' }
    let caught = null
    try { await mod.reflexCall('pause', { name: 'nope' }) } catch (e) { caught = e }
    nextReply = saved
    assert(caught, '宿主回 ok:false 时没有抛错')
    assert(/invalid name/.test(caught.message), `抛出的原因不对：${caught.message}`)
    const body = JSON.parse(fetches.at(-1).init.body)
    assert(body.name === 'nope' && body.op === 'pause', 'pause 请求没带 name/op')
    results.push([CASES[3], true, ''])
  } catch (e) { results.push([CASES[3], false, e.message]) }
}

await runAsync()

let failed = 0
for (const [name, ok, why] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` —— ${why}`}`)
  if (!ok) failed += 1
}
console.log(`\n候选 ${CASES.length} 条：通过 ${results.length - failed}，失败 ${failed}`)
if (results.length === 0) { console.error('未判定：一条都没跑'); process.exit(2) }
process.exit(failed === 0 ? 0 : 1)
