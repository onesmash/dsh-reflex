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
    { name: 'JEV_API_KEY', value: 'test-key-DO-NOT-USE', purpose: 'test' },
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
T('jev', { backend: 'jev', secretsFile, jevBaseUrl: 'https://api.typesafe.ai', l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'https://api.typesafe.ai', key: 'test-key-DO-NOT-USE' })

console.log('\n=== B. 不配 backend: 三个都不注入(走脚本默认 semif) ===')
T('默认', { secretsFile, l0: { sources: ['disk'] } },
  { backend: undefined, baseUrl: undefined, key: undefined })

console.log('\n=== C. backend=semif: 只注入 backend, 不带 key/端点 ===')
T('semif', { backend: 'semif', secretsFile, l0: { sources: ['disk'] } },
  { backend: 'semif', baseUrl: undefined, key: undefined })

console.log('\n=== D. backend=jev 但密钥库为空: backend/端点注入, key 缺 ===')
const bare = mkdtempSync(join(tmpdir(), 'layered-nosecret-'))
const bareFile = join(bare, 'secrets.json')
writeFileSync(bareFile, JSON.stringify({ secrets: [] }), 'utf8')
T('缺key', { backend: 'jev', secretsFile: bareFile, jevBaseUrl: 'http://127.0.0.1:30001', l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'http://127.0.0.1:30001', key: undefined })

// ---- E/F/G: 从 .credentials.yaml 的 refs 段读(fake 值, 不碰真实凭据) ----
const cdir = mkdtempSync(join(tmpdir(), 'layered-cred-'))
const credFile = join(cdir, '.credentials.yaml')
writeFileSync(credFile, [
  'version: 1',
  'refs:',
  "  LAYERED_JEV_API_KEY: 'fake-cred-key'",
  "  SOME_OTHER_TOKEN: 'must-NOT-leak'",
  "  TYPESAFE_API_KEY: 'fake-typesafe-key'",
  'records:',
  '  some/grant:',
  "    kind: 'grant'",
].join('\n'), 'utf8')
chmodSync(credFile, 0o600)

console.log('\n=== E. backend=jev, key 在 .credentials.yaml 的 refs 段 ===')
T('cred-ok', { backend: 'jev', credentialsFile: credFile, secretsFile: join(cdir, 'nope.json'), jevBaseUrl: 'https://api.typesafe.ai', l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'https://api.typesafe.ai', key: 'fake-cred-key' })

console.log('\n=== F. 两个文件都没有 key: 只有 backend/端点 ===')
T('cred-none', { backend: 'jev', credentialsFile: join(cdir, 'absent.yaml'), secretsFile: join(cdir, 'absent.json'), jevBaseUrl: 'https://api.typesafe.ai', l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'https://api.typesafe.ai', key: undefined })

console.log('\n=== G. refs 段结束后的内容不能被误读(key 在 records 段里) ===')
const c2 = join(cdir, '.credentials2.yaml')
writeFileSync(c2, [
  'version: 1',
  'refs:',
  "  OTHER_KEY: 'x'",
  'records:',
  '  LAYERED_JEV_API_KEY:',
  "    kind: 'grant'",
].join('\n'), 'utf8')
T('cred-boundary', { backend: 'jev', credentialsFile: c2, secretsFile: join(cdir, 'absent.json'), l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'https://api.typesafe.ai', key: undefined })

console.log('\n=== H. 旧名 LAYERED_JEV_API_KEY 仍应被读到(向后兼容) ===')
const olddir = mkdtempSync(join(tmpdir(), 'layered-oldname-'))
const oldSecret = join(olddir, 'secrets.json')
writeFileSync(oldSecret, JSON.stringify({
  secrets: [{ name: 'LAYERED_JEV_API_KEY', value: 'old-name-key', purpose: 'legacy' }],
}), 'utf8')
T('旧名回退', { backend: 'jev', credentialsFile: join(olddir, 'none.yaml'), secretsFile: oldSecret, l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'https://api.typesafe.ai', key: 'old-name-key' })

console.log('\n=== I. 主名优先于旧名(两个都在时取主名) ===')
const bothdir = mkdtempSync(join(tmpdir(), 'layered-both-'))
const bothSecret = join(bothdir, 'secrets.json')
writeFileSync(bothSecret, JSON.stringify({
  secrets: [
    { name: 'LAYERED_JEV_API_KEY', value: 'old-name-key', purpose: 'legacy' },
    { name: 'JEV_API_KEY', value: 'primary-key', purpose: 'primary' },
  ],
}), 'utf8')
T('主名优先', { backend: 'jev', credentialsFile: join(bothdir, 'none.yaml'), secretsFile: bothSecret, l0: { sources: ['disk'] } },
  { backend: 'jev', baseUrl: 'https://api.typesafe.ai', key: 'primary-key' })

console.log('\n=== J. volatile 字段必须被解包(否则切后端静默失效) ===')
{
  // 场景 A-J 用的都是 Config 声明过的 volatile 字段。
  // 若哪天忘了解包, backend/端点会变成取值器对象, 注入的环境变量就不对 —— 且不报错。
  let api
  try {
    api = apply(fakeCtx(), {
      l0: { sources: ['disk'] },
      backend: 'jev', jevBaseUrl: 'https://openrouter.ai/api/v1', jevModel: 'typesafe/jev-1.13',
    })
  } catch (e) { console.log('  apply 抛错:', e.message) }
  const env = api?.scriptEnv?.() ?? {}
  const body = env.LAYERED_DECIDE_BACKEND === 'jev'
    && env.LAYERED_JEV_BASE_URL === 'https://openrouter.ai/api/v1'
    && env.LAYERED_JEV_MODEL === 'typesafe/jev-1.13'
  // ⚠️ 必须走 T() —— 直接调 check() 会打印 ✅ 却不计入 pass/total,
  //    于是汇总数字偏小、看起来"通过"其实漏了这条(本文件就踩过一次)。
  T('volatile', {
    l0: { sources: ['disk'] },
    backend: 'jev', jevBaseUrl: 'https://openrouter.ai/api/v1', jevModel: 'typesafe/jev-1.13',
  }, { backend: 'jev', baseUrl: 'https://openrouter.ai/api/v1', key: undefined })
  if (!body) console.log('     ⚠️ volatile 解包异常: 端点/模型与预期不符')
}

console.log(`\n结果: ${pass}/${total} 通过`)
if (pass !== total) console.log(`⚠️ 有 ${total - pass} 项未通过`)
process.exit(pass === total ? 0 : 1)
