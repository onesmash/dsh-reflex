// 测「插件递给脚本的环境里, CA 变量不能是空字符串」。
//
// 背景(2026-11-19 实测): live-asr 的 target 脚本要调 jev 打分, 在插件里一直报
//   [jev-score] ERROR: row "utt" failed: fetch failed
// 手工用同一个脚本、同一份输入跑就正常。二分到最后一层:
//   插件 scriptEnv 里 `SSL_CERT_FILE: process.env.SSL_CERT_FILE || ''` 注入了空字符串,
//   Node/OpenSSL 把 SSL_CERT_FILE="" 当成「CA 文件路径是空」→ TLS 握手失败 → fetch failed。
// 受影响的不是 jev 一家: 任何在脚本 target 里发 HTTPS 请求的代码都会这样静默挂掉。
//
// 这个文件锁定两条行为:
//   1) 宿主没有 CA 变量时, 子进程环境里【不能出现】这三个键(而不是出现空值);
//   2) 宿主给了真实路径时, 三个键都要传下去(保持原来的透传语义)。
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply } = await import('../index.js')

const fails = []
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : `  <- ${detail}`))
  if (!cond) fails.push(name)
}

const noop = () => {}
const makeCtx = () => ({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  on: noop, effect: noop, get: () => undefined,
  tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
  workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
  inject: (_d, cb) => cb({ sessionController: null, effect: noop }),
})

const makeApi = (home) => apply(makeCtx(), {
  statePath: join(home, 'state.json'),
  l0: { homeDir: home, sources: [], intervalMs: 60000 },
  l1: { targets: [], targetBot: 'Chief', intervalMs: 60000 },
})

const CA_KEYS = ['SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']
const saved = Object.fromEntries(CA_KEYS.map(k => [k, process.env[k]]))

// ① 宿主没有 CA 变量
for (const k of CA_KEYS) delete process.env[k]
const api1 = makeApi(mkdtempSync(join(tmpdir(), 'reflex-ca-a-')))
const env1 = api1.scriptEnv()
for (const k of CA_KEYS) {
  check(`无宿主值时 env 不含 ${k}`, !(k in env1), `实际 = ${JSON.stringify(env1[k])}`)
}

// ② 宿主给了真实路径
const caPath = '/tmp/reflex-test-ca.pem'
process.env.SSL_CERT_FILE = caPath
const api2 = makeApi(mkdtempSync(join(tmpdir(), 'reflex-ca-b-')))
const env2 = api2.scriptEnv()
check('SSL_CERT_FILE 透传', env2.SSL_CERT_FILE === caPath, String(env2.SSL_CERT_FILE))
check('CURL_CA_BUNDLE 跟随', env2.CURL_CA_BUNDLE === caPath, String(env2.CURL_CA_BUNDLE))
check('REQUESTS_CA_BUNDLE 跟随', env2.REQUESTS_CA_BUNDLE === caPath, String(env2.REQUESTS_CA_BUNDLE))

// ③ 宿主显式给空串(某些启动器会这么写) → 同样不能传空值下去
for (const k of CA_KEYS) process.env[k] = ''
const api3 = makeApi(mkdtempSync(join(tmpdir(), 'reflex-ca-c-')))
const env3 = api3.scriptEnv()
for (const k of CA_KEYS) {
  check(`宿主空串时 env 不含 ${k}`, !(k in env3), `实际 = ${JSON.stringify(env3[k])}`)
}

for (const k of CA_KEYS) {
  if (saved[k] === undefined) delete process.env[k]
  else process.env[k] = saved[k]
}

console.log()
if (fails.length) { console.log(`${fails.length} 项失败：${fails}`); process.exit(1) }
console.log('全部通过')
process.exit(0)
