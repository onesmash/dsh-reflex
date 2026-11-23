#!/usr/bin/env node
// 客户端插件的冒烟测试：不启动 DSH，也能证明
//   ① client.js 能被模块加载器收下（语法/包装层没坏）
//   ② apply() 把页面注册进 main 槽、入口注册进 sidebar.panellist 槽（不是旧弹层）
//   ②b 入口 id 与 main 的 key 相同 —— 不一致就是点了没反应，且界面上没有报错
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
const CASES = ['加载器收下', 'apply 注册主列页与侧栏入口', '入口 id 与主列 key 一致', '请求打到 api/reflex', '失败原因可显示']

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
const bySlot = (name) => registered.filter((r) => r.definition?.name === name)
checkStack(CASES[1], () => {
  assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 里没有 slots')
  mod.apply(ctx)
  const page = bySlot('main')
  assert(page.length === 1, `main 槽注册了 ${page.length} 条（应为 1）`)
  assert(typeof page[0].component === 'function', '主列页没有挂组件')
  const nav = bySlot('sidebar.panellist')
  assert(nav.length === 1, `sidebar.panellist 注册了 ${nav.length} 条（应为 1）`)
  assert(typeof nav[0].component === 'function', '侧栏入口没有图标组件')
  assert(bySlot('sidebar.footer.action').length === 0, '仍在注册旧的弹层入口 sidebar.footer.action')
})
// 侧栏按 id 去 main 里找同 key 的页：两个值不同 = 点了没反应。
checkStack(CASES[2], () => {
  const page = bySlot('main')[0], nav = bySlot('sidebar.panellist')[0]
  assert(page?.definition?.key, 'main 注册缺 key')
  assert(nav?.definition?.id, 'panellist 注册缺 id')
  assert(page.definition.key === nav.definition.id,
    `id 不一致：main key=${page.definition.key} / panellist id=${nav.definition.id}`)
  assert(typeof nav.definition.label === 'function', 'panellist 缺 label，侧栏没有可显示的文字')
  // 只检查"是函数"不够：label 在侧栏启动时就会被求值，闭包里引用错变量
  // 会直接让 renderer 启动失败（P0）。这里真的调一次。
  const navText = nav.definition.label()
  assert(typeof navText === 'string' && navText.length > 0, `panellist 的 label() 没有返回可显示文字：${String(navText)}`)
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
    results.push([CASES[3], true, ''])
  } catch (e) { results.push([CASES[3], false, e.message]) }

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
    results.push([CASES[4], true, ''])
  } catch (e) { results.push([CASES[4], false, e.message]) }
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
