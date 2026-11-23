#!/usr/bin/env node
// 把「添加数据源」整页渲染成静态 HTML，用来在真浏览器里做视觉核对。
//
// 为什么要有这个：面板跑在 DSH 里，改完只能靠人刷新页面看；而"静态检查全绿、一渲染就空白"
// 恰恰是最难发现的一类坏。这个脚本不启动 DSH，直接把组件树翻成 HTML（带真实 zh 文案与
// SRC_CSS），交给 headless Chrome 截图 —— 1440 / 820 / 390 各看一眼再提交。
//
// 用法：node tests/render-add-source.mjs [--out-dir /tmp/rfx-design]
// 产物：idle.html、filled.html、filled-narrow.html、match.html
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, '..', 'client.js')
const args = process.argv.slice(2)
const outFlag = args.indexOf('--out-dir')
const OUT = resolve(outFlag >= 0 ? args[outFlag + 1] : '/tmp/rfx-design')

let code
try { code = readFileSync(FILE, 'utf8') } catch { console.error(`未判定：读不到 ${FILE}`); process.exit(2) }

const sandbox = {
  console,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
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

const tr = (key) => mod.zh[key] || mod.en[key] || key
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link'])
let selectValue = null

function html(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(html).join('')
  if (typeof node.type === 'function') return html(node.type(node.props || {}))
  const p = node.props || {}
  const tag = node.type
  const attrs = []
  for (const [k, v] of Object.entries(p)) {
    if (k === 'children' || k.startsWith('on') || v == null || v === false) continue
    if (k === 'style') continue
    if (k === 'value' && (tag === 'select' || tag === 'textarea')) continue
    if (k === 'className') { attrs.push(`class="${esc(v)}"`); continue }
    if (k === 'htmlFor') { attrs.push(`for="${esc(v)}"`); continue }
    if (k === 'checked') { if (v && tag === 'input') attrs.push('checked'); continue }
    attrs.push(v === true ? k.toLowerCase() : `${k.toLowerCase()}="${esc(v)}"`)
  }
  if (tag === 'option' && selectValue != null && String(p.value) === String(selectValue)) attrs.push('selected')
  const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID.has(tag)) return open
  if (tag === 'textarea') return `${open}${esc(p.value != null ? p.value : '')}</textarea>`
  if (tag === 'select') {
    const prev = selectValue
    selectValue = p.value
    const kids = html(p.children)
    selectValue = prev
    return `${open}${kids}</select>`
  }
  const kids = 'children' in p ? html(p.children) : ''
  return `${open}${kids}</${tag}>`
}

const handlers = { onField: () => () => {}, onMode: () => () => {}, onProbe: () => {}, onSubmit: () => {}, onCancel: () => {}, onBack: () => {} }
const page = (form, probe, saveState) => html(mod.AddSourcePage({
  form, probe, saveState, tr, ...handlers,
}))

const EMPTY = { name: '', about: '', cmd: '', intervalMs: 900000, mode: 'all', keywords: '', criteria: '' }
const FILLED = {
  name: 'x-timeline',
  about: '技术关注列表里值得处理的那几条',
  cmd: "curl -s https://example.com/api | jq -c '.[]'",
  intervalMs: 900000,
  mode: 'match',
  keywords: '裁员, 仲裁, 昇腾',
  criteria: '',
}
const PROBE_OK = { phase: 'ok', data: { lines: 12, valid: 12, bad: 0, code: 0, timedOut: false, stderrTail: '', sample: ['{"id":"1","text":"…"}', '{"id":"2","text":"…"}'] }, error: '' }
const PROBE_BAD = { phase: 'ok', data: { lines: 4, valid: 2, bad: 2, code: 0, timedOut: false, stderrTail: '', sample: ['{"id":"1"}', 'not json'] }, error: '' }
const SAVE_ERR = { phase: 'error', error: '已存在：collectors/x-timeline.sh', name: '' }
const SAVE_OK = { phase: 'ok', error: '', name: 'x-timeline' }

const shell = (inner, pane) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trigger · 添加数据源（静态渲染）</title>
<style>
html,body{margin:0;height:100%;background:#f2f2f3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Hiragino Sans GB",sans-serif;-webkit-font-smoothing:antialiased;color:#1a1a1a}
body{display:flex;justify-content:center}
.demo-pane{width:${pane}px;max-width:100vw;height:${pane <= 420 ? 'auto' : '100vh'};background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.05);display:flex;flex-direction:column;overflow:hidden}
</style>
<style>
${mod.SRC_CSS}
</style>
</head>
<body><div class="demo-pane">${inner}</div></body>
</html>
`

const pages = {
  'idle.html': [EMPTY, { phase: 'idle', data: null, error: '' }, { phase: 'idle', error: '', name: '' }, 1120],
  'filled.html': [FILLED, PROBE_OK, { phase: 'idle', error: '', name: '' }, 1120],
  'filled-narrow.html': [FILLED, PROBE_OK, { phase: 'idle', error: '', name: '' }, 760],
  'match.html': [{ ...FILLED, mode: 'match' }, PROBE_BAD, SAVE_ERR, 1120],
  'all-done.html': [{ ...FILLED, mode: 'all' }, { phase: 'idle', data: null, error: '' }, SAVE_OK, 1120],
  'mobile.html': [FILLED, PROBE_OK, { phase: 'idle', error: '', name: '' }, 390],
}

mkdirSync(OUT, { recursive: true })
for (const [name, [form, probe, save, pane]] of Object.entries(pages)) {
  const out = join(OUT, name)
  writeFileSync(out, shell(page(form, probe, save), pane))
  const body = readFileSync(out, 'utf8')
  if (body.includes('{name}') || body.includes('{lines}') || body.includes('{code}')) {
    console.error(`FAIL ${name}: 占位符没替换干净`)
    process.exit(1)
  }
  console.log(`wrote ${out}`)
}
process.exit(0)
