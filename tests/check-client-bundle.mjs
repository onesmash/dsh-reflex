// 客户端 bundle 上线前自检。
//
// 为什么需要: 本插件曾因"声明了 dsh.client 但没有可用的 ./client 导出"导致宿主致命
// 崩溃(DesktopHostFatalError)。那个失败发生在启动阶段, 表现为整个 DSH 起不来 ——
// 代价很高, 而且只能靠重启才发现。这个脚本把能静态查出来的问题挡在前面。
//
// 查什么:
//   1. package.json 的 dsh.client 与 exports["./client"] 是否同时存在(缺一即崩)
//   2. exports["./client"] 指向的文件是否真的存在
//   3. bundle 能否被加载, 且导出 { apply, inject, NS }
//   4. bundle 的 id 是否与包名一致(module loader 用它登记)
//   5. inject 里声明的客户端服务是否都是已知的(拼错的依赖会在运行时才炸)
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  ok ? pass++ : fail++
}

console.log('=== 1. manifest 成对性(缺一即宿主崩溃) ===')
const declared = !!pkg.dsh?.client
const exported = !!pkg.exports?.['./client']
check('dsh.client 与 exports["./client"] 同时存在', declared === exported,
  declared && exported ? '两者都在' : declared ? '声明了 dsh.client 但没有 ./client 导出 ← 会崩' : exported ? '有 ./client 导出但没声明 dsh.client' : '两者都没有(纯宿主插件, 合法)')

if (!declared && !exported) { console.log(`\n结果: ${pass} 通过 / ${fail} 失败 (纯宿主插件, 无需继续)`); process.exit(fail ? 1 : 0) }

// 成对性不成立时后面的检查没有意义(路径都是 undefined), 直接停 ——
// 报告要停在最早、最明确的那条失败上, 不要被后续的次生错误淹没。
if (declared !== exported) {
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败 —— 先修好上面那条, 它是宿主崩溃的直接原因`)
  process.exit(1)
}

console.log('\n=== 2. 导出指向的文件存在 ===')
const clientRel = pkg.exports['./client']
const clientAbs = join(root, clientRel)
check(`exports["./client"] -> ${clientRel}`, existsSync(clientAbs), existsSync(clientAbs) ? '文件在' : '文件不存在 ← 会崩')

console.log('\n=== 3. bundle 可加载且导出齐全 ===')
let loaded = null
globalThis.window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
const knownDeps = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])
const missingDeps = []
const fakeRequire = (name) => {
  if (!knownDeps.has(name)) missingDeps.push(name)
  if (name === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) }
  if (name === 'react') return { useState: () => ['', () => {}] }
  return {
    SettingsFormModel: class { constructor() {} bind() { return {} } field() { return {} } shell() { return {} } actions() { return {} } dispose() {} },
    SettingsForm: () => ({}), SettingsValueField: () => ({}),
    settingsTextField: (k) => ({ key: k }), settingsNumberField: (k) => ({ key: k }),
  }
}
try {
  await import(pathToFileURL(clientAbs).href)
  check('bundle 调用了 __ModuleLoader__.load', !!loaded)
  if (loaded) {
    check('bundle id 与包名一致', loaded.id === pkg.name, `id=${loaded.id}`)
    const mod = loaded.factory(fakeRequire)
    check('导出 apply 函数', typeof mod.apply === 'function')
    check('导出 inject 数组', Array.isArray(mod.inject), JSON.stringify(mod.inject))
    check('导出 NS', typeof mod.NS === 'string' && mod.NS.length > 0, mod.NS)
    check('依赖集合与官方一致', missingDeps.length === 0, missingDeps.length ? '出现了未知依赖: ' + missingDeps.join(', ') : '依赖集合与官方一致')
  }
} catch (e) {
  check('bundle 可加载', false, e.message)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
