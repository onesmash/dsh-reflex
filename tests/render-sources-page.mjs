#!/usr/bin/env node
// 把 Trigger 首页（列表 + 一句话输入框）渲染成静态 HTML，用来在真浏览器里做视觉核对。
//
// 为什么还要它：P18/P20 能证明控件在、属性齐，但证明不了"看起来没塌"——
// 而「静态检查全绿、一渲染就空白/错位」恰恰是最难发现的一类坏。
// 这个脚本不启动 DSH，把组件树翻成 HTML（真实 zh 文案 + SRC_CSS + 宿主主题 token），
// 交给 headless Chrome 截图：1440 / 760 / 390 各看一眼。
//
// 用法：node tests/render-sources-page.mjs [--out-dir /tmp/rfx-sources]
// 产物：idle.html、narrow.html、mobile.html、dark.html
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, '..', 'client.js')
const args = process.argv.slice(2)
const outFlag = args.indexOf('--out-dir')
const OUT = resolve(outFlag >= 0 ? args[outFlag + 1] : '/tmp/rfx-sources')

let code
try { code = readFileSync(FILE, 'utf8') } catch { console.error(`未判定：读不到 ${FILE}`); process.exit(2) }

// 列表数据来自插件预热那次 list 请求：静态渲染里用一份样例，逼真到能看出列宽/换行。
const SAMPLE = {
  ok: true,
  sources: [
    { name: 'x-timeline', paused: false, factsToday: 37, lastFactAt: Date.now() - 6 * 60000, intervalMs: 2700000, hasTarget: true },
    { name: 'arxiv', paused: false, factsToday: 8, lastFactAt: Date.now() - 32 * 60000, intervalMs: 1800000, hasTarget: true },
    { name: 'live-asr', paused: false, factsToday: 3, lastFactAt: Date.now() - 90 * 1000, intervalMs: 60000, hasTarget: true },
    { name: 'screen-ocr', paused: true, factsToday: 0, lastFactAt: 0, intervalMs: 20000, hasTarget: true },
    { name: 'jev-comp', paused: false, factsToday: 2, lastFactAt: Date.now() - 55 * 60000, intervalMs: 1800000, hasTarget: true },
    { name: 'tidemark', paused: false, factsToday: 1, lastFactAt: Date.now() - 3 * 60000, intervalMs: 3600000, hasTarget: false },
  ],
  builtin: [{ name: 'disk', enabled: true }, { name: 'cpu', enabled: false }],
  targetBot: 'Chief',
  targets: [{ name: 'Chief', isDefault: true }, { name: '求职顾问', isDefault: false }, { name: 'Agent工程师', isDefault: false }],
  scannedAt: Date.now(),
}

const sandbox = {
  console,
  fetch: async () => ({ ok: true, status: 200, json: async () => SAMPLE }),
  window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def } } },
  document: { documentElement: { dataset: {} }, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } },
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

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
    function Stub() { return new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) }
    return new Proxy({}, { get: () => Stub })
  }
  throw new Error(`unexpected require: ${name}`)
}
const mod = sandbox.__def.factory(requireFn)

// 等预热那次 list 落地，首帧才有表可铺（P22 的行为在静态渲染里也要一致）。
await new Promise((r) => setTimeout(r, 0))

const tr = (key) => mod.zh[key] || mod.en[key] || key
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link'])

function html(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(html).join('')
  if (typeof node.type === 'function') return html(node.type(node.props || {}))
  const p = node.props || {}
  const tag = node.type
  if (tag === 'style') return ''            // 样式表统一放进 <head>
  const attrs = []
  for (const [k, v] of Object.entries(p)) {
    if (k === 'children' || k.startsWith('on') || v == null || v === false) continue
    if (k === 'style') continue
    if (k === 'className') { attrs.push(`class="${esc(v)}"`); continue }
    if (k === 'htmlFor') { attrs.push(`for="${esc(v)}"`); continue }
    attrs.push(v === true ? k.toLowerCase() : `${k.toLowerCase()}="${esc(v)}"`)
  }
  const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID.has(tag)) return open
  const kids = 'children' in p ? html(p.children) : ''
  return `${open}${kids}</${tag}>`
}

// 宿主主题快照（2026-11-24 从 DSH app.asar 的 token 定义里读出）：静态渲染不接宿主，
// 必须把真实 token 注进来，否则 CSS 里的 light 兜底值会把 dark 下的问题（白底白字）藏起来。
const HOST_THEME = {
  light: {
    base: '#ffffff', frame: '#f2f2f3', fg: '#0f1115',
    vars: {
      '--dsw-alias-label-primary': '#0f1115',
      '--dsw-alias-label-secondary': '#6b7280',
      '--dsw-alias-label-tertiary': '#9ca3af',
      '--dsw-alias-border-l1': 'rgba(0,0,0,.06)',
      '--dsw-alias-border-l2': 'rgba(0,0,0,.12)',
      '--dsw-alias-bg-layer-1': '#ffffff',
      '--dsw-alias-bg-layer-2': '#f6f7f8',
      '--dsw-alias-brand-primary': '#0f1115',
      '--dsw-alias-label-primary-inverted': '#ffffff',
    },
  },
  dark: {
    base: '#151517', frame: '#0b0b0c', fg: '#f9fafb',
    vars: {
      '--dsw-alias-label-primary': '#f9fafb',
      '--dsw-alias-label-secondary': '#cfd3d6',
      '--dsw-alias-label-tertiary': '#adb2b8',
      '--dsw-alias-border-l1': 'rgba(255,255,255,.06)',
      '--dsw-alias-border-l2': 'rgba(255,255,255,.12)',
      '--dsw-alias-bg-layer-1': '#232324',
      '--dsw-alias-bg-layer-2': '#2c2c2e',
      '--dsw-alias-brand-primary': '#f9fafb',
      '--dsw-alias-label-primary-inverted': '#353638',
    },
  },
}

const shell = (inner, pane, theme = 'light') => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trigger · 数据源（静态渲染）</title>
<style>
html,body{margin:0;height:100%;background:${HOST_THEME[theme].frame};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Hiragino Sans GB",sans-serif;-webkit-font-smoothing:antialiased;color:${HOST_THEME[theme].fg}}
body{display:flex;justify-content:flex-start}
:root{${Object.entries(HOST_THEME[theme].vars).map(([k, v]) => `${k}:${v};`).join('')}}
.demo-pane{width:${pane}px;max-width:100vw;height:${pane <= 420 ? 'auto' : '100vh'};background:${HOST_THEME[theme].base};box-shadow:0 0 0 1px rgba(127,127,127,.18);display:flex;flex-direction:column;overflow:hidden}
</style>
<style>
${mod.SRC_CSS}
</style>
</head>
<body><div class="demo-pane">${inner}</div></body>
</html>
`

const page = () => html(mod.SourcesPage({ t: (key) => tr(key) }))
const pages = {
  'idle.html': [1440, 'light'],
  'narrow.html': [760, 'light'],
  'mobile.html': [390, 'light'],
  'dark.html': [1120, 'dark'],
}

mkdirSync(OUT, { recursive: true })
const body = page()
for (const [name, [pane, theme]] of Object.entries(pages)) {
  const out = join(OUT, name)
  writeFileSync(out, shell(body, pane, theme))
  const text = readFileSync(out, 'utf8')
  // 占位符残留过一次（它在渲染层才会被替换），静态检查看不出来，所以这里直接断言
  if (/\{(name|lines|code|target|n|m)\}/.test(text)) {
    console.error(`FAIL ${name}: 界面里还留着占位符`)
    process.exit(1)
  }
  console.log(`wrote ${out}`)
}
process.exit(0)
