// 回归测试: 面板配置页的字段路径必须落在【配置根顶层】。
//
// 为什么需要这条测试 —— 这是实测踩过的坑, 而且症状极难定位:
//
//   DSH 的面板表单把【字段名】当作配置根下的路径写:
//       ops = [{ op: 'set', path: ['backend'], value: 'jev' }, ...]
//   宿主的 dsh-settings write() 会逐条校验 isVolatilePath(schema, path),
//   并且还会遍历写入后的文档校验每个键。若 schema 把字段嵌套一层
//   (decide.backend), 那么表单写出的路径 ['backend'] 在 schema 里找不到
//   —— 宿主抛 "Config field backend is not volatile", mutate 未落地,
//   界面只显示"保存失败, 已保留你的输入"。
//
//   为什么难查: 上游 SettingsFormModel.save() 的
//       catch (_error) { this.failed = true }
//   把异常丢掉了; 而且 landed=false 这条路径连异常都没有。desktop 版没有
//   开发者工具, 于是"保存失败"四个字是唯一可见信息。
//
// 所以这里直接断言: schema 的顶层字典就是那三个字段, 且没有 decide 这一层。

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)

// schemastery 是插件的正式依赖(见 package.json), 从仓库 node_modules 取
const z = require(join(repo, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'))

const { Config } = await import(join(repo, 'index.js'))

let pass = 0, total = 0
const ok = (label, cond, detail) => {
  total++
  if (cond) { pass++; console.log(`  [${label}] ✅ 通过`) }
  else console.log(`  [${label}] ❌ 失败${detail ? ' — ' + detail : ''}`)
}

// 复刻宿主的 isVolatilePath(dsh-settings/lib/index.js)
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : (schema.dict ?? {})[key]
  return child !== undefined && isVolatilePath(child, rest)
}

console.log('=== 1. schema 顶层就是表单会写的那些字段 ===')
const topKeys = Object.keys(Config.dict ?? {})
ok('顶层含 backend', topKeys.includes('backend'), `实际: ${JSON.stringify(topKeys)}`)
ok('顶层含 jevBaseUrl', topKeys.includes('jevBaseUrl'))
ok('顶层含 jevModel', topKeys.includes('jevModel'))

console.log('\n=== 2. 不能有 decide 中间层(表单不会写它) ===')
ok('顶层没有 decide', !topKeys.includes('decide'),
  '嵌套会让表单路径 ["backend"] 校验失败 -> 保存失败')

console.log('\n=== 3. 面板实际会写的路径必须被认作 volatile ===')
// 这三个 path 是从真实失败现场抓到的: ops=[{op:'set',path:['backend'],...}]
for (const f of ['backend', 'jevBaseUrl', 'jevModel']) {
  ok(`isVolatilePath(${f})`, isVolatilePath(Config, [f]) === true)
}

console.log('\n=== 4. 每个字段都要有 .volatile()(少了面板里连表单都不出现) ===')
for (const f of ['backend', 'jevBaseUrl', 'jevModel']) {
  const child = (Config.dict ?? {})[f]
  ok(`${f} 标了 volatile`, child && child.meta && child.meta.volatile === true)
}

console.log('\n=== 5. 解析扁平配置能拿到裸字符串(volatile 字段是取值器) ===')
const parsed = Config({ backend: 'jev', jevBaseUrl: 'https://openrouter.ai/api/v1', jevModel: 'typesafe/jev-1.13' })
const unwrap = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
ok('backend 解包为字符串', unwrap(parsed.backend) === 'jev', `实际: ${JSON.stringify(parsed.backend)}`)
ok('jevBaseUrl 解包为字符串', unwrap(parsed.jevBaseUrl) === 'https://openrouter.ai/api/v1')

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
