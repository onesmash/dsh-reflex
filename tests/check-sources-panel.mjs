#!/usr/bin/env node
// 客户端插件的冒烟测试：不启动 DSH，也能证明
//   ① client.js 能被模块加载器收下（语法/包装层没坏）
//   ② apply() 把页面注册进 main 槽、入口注册到 sidebar.panellist 槽（不是旧弹层）
//   ②b 入口 id 与 main 的 key 相同 —— 不一致就是点了没反应，且界面上没有报错
//   ③ 面板的请求打到 `api/reflex`，同源、POST、body 是 {op,...}
//   ④ 宿主回 {ok:false,error} 时，面板拿到的是可显示的失败原因
//
// 2026-11-25 起，「添加数据源」不再是一张独立的三段式页面：用户只写一句话，
// 宿主把原话拼成提示词投给 Chief，由它按 reflex-datasource 落盘。
// 所以这一版守的是：一句话框 + 发送按钮在首页首屏、请求体形状、以及
// **添加页确实已经不在了**（删干净比少写更常见地出错）。
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
  'P15 一句话拼出 {op:"delegate"} 的请求体',
  'P16 空句子与超长句子在本地就被拦下',
  'P17 界面用到的文案三处词典都齐',
  'P18 首屏就有一句话框与发送按钮，且添加页已经删干净',
  'P20 无障碍底座在渲染树里齐着（标注 + 播报）',
  'P21 浅/深主题下主按钮与错误文字都够对比',
  'P22 预热过的 list 让首帧直接出表（不再进 loading）',
  'P31 行的「调优」按钮跟着 hasTarget 走（文案是动作、够宽、只采集与内置源不给可点的按钮）',
  'P32 宿主是旧版（列表没有 hasTarget）时必须喊「重启 DSH」，不许只把按钮变灰一声不吭',
  'P33 投给谁可选：下拉默认当前目标、请求体带 target、响应目标不一致要能识别',
  'P34 点「调优」先弹窗：偏好随请求走、长度两边都挡、失败不清空输入也不关窗',
  'P35 弹窗无障碍与键盘：dialog/labelledby/describedby、输入框有标签与上限、操作条不在滚动区',
  'P36 键盘行为：Esc 取消、Ctrl+Enter 开始、Tab 焦点留在弹窗内、投递中不响应',
]

let code
try { code = readFileSync(FILE, 'utf8') } catch { console.error(`未判定：读不到 ${FILE}`); process.exit(2) }

const fetches = []
let nextReply = {
  ok: true,
  sources: [
    { name: 'alpha', paused: false, factsToday: 1, lastFactAt: Date.now(), intervalMs: 900000, hasTarget: true },
    { name: 'beta', paused: false, factsToday: 0, lastFactAt: 0, intervalMs: 900000, hasTarget: false },
  ],
  builtin: [{ name: 'disk', builtin: true, enabled: true }],
  scannedAt: Date.now(),
}
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

/** 把渲染树拍平成节点数组（函数组件就地展开一次）。 */
const nodesOf = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) nodesOf(n, out); return out }
  const props = node.props || {}
  out.push({ type: node.type, props })
  if (typeof node.type === 'function') nodesOf(node.type(props), out)
  if ('children' in props) nodesOf(props.children, out)
  return out
}
const textOf = (node) => {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node) + ' '
  if (Array.isArray(node)) return node.map(textOf).join('')
  const props = node.props || {}
  if (typeof node.type === 'function') return textOf(node.type(props))
  return 'children' in props ? textOf(props.children) : ''
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

// ⑤ 一句话 → 请求体。界面上只有一个输入框，所以这里能漏的字段只有"sentence 忘了 trim"。
checkStack(CASES[5], () => {
  const body = mod.delegateBody('  盯着 a.com 有更新就叫我  ')
  assert(body.op === 'delegate', `op 不对：${body.op}`)
  assert(body.sentence === '盯着 a.com 有更新就叫我', `原句没 trim：${JSON.stringify(body.sentence)}`)
  assert(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['op', 'sentence']),
    `除了 op/sentence 不该带别的字段：${JSON.stringify(body)}`)
})

// ⑥ 本地只挡"还没填"与"长得离谱"，格式合法性交给宿主（错了它给准话）。
checkStack(CASES[6], () => {
  assert(mod.sentenceBlocker('') === 'addAskNeedSentence', '空句子应报缺内容')
  assert(mod.sentenceBlocker('   ') === 'addAskNeedSentence', '全空白应报缺内容')
  assert(mod.sentenceBlocker('x'.repeat(500)) === '', '500 字是上限，不该拦')
  assert(mod.sentenceBlocker('x'.repeat(501)) === 'addAskTooLong', '超长应在本地就拦下（省一次往返）')

  // 本地上限必须与宿主同一个数：两边各写一个 500，改一边忘了另一边，用户会看到
  // 「本地让发、宿主报太长」这种自相矛盾的回执。
  const src = readFileSync(FILE, 'utf8')
  const local = /const SENTENCE_MAX = (\d+)/.exec(src)
  const host = /sentenceMax:\s*(\d+)/.exec(readFileSync(join(HERE, '..', 'sources.mjs'), 'utf8'))
  assert(local && host, '取不到一句话长度上限（本地或宿主）')
  assert(local[1] === host[1], `本地上限 ${local[1]} 与宿主 ${host[1]} 不是同一个数`)
})

// ⑦ 文案完整性：界面上 tr() 用到的每个 key，zh / en / 英文兜底三处都要有。
//    少一处不会报错，只会让切换语言的人看到 "addAskSend" 这种字样 —— 静态看不出来，只能这么抓。
checkStack(CASES[7], () => {
  const src = readFileSync(FILE, 'utf8')
  const used = [...src.matchAll(/\btr\(["']([a-zA-Z][\w.]*)["']\)/g)].map((m) => m[1])
  assert(used.length >= 15, `没抓到 tr() 调用（候选 ${used.length} 条），这个检查等于没跑`)
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

// ⑧ 首屏就该能建：一句话框与发送按钮必须在（此时列表还在 loading，正好验"不依赖数据"）。
//    同时验"删干净了"——添加页、三段式表单、四个触发方式 radio 都不该再出现在源码里。
checkStack(CASES[8], () => {
  const page = mod.SourcesPage({ t: (key) => key })
  const nodes = nodesOf(page)
  const input = nodes.find((n) => n.props.id === 'rfx-ask')
  assert(input, `首屏没有一句话输入框（loading 态也要有）：${textOf(page).slice(0, 160)}`)
  assert(input.type === 'input', `一句话框不是原生 input：${String(input.type)}`)
  assert(typeof input.props.placeholder === 'string' && input.props.placeholder.length > 0, '输入框没有提示文字')
  // 按 className 定位而不是按文案：文案会被 tr() 解析成中/英，key 不会出现在渲染结果里
  const send = nodes.find((n) => n.type === 'button' && /rfx-askSend/.test(String(n.props.className || '')))
  assert(send, '没有发送按钮')
  assert(send.props.type === 'button', '发送按钮不是原生 button')
  assert(typeof send.props.children === 'string' && send.props.children.length > 0, '发送按钮没有可读文案')

  const src = readFileSync(FILE, 'utf8')
  assert(!/AddSourcePage/.test(src), '还留着专门的添加页（AddSourcePage）')
  assert(!/NewSourceForm/.test(src), '还留着三段式表单组件（NewSourceForm）')
  assert(!/rfx-add-source/.test(src), '还留着三段式表单的 id')
  assert(!/rfx-modeCard/.test(src), '还留着四种触发方式的选择卡')
  assert(!/newSourceBody|formBlocker/.test(src), '还留着表单专用的拼装/校验函数')
})

// ⑨ 无障碍底座。这些在界面上「少了也不会报错」：删掉 aria-live 只是读屏不播报，
//    把原生控件换成 div 只是键盘用不了 —— 所以只能靠渲染树断言守着。
checkStack(CASES[9], () => {
  const all = nodesOf(mod.SourcesPage({ t: (key) => key }))
  const ids = new Set(all.map((n) => n.props.id).filter(Boolean))
  // 所有 aria-labelledby / aria-describedby 都必须指向树里真的存在的 id（悬空引用读屏只会念个空）
  const refs = (attr) => all.flatMap((n) => String(n.props[attr] || '').split(/\s+/).filter(Boolean))
  const dangling = [...refs('aria-labelledby'), ...refs('aria-describedby')].filter((id) => !ids.has(id))
  assert(dangling.length === 0, `这些 aria 引用指向不存在的 id：${[...new Set(dangling)].join(', ')}`)

  const input = all.find((n) => n.props.id === 'rfx-ask')
  assert(input.props['aria-describedby'], '一句话框没有 aria-describedby，提示只靠视觉位置')

  // 投递结果必须有个常驻播报区：idle 时也在，读屏才有地方接话
  const live = all.find((n) => n.props.role === 'status')
  assert(live, '投递结果没有 role="status" 播报区')
  assert(live.props['aria-live'] === 'polite', `播报区不是 aria-live="polite"：${String(live.props['aria-live'])}`)

  const send = all.find((n) => n.type === 'button' && /rfx-askSend/.test(String(n.props.className || '')))
  assert(send && send.props.type === 'button', '发送按钮不是原生 button')

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
  // 判据用结构：有数据才渲染出 <table class="rfx-table">，没数据只有一行 loading 文案。
  try {
    await new Promise((r) => setTimeout(r, 0))   // 让预热那次 fetch 落地
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

  // P31 逐行「L1 调优」按钮：有 target 才可点；只采集的置灰并说清原因；内置源那一行根本不给按钮。
  try {
    const walk = (n, out = []) => {
      if (!n || typeof n !== 'object') return out
      if (Array.isArray(n)) { for (const x of n) walk(x, out); return out }
      out.push(n)
      const p = n.props || {}
      if (typeof n.type === 'function') walk(n.type(p), out)
      if ('children' in p) walk(p.children, out)
      return out
    }
    const trs = walk(mod.SourcesPage({ t: (key) => key })).filter((n) => n.type === 'tr')
    assert(trs.length >= 4, `渲染出来的行太少（${trs.length}），这条等于没跑`)
    const rows = trs.slice(1)                       // 首行是表头
    const rowOf = (name) => rows.find((tr) => textOf(tr).trim().startsWith(name))
    const tuneBtnOf = (tr) => walk(tr).find((n) => n.type === 'button' && /rfx-tune/.test(String(n.props.className || '')))

    const alpha = rowOf('alpha'), beta = rowOf('beta'), disk = rowOf('disk')
    assert(alpha && beta && disk, `三个样例行没渲染齐：${rows.map((r) => textOf(r).trim().slice(0, 8)).join(' / ')}`)
    const aBtn = tuneBtnOf(alpha)
    assert(aBtn, '有 L1 的行没有调优按钮')
    assert(!aBtn.props.disabled, '有 L1 的行按钮却是灰的')
    assert(typeof aBtn.props.title === 'string' && aBtn.props.title.length > 0, '按钮没有说明自己做什么')
    const bBtn = tuneBtnOf(beta)
    assert(bBtn, '只采集的行也应留一个按钮位（置灰 + 说明）')
    assert(bBtn.props.disabled === true, '只采集的行按钮竟然可点')
    assert(/只采集|only collects/i.test(String(bBtn.props.title ?? '')), `置灰原因没写清：${String(bBtn.props.title)}`)
    assert(!tuneBtnOf(disk), '内置源那一行不该有调优按钮')
    const all = walk(mod.SourcesPage({ t: (key) => key })).filter((n) => n.type === 'button' && /rfx-tune/.test(String(n.props.className || '')))
    assert(all.length === 2, `全页调优按钮 ${all.length} 个（应恰好 2 个脚本源）`)

    // 按钮文案要像动作，不能是内部层号：用户第一次看到「L1」不知道那是干什么的。
    const zhTune = String(mod.zh.tuneBtn || '')
    assert(zhTune && !/^L1$/i.test(zhTune), `调优按钮还在拿内部代号当文案：「${zhTune}」`)
    const zhTuneBtns = walk(mod.SourcesPage({ t: (k) => mod.zh[k] ?? k }))
      .filter((n) => n.type === 'button' && /rfx-tune/.test(String(n.props.className || '')))
    assert(zhTuneBtns.length === 2, `真文案下只找到 ${zhTuneBtns.length} 个调优按钮`)
    assert(zhTuneBtns.every((b) => textOf(b).includes(zhTune)), `真文案下按钮上看不到「${zhTune}」`)
    // 两字宽度像标签不像按钮：至少给到和「暂停采集」同一量级的存在感
    const tuneCss = /\.rfx-tune\{min-width:(\d+)px\}/.exec(readFileSync(FILE, 'utf8'))
    assert(tuneCss && Number(tuneCss[1]) >= 52, `调优按钮最小宽度 ${tuneCss ? tuneCss[1] : '缺失'}px，太窄会读成徽标`)

    // 成功回执不能用错误红：两个状态区（建源 / 调优）都要有成功态修饰类，CSS 也要定义它
    const src = readFileSync(FILE, 'utf8')
    const okUses = (src.match(/rfx-saveMsg--ok/g) || []).length
    assert(okUses >= 3, `成功态修饰类只出现 ${okUses} 次（两处状态区 + 一条 CSS 规则，至少 3 次）`)
    assert(/\.rfx-saveMsg--ok\{[^}]*color:var\(--rfx-ink2\)/.test(src), 'CSS 里没有 .rfx-saveMsg--ok 的颜色规则')
    results.push([CASES[12], true, ''])
  } catch (e) { results.push([CASES[12], false, e.message]) }

  // P32 旧宿主兼容：DSH 没重启时列表里没有 hasTarget 字段，按钮会整排变灰。
  // 「灰着不说话」和「坏了」在用户眼里是同一件事——必须自己喊出来该重启。
  try {
    const oldSandbox = {
      console,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({
        ok: true,
        sources: [
          { name: 'alpha', paused: false, factsToday: 1, lastFactAt: Date.now(), intervalMs: 900000 },
          { name: 'beta', paused: false, factsToday: 0, lastFactAt: 0, intervalMs: 900000 },
        ],
        builtin: [], scannedAt: Date.now(),
      }) }),
      window: { __ModuleLoader__: { load: (d) => { oldSandbox.__def = d } } },
      document: { documentElement: { dataset: {} }, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } },
    }
    vm.createContext(oldSandbox)
    vm.runInContext(code, oldSandbox)
    const oldMod = oldSandbox.__def.factory(requireFn)
    await new Promise((r) => setTimeout(r, 0))     // 让预热那次 list 落地
    const tree = oldMod.SourcesPage({ t: (k) => oldMod.zh[k] ?? k })
    const txt = textOf(tree)
    assert(/重启 DSH/.test(txt), `旧宿主下界面没有提示重启：${txt.trim().slice(0, 80)}`)
    const btns = nodesOf(tree).filter((n) => n.type === 'button' && /rfx-tune/.test(String(n.props.className || '')))
    assert(btns.length >= 2, `旧宿主下没渲染出调优按钮（${btns.length} 个）`)
    assert(btns.every((b) => b.props.disabled === true), '旧宿主下按钮竟然冒充可点')
    results.push([CASES[13], true, ''])
  } catch (e) { results.push([CASES[13], false, e.message]) }

  // P33 投递对象可选：下拉要列出宿主给的 targets，默认选中当前 targetBot；
  // 请求体必须真的带上 target（否则宿主只能投默认目标，界面却显示交给别人）。
  try {
    const pickSandbox = {
      console,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({
        ok: true,
        sources: [{ name: 'alpha', paused: false, factsToday: 1, lastFactAt: Date.now(), intervalMs: 900000, hasTarget: true }],
        builtin: [], scannedAt: Date.now(),
        targetBot: 'Chief',
        targets: [{ name: 'Chief', isDefault: true }, { name: '求职顾问', isDefault: false }],
      }) }),
      window: { __ModuleLoader__: { load: (d) => { pickSandbox.__def = d } } },
      document: { documentElement: { dataset: {} }, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } },
    }
    vm.createContext(pickSandbox)
    vm.runInContext(code, pickSandbox)
    const pickMod = pickSandbox.__def.factory(requireFn)
    await new Promise((r) => setTimeout(r, 0))
    const tree = pickMod.SourcesPage({ t: (k) => pickMod.zh[k] ?? k })
    const sel = nodesOf(tree).find((n) => n.type === 'select' && /rfx-target/.test(String(n.props.className || '')))
    assert(sel, '没有渲染出投递对象下拉')
    assert(sel.props.value === 'Chief', `下拉默认值不是当前目标：${String(sel.props.value)}`)
    const opts = (sel.props.children || []).filter(Boolean).map((o) => o.props?.value)
    assert(opts.includes('Chief') && opts.includes('求职顾问'), `下拉选项不全：${JSON.stringify(opts)}`)
    const label = String(sel.props['aria-label'] ?? '')
    assert(label.trim().length > 0, '下拉没有可读标签')
    // 请求体带 target；不传时不许凭空塞一个默认值进去（宿主会自己兜）
    assert(pickMod.delegateBody('盯着 x.com', '求职顾问').target === '求职顾问', 'delegateBody 没带目标')
    assert(!('target' in pickMod.delegateBody('盯着 x.com')), 'delegateBody 无目标时不该塞 target 字段')
    assert(pickMod.tuneBody('arxiv', '求职顾问').target === '求职顾问', 'tuneBody 没带目标')
    // 旧宿主会忽略 target 并投给默认目标：客户端必须能识别这种「假成功」
    assert(pickMod.targetMismatch('求职顾问', 'Chief') === 'Chief', '目标不一致没被识别出来')
    assert(pickMod.targetMismatch('Chief', 'Chief') === '', '目标一致却报了不一致')
    results.push([CASES[14], true, ''])
  } catch (e) { results.push([CASES[14], false, e.message]) }

  // ④ 调优弹窗（P34-P36）：先弹窗再投递
  try {
    const tr = (k) => mod.zh[k] ?? k
    const tree = mod.TuneDialog({ tr, name: 'arxiv', target: '求职顾问', value: '宁可少叫', phase: 'idle', error: '' })
    const nodes = nodesOf(tree)

    // 行里的按钮必须走 openTune，旧的一键直投路径不许留
    assert(/onClick: \(event\) => openTune\(r, event\)/.test(code), '行里的「调优」没有走 openTune（点一下就应该弹窗）')
    assert(!/void tuneRow\(r\)/.test(code), '旧的一键直投路径还在（绕过了偏好输入）')

    // 请求体：偏好原样带过去，空偏好不塞字段；长度闸与宿主同一个数
    assert(mod.tuneBody('arxiv', 'Chief', '宁可少叫').preference === '宁可少叫', 'tuneBody 没带偏好')
    assert(!('preference' in mod.tuneBody('arxiv', 'Chief', '   ')), '空偏好不该塞 preference 字段')
    assert(mod.preferenceBlocker('字'.repeat(501)) === 'tuneTooLong', '超长偏好没被本地挡住')
    assert(mod.preferenceBlocker('字'.repeat(500)) === '', '正好 500 字被误挡')

    // 失败不清空输入、不关窗：catch 分支里不许出现 setDlg(null)
    const startIdx = code.indexOf('const startTune = async () =>')
    assert(startIdx > 0, '找不到 startTune')
    const catchBlk = code.slice(startIdx + code.slice(startIdx).indexOf('} catch (e)'), startIdx + code.slice(startIdx).indexOf('} finally'))
    assert(!/setDlg\(null\)/.test(catchBlk), '投递失败把弹窗关了或把输入清了')
    results.push([CASES[15], true, ''])
  } catch (e) { results.push([CASES[15], false, e.message]) }

  try {
    const tr = (k) => mod.zh[k] ?? k
    const nodes = nodesOf(mod.TuneDialog({ tr, name: 'arxiv', target: 'Chief', value: '', phase: 'idle', error: 'boom' }))
    const dialog = nodes.find((n) => n.type === 'div' && n.props.role === 'dialog')
    assert(dialog, '没有渲染出 role=dialog')
    assert(dialog.props['aria-modal'] === 'true', '缺 aria-modal')
    const titleId = dialog.props['aria-labelledby']
    assert(titleId && nodes.some((n) => n.props.id === titleId), `aria-labelledby 指不到标题：${titleId}`)
    const descIds = String(dialog.props['aria-describedby'] || '').split(/\s+/).filter(Boolean)
    assert(descIds.length >= 2 && descIds.every((id) => nodes.some((n) => n.props.id === id)), 'aria-describedby 指不到说明文本')

    const ta = nodes.find((n) => n.type === 'textarea')
    assert(ta, '没有偏好输入框')
    assert(ta.props.id && ta.props['aria-describedby'], '输入框没有 id 或说明')
    assert(ta.props.maxLength === 500, `输入框 maxLength=${ta.props.maxLength}`)
    assert(ta.props.value === '', '偏好初值应为空')
    assert(ta.props.autoFocus === true, '打开时没有把焦点放到输入框')

    const body = nodes.find((n) => String(n.props.className || '').includes('rfx-dialogBody'))
    const foot = nodes.find((n) => n.type === 'footer')
    assert(body && foot, '缺正文区或操作条')
    const bodyNodes = new Set(nodesOf(body))
    assert(!bodyNodes.has(foot), '操作条被放进了滚动区（滚一下按钮就没了）')

    const alert = nodes.find((n) => n.props.role === 'alert')
    assert(alert && String(alert.props.className || '').includes('rfx-dialogErr'), '错误没有就地播报（role=alert）')
    results.push([CASES[16], true, ''])
  } catch (e) { results.push([CASES[16], false, e.message]) }

  try {
    const tr = (k) => mod.zh[k] ?? k
    let cancelled = 0
    let started = 0
    const idle = mod.TuneDialog({ tr, name: 'arxiv', target: 'Chief', value: '', phase: 'idle', onCancel: () => { cancelled += 1 }, onStart: () => { started += 1 } })
    const onKey = nodesOf(idle).find((n) => typeof n.props.onKeyDown === 'function').props.onKeyDown
    const kd = (extra) => onKey({ preventDefault() {}, ...extra })
    kd({ key: 'Escape' })
    assert(cancelled === 1, 'Esc 没有取消')
    kd({ key: 'Enter', ctrlKey: true })
    assert(started === 1, 'Ctrl+Enter 没有开始')

    // Tab 焦点陷阱：末尾 Tab 回到第一个控件，开头 Shift+Tab 回到最后一个
    const first = { disabled: false, focus() { first.focused = true } }
    const last = { disabled: false, focus() { last.focused = true } }
    const root = { querySelectorAll: () => [first, last] }
    sandbox.document.activeElement = last
    kd({ key: 'Tab', currentTarget: root })
    assert(first.focused === true, 'Tab 到末尾没有绕回开头（焦点会逃出弹窗）')
    sandbox.document.activeElement = first
    kd({ key: 'Tab', shiftKey: true, currentTarget: root })
    assert(last.focused === true, 'Shift+Tab 到开头没有绕回末尾')

    // 投递中：Esc / Ctrl+Enter 都不许再触发（否则用户以为取消掉了，其实已经投出去）
    const before = [cancelled, started]
    const sending = mod.TuneDialog({ tr, name: 'arxiv', target: 'Chief', value: '', phase: 'sending', onCancel: () => { cancelled += 1 }, onStart: () => { started += 1 } })
    const onKeyS = nodesOf(sending).find((n) => typeof n.props.onKeyDown === 'function').props.onKeyDown
    onKeyS({ key: 'Escape', preventDefault() {} })
    onKeyS({ key: 'Enter', ctrlKey: true, preventDefault() {} })
    assert(cancelled === before[0] && started === before[1], '投递中还能取消或重复开始')
    results.push([CASES[17], true, ''])
  } catch (e) { results.push([CASES[17], false, e.message]) }
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
