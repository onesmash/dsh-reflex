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
const CASES = [
  '加载器收下',
  'apply 注册主列页与侧栏入口',
  '入口 id 与主列 key 一致',
  '请求打到 api/reflex',
  '失败原因可显示',
  'P15 三段式表单拼出正确的请求体',
  'P16 表单缺项时说清缺哪一项',
  'P17 界面用到的文案三处词典都齐',
  'P18 三段式表单能真的渲染出来',
]

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


// ⑤ 三段式表单 → 请求体：名称/命令 trim、间隔转数字、关键词按全角/半角逗号切分
checkStack(CASES[5], () => {
  const body = mod.newSourceBody({
    name: ' x-timeline ', about: ' 盯推文 ', cmd: ' printf \'{"a":1}\\n\' ', intervalMs: '1800000',
    mode: 'match', keywords: '裁员, 仲裁，昇腾', criteria: '',
  })
  assert(body.op === 'create', `op 不对：${body.op}`)
  assert(body.name === 'x-timeline', `name 没 trim：${JSON.stringify(body.name)}`)
  assert(body.cmd === 'printf \'{"a":1}\\n\'', `cmd 没 trim：${JSON.stringify(body.cmd)}`)
  assert(body.intervalMs === 1800000, `intervalMs 不是数字：${JSON.stringify(body.intervalMs)}`)
  assert(JSON.stringify(body.trigger) === JSON.stringify({ mode: 'match', keywords: ['裁员', '仲裁', '昇腾'] }),
    `关键词切分不对：${JSON.stringify(body.trigger)}`)
  const sem = mod.newSourceBody({ name: 'a', cmd: 'echo 1', mode: 'semantic', criteria: ' 值得处理吗 ' })
  assert(JSON.stringify(sem.trigger) === JSON.stringify({ mode: 'semantic', criteria: '值得处理吗' }),
    `语义判据不对：${JSON.stringify(sem.trigger)}`)
  const off = mod.newSourceBody({ name: 'a', cmd: 'echo 1', mode: 'off' })
  assert(JSON.stringify(off.trigger) === JSON.stringify({ mode: 'off' }), 'off 模式不该带多余字段')
  assert(off.intervalMs === 900000, '没给间隔时要用默认值')
})

// ⑥ 本地只挡"没填完"：拦下来的那一项要能被翻成一句人话
checkStack(CASES[6], () => {
  assert(mod.formBlocker({}) === 'addNeedName', '空表单应报缺名字')
  assert(mod.formBlocker({ name: 'a' }) === 'addNeedCmd', '只填名字应报缺命令')
  assert(mod.formBlocker({ name: 'a', cmd: 'echo 1', mode: 'match', keywords: ' , ， ' }) === 'addNeedKeywords',
    '关键词模式只有标点应报缺关键词')
  assert(mod.formBlocker({ name: 'a', cmd: 'echo 1', mode: 'semantic', criteria: ' ' }) === 'addNeedCriteria',
    '语义模式缺判据应报缺判据')
  assert(mod.formBlocker({ name: 'a', cmd: 'echo 1', mode: 'all' }) === '', '填完了不该再拦')
})

// ⑦ 文案完整性：界面上 tr() 用到的每个 key，zh / en / 英文兜底三处都要有。
//    少一处不会报错，只会让切换语言的人看到 "addProbeRc" 这种字样 —— 静态看不出来，只能这么抓。
checkStack(CASES[7], () => {
  const src = readFileSync(FILE, 'utf8')
  const used = [...src.matchAll(/\btr\(["']([a-zA-Z][\w.]*)["']\)/g)].map((m) => m[1])
  assert(used.length >= 20, `没抓到 tr() 调用（候选 ${used.length} 条），这个检查等于没跑`)
  const blockOf = (name) => {
    const start = src.indexOf(name)
    const end = src.indexOf('};', start)
    assert(start > 0 && end > start, `找不到词典块 ${name}`)
    return src.slice(start, end)
  }
  const pools = { zh: blockOf('const zh = {'), en: blockOf('const en = {'), fallback: blockOf('const SRC_FALLBACK = {') }
  const miss = []
  for (const key of new Set(used)) {
    for (const [name, block] of Object.entries(pools)) {
      if (!new RegExp('\\b' + key + ':').test(block)) miss.push(name + ':' + key)
    }
  }
  assert(miss.length === 0, `这些 key 缺翻译：${miss.join(', ')}`)
})

// ⑧ 真的渲染一次：把 jsx 对象走一遍，不出异常、三段都在、条件字段跟着模式变。
//    "能通过语法检查"和"渲染出来不是白屏"是两件事 —— 后者只能这么验。
checkStack(CASES[8], () => {
  const textOf = (node) => {
    if (node == null || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node) + ' '
    if (Array.isArray(node)) return node.map(textOf).join('')
    const props = node.props || {}
    const extra = [props.id, props.placeholder, props.value].filter((v) => typeof v === 'string' && v).join(' ')
    if (typeof node.type === 'function') return extra + ' ' + textOf(node.type(props))
    const kids = 'children' in props ? textOf(props.children) : ''
    return extra + ' ' + kids
  }
  // tr 直接返回 key 就能核对"哪一段渲染出来了"；带插值的两条给模板，用来验替换
  const tr = (key) => (key === 'addProbeLines' ? '{lines} lines / {valid} valid'
    : key === 'addFiles' ? 'collectors/{name}.sh and targets/{name}.sh'
      : key)
  const base = {
    form: { name: 'x', about: '', cmd: 'echo 1', intervalMs: 900000, mode: 'all', keywords: '', criteria: '' },
    probe: { phase: 'idle', data: null, error: '' },
    saveState: { phase: 'idle', error: '', name: '' },
    tr,
  }
  const plain = textOf(mod.NewSourceForm({ ...base }))
  assert(plain.includes('FEED') && plain.includes('EVERY') && plain.includes('TRIGGER'),
    `三段标签没渲染齐：${plain.slice(0, 160)}`)
  assert(!/GIVE|WHEN|WAKE/.test(plain), '旧标签还留在页面上（改了一半）')
  assert(plain.includes('addCreate') && plain.includes('addCancel'), '创建/取消按钮没渲染出来')
  assert(/rfx-name/.test(plain) && /rfx-cmd/.test(plain) && /rfx-interval/.test(plain), '三个必填控件没渲染出来')
  assert(!/rfx-keywords/.test(plain) && !/rfx-criteria/.test(plain), 'all 模式不该出现关键词/判据输入框')

  const match = textOf(mod.NewSourceForm({ ...base, form: { ...base.form, mode: 'match' } }))
  assert(/rfx-keywords/.test(match) && match.includes('裁员, 仲裁, 昇腾'), 'match 模式的关键词输入框没出现')
  const semantic = textOf(mod.NewSourceForm({ ...base, form: { ...base.form, mode: 'semantic' } }))
  assert(/rfx-criteria/.test(semantic), 'semantic 模式的判据输入框没出现')

  const probed = textOf(mod.NewSourceForm({
    ...base,
    probe: { phase: 'ok', data: { lines: 3, valid: 1, bad: 2, sample: ['{"a":1}'], code: 0, timedOut: false, stderrTail: '' } },
  }))
  assert(/3 lines \/ 1 valid/.test(probed), `试跑结果没显示行数/合法行数：${probed.slice(-200)}`)
  const bad = textOf(mod.NewSourceForm({
    ...base,
    probe: { phase: 'ok', data: { lines: 1, valid: 1, bad: 0, sample: [], code: 2, timedOut: false, stderrTail: 'boom' } },
  }))
  assert(/addProbeRc/.test(bad) && bad.includes('boom'), '非 0 退出与 stderr 末行没显示出来')

  // {name} 出现两次（collectors/ 与 targets/），只替换第一处会让界面上留着 "{name}" 字样
  assert(!/\{name\}/.test(plain), `占位符没替换干净：${(plain.match(/[^ ]*\{name\}[^ ]*/) || [''])[0]}`)
  assert(plain.includes('collectors/x.sh') && plain.includes('targets/x.sh'), '预览里没写出将会生成的文件名')

  const failed = textOf(mod.NewSourceForm({ ...base, saveState: { phase: 'error', error: '已存在：x.sh', name: '' } }))
  assert(failed.includes('已存在：x.sh'), '创建失败的原因没渲染到表单上')

  // 列表页也要能渲染：入口按钮就在这一页上，白屏的话功能等于不存在
  // 词典取不到时会走英文兜底（srcText），所以这里断言兜底文案 —— 顺带证明兜底这条路是通的
  const page = textOf(mod.SourcesPage({ t: (key) => key }))
  assert(page.includes('Trigger'), `列表页标题没渲染出来：${page.slice(0, 160)}`)
  assert(page.includes('Add data source'), `列表页没有「添加数据源」入口：${page.slice(0, 240)}`)
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
