// 测「pending 跨实例不丢」。
//
// 背景(2026-10-27 10:39 实测): 插件热重载时新旧实例短暂并存。
//   旧实例的 arxiv-watch 投递失败 → 把 8 条写进 pending-wakes.json;
//   新实例 install 时读到的是【失败之前】的旧快照, 下一轮 savePending 时
//   用自己的内存快照把整份文件盖掉 → 旧实例那一份 pending 静默消失, 补投丢了。
//   (日志里只有 "已攒 8 条待下轮重试", 之后再没有任何 arxiv-watch 轮次)
//
// 这个文件锁定两条行为:
//   1) savePending 只改自己那个 key, 不整份覆盖磁盘 (别的实例写的条目必须留着);
//   2) decideOnce 前重读磁盘 pending —— 启动快照之外的条目也要能补投出去。
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 允许指定被测实现(便于对旧版本做反例验证): REFLEX_INDEX=../index.prev.js
const { apply } = await import(process.env.REFLEX_INDEX ?? '../index.js')

const sh = (p, body) => { writeFileSync(p, body, 'utf8'); chmodSync(p, 0o755) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const noop = () => {}
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} } }

function makeHome(tag) {
  const home = mkdtempSync(join(tmpdir(), `reflex-pending-${tag}-`))
  mkdirSync(join(home, 'collectors'), { recursive: true })
  mkdirSync(join(home, 'targets'), { recursive: true })
  sh(join(home, 'collectors', 'probe.sh'), '#!/bin/bash\necho \'{"metric":"probe","raw":{"n":1}}\'\n')
  writeFileSync(join(home, 'collectors', 'probe.env.json'), JSON.stringify({ intervalMs: 60000 }), 'utf8')
  sh(join(home, 'targets', 'probe.sh'),
    '#!/bin/bash\ncat >/dev/null\necho \'{"wake":true,"reason":"probe 命中","fingerprint":{"ids":["p1"]},"items":[{"id":"p1","title":"t","body":"b"}]}\'\n')
  writeFileSync(join(home, 'targets', 'probe.env.json'), JSON.stringify({ sources: ['probe'], minIntervalMs: 0 }), 'utf8')
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify({ bots: { 'bot-chief': { name: 'Chief', sessionId: 'session-chief' } } }), 'utf8')
  return { home, statePath, pendingFile: join(home, 'pending-wakes.json') }
}

function makeCtx() {
  let attach = null
  const ctx = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    on: noop, effect: noop, get: () => undefined,
    tools: { register: noop }, systemPrompt: { section: noop }, schedule: { register: noop },
    workspaceRegistry: {}, sessionController: {}, sessionTitle: {},
    inject: (_deps, cb) => { attach = cb; cb({ sessionController: null, effect: noop }) },
  }
  return { ctx, attach: (sc) => attach({ sessionController: sc, effect: noop }) }
}

function makeInstance(tag) {
  const { home, statePath, pendingFile } = makeHome(tag)
  const { ctx, attach } = makeCtx()
  const api = apply(ctx, {
    statePath,
    l0: { homeDir: home, sources: ['probe'] },
    l1: { targets: ['probe'], targetBot: 'Chief', intervalMs: 60000 },
  })
  return { api, home, pendingFile, attach }
}

const goodSc = (sink) => ({ resolveAgent: async () => ({ agent: { followup: (m) => sink.push(m) } }) })

let pass = 0, total = 0
const ok = (label, cond, extra = '') => {
  total++
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond || !extra ? '' : '  → ' + extra}`)
  if (cond) pass++
}

// ---------- A. savePending 不得整份覆盖别的实例写进来的条目 ----------
console.log('=== A. 另一实例的 pending 条目不能被覆盖 ===')
{
  const { api, pendingFile } = makeInstance('a')
  await sleep(200)
  await api.collectOnce(); await api.decideOnce()          // 通道不可用 → 写 pending.probe
  ok('本实例 pending 已写入', (readJson(pendingFile).probe?.items ?? []).length === 1)

  // 模拟: 另一个(热重载残留的)实例在失败后往同一个文件里补了一条
  const disk = readJson(pendingFile)
  disk.ghost = { kind: 'script-target', reason: 'ghost', items: [{ id: 'g1', title: 'g', body: 'g' }] }
  writeFileSync(pendingFile, JSON.stringify(disk), 'utf8')

  await api.collectOnce(); await api.decideOnce()          // 再次失败 → 再 savePending('probe', ctx)
  ok('别的实例写的条目仍在', (readJson(pendingFile).ghost?.items ?? []).length === 1,
     JSON.stringify(readJson(pendingFile)).slice(0, 160))
  ok('自己的条目也还在', (readJson(pendingFile).probe?.items ?? []).length === 1)
}

// ---------- B. 启动快照之外的 pending 也要补投 ----------
console.log('\n=== B. 启动后才知道的 pending 必须补投 ===')
{
  const { api, pendingFile, attach } = makeInstance('b')
  await sleep(200)
  // 本实例启动时 pending 是空的; 之后旧实例补写进来(等价于热重载残留)
  writeFileSync(pendingFile, JSON.stringify({
    probe: { kind: 'script-target', reason: '旧实例攒的', header: null, fingerprint: null,
      items: [{ id: 'p1', title: 't', body: 'b' }], notices: [], scanned: 1, rounds: 1, carried: 1 },
  }), 'utf8')

  const delivered = []
  attach(goodSc(delivered))
  await api.collectOnce(); await api.decideOnce()
  ok('补投出去了', delivered.length === 1, `delivered=${delivered.length}`)
  ok('补投后 pending 清空', !readJson(pendingFile).probe, JSON.stringify(readJson(pendingFile)).slice(0, 120))
  ok('投出后才记指纹', !!readJson(join(pendingFile, '..', 'last-wake.json')).probe)
}

console.log(`\n${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
