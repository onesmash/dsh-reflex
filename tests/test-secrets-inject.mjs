// 测密钥注入: 直接调插件导出的 scriptEnv, 比对它递给脚本的环境变量。
// 不联网、不真跑脚本 —— 只看 env, 所以不会发任何东西出去。
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

// ---- 测试用密钥库: 一个相关的 + 一个无关的 ----
const dir = mkdtempSync(join(tmpdir(), 'layered-secrets-'))
const secretsFile = join(dir, 'secrets.json')
writeFileSync(secretsFile, JSON.stringify({
  secrets: [
    { name: 'LAYERED_JEV_API_KEY', value: 'test-key-DO-NOT-USE', purpose: 'test' },
    { name: 'SOME_OTHER_TOKEN', value: 'must-NOT-leak', purpose: 'unrelated' },
  ],
}), 'utf8')
chmodSync(secretsFile, 0o600)

function fakeCtx() {
  const noop = () => {}
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    on: noop, effect: noop, inject: noop, get: () => undefined,
    tools: { register: noop }, systemPrompt: { section: noop },
    schedule: { register: noop }, workspaceRegistry: {},
    sessionController: {}, sessionTitle: {},
  }
}

function check(label, config, expect) {
  let api
  try { api = apply(fakeCtx(), config) } catch (e) { console.log(`  [${label}] apply 抛错: ${e.message}`); return false }
  const env = api?.scriptEnv?.() ?? {}
  const got = {
    backend: env.LAYERED_DECIDE_BACKEND,
    baseUrl: env.LAYERED_JEV_BASE_URL,
    key: env.LAYERED_JEV_API_KEY,
    leaked: Object.values(env).includes('must-NOT-leak'),
  }
  const ok =
    got.backend === expect.backend &&
    (expect.baseUrl === undefined ? got.baseUrl === undefined : got.baseUrl === expect.baseUrl) &&
    (expect.key === undefined ? got.key === undefined : got.key === expect.key) &&
    got.leaked === false
  console.log(`  [${label}] ${ok ? '✅ 通过' : '❌ 不符'}`)
  console.log(`     LAYERED_DECIDE_BACKEND = ${got.backend ?? '(未注入)'}`)
  console.log(`     LAYERED_JEV_BASE_URL   = ${got.baseUrl ?? '(未注入)'}`)
  console.log(`     LAYERED_JEV_API_KEY    = ${got.key ? '已注入' : '(未注入)'}`)
  console.log(`     无关密钥(SOME_OTHER_TOKEN) = ${got.leaked ? '❌ 泄漏' : '未泄漏 ✓'}`)
  return ok
}

let pass = 0, total = 0
const T = (...a) => { total++; if (check(...a)) pass++ }

console.log('=== A. backend=jev (托管): 端点+key 都要注入 ===')
T('jev', { decide: { backend: 'jev', secretsFile, jevBaseUrl: 'https://api.typesafe.ai' }, l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'https://api.typesafe.ai', key: 'test-key-DO-NOT-USE' })

console.log('\n=== B. 不配 backend: 三个都不注入(走脚本默认 semif) ===')
T('默认', { decide: { secretsFile }, l0: { sources: ['disk'] } },
  { backend: undefined, baseUrl: undefined, key: undefined })

console.log('\n=== C. backend=semif: 只注入 backend, 不带 key/端点 ===')
T('semif', { decide: { backend: 'semif', secretsFile }, l0: { sources: ['disk'] } },
  { backend: 'semif', baseUrl: undefined, key: undefined })

console.log('\n=== D. backend=jev 但密钥库为空: backend/端点注入, key 缺 ===')
const bare = mkdtempSync(join(tmpdir(), 'layered-nosecret-'))
const bareFile = join(bare, 'secrets.json')
writeFileSync(bareFile, JSON.stringify({ secrets: [] }), 'utf8')
T('缺key', { decide: { backend: 'jev', secretsFile: bareFile, jevBaseUrl: 'http://127.0.0.1:30001' }, l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'http://127.0.0.1:30001', key: undefined })

console.log(`\n结果: ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
