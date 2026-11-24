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
  'P20 无障碍底座在渲染树里齐着（原生控件 + 标注 + 播报）',
  'P21 浅/深主题下主按钮与错误文字都够对比',
  'P22 预热过的 list 让首帧直接出表（不再进 loading）',
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
    const extra = [props.id, props.placeholder, props.value, props.className].filter((v) => typeof v === 'string' && v).join(' ')
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

  // 版面：表单 + 右侧「将要发生什么」+ 常驻操作条；三段各只出现一次标签（之前 EVERY 的段标题与字段标签重复）
  assert(/rfx-form/.test(plain), '表单根节点没渲染出来')
  assert(/rfx-sum/.test(plain), '「将要发生什么」摘要面板没渲染出来')
  assert(/rfx-barActions/.test(plain), '常驻操作条没渲染出来（创建按钮要随时可见）')
  const modeCards = (plain.match(/rfx-modeCard/g) || []).length
  assert(modeCards === 4, `四张触发方式卡片没渲染齐：${modeCards}`)
  const whenLabels = (plain.match(/addWhen(?![A-Za-z])/g) || []).length
  assert(whenLabels === 1, `EVERY 段的「多久采一次」出现了 ${whenLabels} 次（段标题与字段标签重复）`)
  assert(/addNameRule/.test(plain), '名字的允许字符没写在字段旁（只能靠提交后才报错）')
  assert(/addProbeHint/.test(plain), '试跑的代价（15 秒超时 / 不写盘）没写在按钮旁')
  assert(/addWritesTitle/.test(plain), '摘要里没有「会写入哪些文件」')

  // 操作条必须与滚动区分开：塞回表单里就会被 .rfx-form 的 overflow 裁掉，跟着内容一起滚走
  const root = mod.NewSourceForm(base)
  assert(/rfx-formBody/.test(root.props.className || ''), '表单根节点缺少 rfx-formBody')
  const kids = root.props.children || []
  assert(Array.isArray(kids) && kids.length === 2, `滚动区与操作条没有分成两块（children=${kids.length}）`)
  assert(kids[0] && /rfx-form/.test(kids[0].props.className || ''), '第一块不是表单')
  assert(kids[1] && /rfx-barActions/.test(kids[1].props.className || ''), '第二块不是常驻操作条')
  const barText = textOf(kids[1])
  assert(barText.includes('addCreate') && barText.includes('addCancel'), '操作条里没有创建/取消')
  const submitBtns = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const p = n.props || {}
    if (p.type === 'submit') submitBtns.push(p)
    if ('children' in p) walk(p.children)
  }
  walk(kids[1])
  assert(submitBtns.length === 1 && submitBtns[0].form === 'rfx-add-source', '创建按钮没有用 form 属性挂到表单上（回车/点击都提交不了）')

  const failed = textOf(mod.NewSourceForm({ ...base, saveState: { phase: 'error', error: '已存在：x.sh', name: '' } }))
  assert(failed.includes('已存在：x.sh'), '创建失败的原因没渲染到表单上')

  // 列表页也要能渲染：入口按钮就在这一页上，白屏的话功能等于不存在
  // 词典取不到时会走英文兜底（srcText），所以这里断言兜底文案 —— 顺带证明兜底这条路是通的
  const page = textOf(mod.SourcesPage({ t: (key) => key }))
  assert(page.includes('Trigger'), `列表页标题没渲染出来：${page.slice(0, 160)}`)
  assert(page.includes('Add data source'), `列表页没有「添加数据源」入口：${page.slice(0, 240)}`)
})

// ⑨ 无障碍底座。这些在界面上「少了也不会报错」：删掉 aria-live 只是读屏不播报，
//    把原生 radio 换成 div 只是键盘选不动 —— 所以只能靠渲染树断言守着。
//    断言的是「属性写进去了、引用指向存在的 id」，不是「读屏读出来是对的」（后者见 ACCESSIBILITY.md 的已知障碍）。
checkStack(CASES[9], () => {
  const nodesOf = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const n of node) nodesOf(n, out); return out }
    const props = node.props || {}
    out.push({ type: node.type, props })
    if (typeof node.type === 'function') nodesOf(node.type(props), out)
    if ('children' in props) nodesOf(props.children, out)
    return out
  }
  const byId = (nodes) => new Map(nodes.filter((n) => n.props.id).map((n) => [n.props.id, n]))
  const refs = (nodes, attr) => nodes.flatMap((n) => String(n.props[attr] || '').split(/\s+/).filter(Boolean))
  const base = {
    form: { name: 'x', about: '', cmd: 'echo 1', intervalMs: 900000, mode: 'all', keywords: '', criteria: '' },
    probe: { phase: 'idle', data: null, error: '' },
    saveState: { phase: 'idle', error: '', name: '' },
    tr: (key) => key,
  }
  const treeFor = (patch) => nodesOf(mod.NewSourceForm({ ...base, form: { ...base.form, ...patch } }))

  const all = treeFor({ mode: 'all' })
  const ids = new Set(all.map((n) => n.props.id).filter(Boolean))

  // 三段各有一个能读出名字的标题：aria-labelledby → 段内 h2 的 id
  for (const step of ['feed', 'every', 'trigger']) {
    const id = `rfx-step-${step}`
    assert(refs(all, 'aria-labelledby').includes(id), `第 ${step} 段没有 aria-labelledby：${id}`)
    assert(ids.has(id), `aria-labelledby 指向的 id 不存在：${id}`)
  }
  // 所有 aria-labelledby / aria-describedby 都必须指向树里真的存在的 id（悬空引用读屏只会念个空）
  const dangling = [...refs(all, 'aria-labelledby'), ...refs(all, 'aria-describedby')].filter((id) => !ids.has(id))
  assert(dangling.length === 0, `这些 aria 引用指向不存在的 id：${[...new Set(dangling)].join(', ')}`)

  // 保存失败必须有个常驻播报区：idle 时也在，读屏才有地方接话
  const live = all.find((n) => n.props.role === 'status')
  assert(live, '保存失败没有 role="status" 播报区')
  assert(live.props['aria-live'] === 'polite', `播报区不是 aria-live="polite"：${String(live.props['aria-live'])}`)

  // 输入框的提示用 aria-describedby 挂上，不靠视觉位置（关键词框只在 match、判据框只在 semantic）
  const maps = {}
  for (const mode of ['all', 'match', 'semantic']) maps[mode] = byId(treeFor({ mode }))
  for (const [mode, id] of [['all', 'rfx-name'], ['all', 'rfx-cmd'], ['match', 'rfx-keywords'], ['semantic', 'rfx-criteria']]) {
    const node = maps[mode].get(id)
    assert(node, `${mode} 模式下控件没渲染出来：${id}`)
    const hint = node.props['aria-describedby']
    assert(typeof hint === 'string' && hint.trim(), `${id} 没有 aria-describedby，提示只靠视觉位置`)
  }

  // 触发方式必须是原生 radio：自绘控件（div + role="radio"）的键盘与读屏行为都得自己实现，不给自己留这条路
  const radios = all.filter((n) => n.props.type === 'radio')
  assert(radios.length === 4, `触发方式不是 4 个原生 radio（${radios.length} 个）`)
  assert(radios.every((n) => n.type === 'input'), '触发方式的 radio 不在 <input> 上（原生 radio 才带键盘行为）')
  assert(!all.some((n) => n.props.role === 'radio'), '出现了自绘的 role="radio" 控件')

  // 三条只在 CSS 里、界面上看不出来的规则：焦点环 / 触屏 44px / 减少动态
  assert(mod.SRC_CSS.includes(':focus-visible'), 'CSS 里没有 :focus-visible 焦点环')
  assert(mod.SRC_CSS.includes('prefers-reduced-motion'), 'CSS 里没有 prefers-reduced-motion 规则')
  const coarseAt = mod.SRC_CSS.indexOf('pointer:coarse')
  assert(coarseAt >= 0, 'CSS 里没有 @media (pointer:coarse)')
  assert(mod.SRC_CSS.slice(coarseAt, coarseAt + 200).includes('min-height:44px'), '触屏下的 44px 触摸目标没了')
})

// ⑩ 主题对比度：宿主有两套 token，同一份 CSS 要在两边都读得清。
//    下面是 2026-11-24 从 DSH app.asar 的 token 定义里读出的快照（light: brand=bluish-1000 #0f1115，
//    dark: brand=bluish-50 #f9fafb、inverted=bluish-800 #353638、layer-1=bluish-875 #232324）。
//    宿主换主题调色板时这组值要重核，否则算得再对也只是旧世界的对比度。
checkStack(CASES[10], () => {
  const HOST = {
    light: { brand: '#0f1115', onBrand: '#ffffff', labelPrimary: '#0f1115', layer1: '#ffffff' },
    dark: { brand: '#f9fafb', onBrand: '#353638', labelPrimary: '#f9fafb', layer1: '#232324' },
  }
  const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const luminance = (hex) => { const [r, g, b] = rgbOf(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) }
  const ratio = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const blend = (base, onto, pct) => '#' + rgbOf(base).map((c, i) => Math.round(c * pct + rgbOf(onto)[i] * (1 - pct)).toString(16).padStart(2, '0')).join('')

  // 1) 品牌填充上的文字必须绑宿主反向色：dark 下 brand=#f9fafb，写死 #fff 就是 1.03:1 的白底白字
  assert(/--rfx-on-brand:var\(--dsw-alias-label-primary-inverted/.test(mod.SRC_CSS),
    '--rfx-on-brand 没绑到 --dsw-alias-label-primary-inverted')
  assert(/\.rfx-btnPrimary\{[^}]*color:var\(--rfx-on-brand\)/.test(mod.SRC_CSS),
    '.rfx-btnPrimary 的文字色没走 --rfx-on-brand')
  assert(!/\.rfx-btnPrimary[^}]*color:#fff/.test(mod.SRC_CSS),
    '.rfx-btnPrimary 又写死了 color:#fff（dark 主题下隐形）')
  for (const [theme, t] of Object.entries(HOST)) {
    const r = ratio(t.brand, t.onBrand)
    assert(r >= 4.5, `${theme} 主题下主按钮文字对比度只有 ${r.toFixed(2)}:1（< 4.5）`)
  }

  // 2) 错误文字：单一写死的红在浅/深里必有一边不够，必须是「基色 + 当前主题主文字色」的混合
  assert(/\.rfx-saveMsg\{[^}]*color:var\(--rfx-err\)/.test(mod.SRC_CSS),
    '.rfx-saveMsg 没走 --rfx-err（token 定义了但没人用）')
  assert(!/\.rfx-saveMsg\{[^}]*color:#[0-9a-f]{3,6}/.test(mod.SRC_CSS),
    '.rfx-saveMsg 又写死了颜色')
  const mix = /--rfx-err:color-mix\(in srgb,#([0-9a-f]{6}) (\d+)%,var\(--dsw-alias-label-primary/.exec(mod.SRC_CSS)
  assert(mix, '--rfx-err 不是「基色 + 主题主文字色」的 color-mix')
  const pct = Number(mix[2]) / 100
  for (const [theme, t] of Object.entries(HOST)) {
    const colour = blend('#' + mix[1], t.labelPrimary, pct)
    const r = ratio(colour, t.layer1)
    assert(r >= 4.5, `${theme} 主题下错误文字（${colour} on ${t.layer1}）只有 ${r.toFixed(2)}:1（< 4.5）`)
  }
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

  // P22 首帧不等网络：插件加载时预热过一次 list，点开侧栏就该直接有表。
  // 判据用「bar 里是 summary 还是 loading」——这两段文案互斥，且都在渲染树里，
  // 比断言某个源名更稳（源名是单字母，includes 会假绿）。
  try {
    const textOf = (node) => {
      if (node == null || node === false) return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node) + ' '
      if (Array.isArray(node)) return node.map(textOf).join('')
      const props = node.props || {}
      if (typeof node.type === 'function') return textOf(node.type(props))
      return 'children' in props ? textOf(props.children) : ''
    }
    await new Promise((r) => setTimeout(r, 0))   // 让预热那次 fetch 落地
    // 不按文案断言：tr() 走的是英文兜底，取不到 key；按结构断言更稳——
    // 有数据才渲染出 <table class="rfx-table">，没数据只有一行 loading 文案。
    const classes = []
    const walkCls = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walkCls); return }
      const p = n.props || {}
      if (typeof p.className === 'string') classes.push(p.className)
      if (typeof n.type === 'function') walkCls(n.type(p))
      if ('children' in p) walkCls(p.children)
    }
    walkCls(mod.SourcesPage({ t: (key) => key }))
    assert(classes.some((c) => /rfx-table/.test(c)), '预热过了首帧仍没有表格（说明首帧还在等网络）')
    results.push([CASES[11], true, ''])
  } catch (e) { results.push([CASES[11], false, e.message]) }
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
