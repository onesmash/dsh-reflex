#!/usr/bin/env python3
"""reflex-health 回归测试: 采集器判据 + target 判定, 带断言。

用法: python3 tests/reflex-health-regress.py
沙箱运行, 不碰真实 REFLEX_HOME; 测试对象是 defaults/reflex-health(随包分发的版本)。
"""
import json, os, shutil, subprocess, time, datetime as dt, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REAL = os.path.expanduser('~/.dsh/dsh-reflex')
# 测试对象优先级: repo defaults(随包分发版) → 运行目录副本。
# 同一份测试文件放 repo tests/ 与运行目录 tests/ 都能跑, 不再漂移。
_COL_CAND = [
    os.path.join(HERE, '..', 'defaults/reflex-health/collectors/reflex-health.sh'),
    os.path.join(REAL, 'collectors/reflex-health.sh'),
]
_TGT_CAND = [
    os.path.join(HERE, '..', 'defaults/reflex-health/targets/reflex-health.sh'),
    os.path.join(REAL, 'targets/reflex-health.sh'),
]
COL = next((p for p in _COL_CAND if os.path.exists(p)), _COL_CAND[-1])
TGT = next((p for p in _TGT_CAND if os.path.exists(p)), _TGT_CAND[-1])
BASE = '/tmp/rh-regress'
NOW = time.time()

results = []


def iso(off):
    return dt.datetime.fromtimestamp(NOW + off, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def fresh(name):
    d = os.path.join(BASE, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(os.path.join(d, 'facts'), exist_ok=True)
    return d


def write_log(home, lines):
    open(os.path.join(home, 'dsh-reflex.log'), 'w').write('\n'.join(lines) + '\n')


def write_fact(home, src, date, ts_ms):
    d = os.path.join(home, 'facts', src)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, date), 'a').write(json.dumps({'ts': ts_ms, 'metric': 'x'}) + '\n')


def run_col(home, env=None):
    # REFLEX_HEALTH_PROBE=0: 关掉事件型源的探活(mail 会真去调公司接口)。
    # 测试不能依赖外部世界 —— 否则用户邮箱里恰好有信时, 静默用例会假失败。
    # BOOT_MS=0: 关掉"重启前失败过滤", 让既有用例按连续运行语义测; 重启过滤有独立用例。
    e = dict(os.environ, REFLEX_HOME=home, REFLEX_HEALTH_PROBE='0', REFLEX_HEALTH_BOOT_MS='0')
    e.update(env or {})
    p = subprocess.run(['bash', COL], capture_output=True, text=True, env=e)
    return p.returncode, [json.loads(l) for l in p.stdout.splitlines() if l.strip()], p.stderr


def run_tgt(home, facts, env=None):
    e = dict(os.environ, REFLEX_HOME=home)
    e.update(env or {})
    inp = ''.join(json.dumps(f) + '\n' for f in facts)
    p = subprocess.run(['bash', TGT], input=inp, capture_output=True, text=True, env=e)
    out = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
    return p.returncode, (out[0] if out else None), p.stderr


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('   → ' + detail) if detail and not ok else ''))


FAIL = lambda src, err='boom', off=-600: f'[{iso(off)}] L0 {src} failed: {err}'
DFAIL = lambda src: f'[{iso(-600)}] L1[{src}] error: Command failed: run_score.sh'
WAKE = f'[{iso(-300)}] L2 wake failed: sessionController unavailable'
RELOAD = lambda i: f'[{iso(-i * 60)}] dsh-reflex installed: L0=60000ms sources=[disk]'
CLEAN = f'[{iso(-600)}] L0: +2 fact(s)'

print('== 采集器: 日志类判据 ==')
h = fresh('c1')
write_log(h, [CLEAN, f'[{iso(-540)}] L1[disk]: SemIf winning=no pYes=0.14'])
rc, facts, _ = run_col(h)
check('干净日志 → 零输出', rc == 0 and not facts, f'rc={rc} n={len(facts)}')

h = fresh('c2')
write_log(h, [FAIL('mail', off=-600), FAIL('mail', off=-540), FAIL('mail', off=-480),
              FAIL('x-timeline'),                                     # x-timeline 只有 1 次
              DFAIL('disk'), DFAIL('disk'), WAKE, WAKE] + [RELOAD(i) for i in range(25)])
rc, facts, _ = run_col(h)
keys = sorted(f['meta']['key'] for f in facts)
check('异常日志 → 4 类问题, 单次失败不报',
      keys == sorted(['collector-failure:mail', 'decision-failure:disk', 'wake-failed:-', 'crash-loop:-']),
      str(keys))

rc2, facts2, _ = run_col(h)
check('同一批重放 → 幂等零输出', rc2 == 0 and not facts2, f'n={len(facts2)}')

write_log(h, [CLEAN])
rc3, facts3, _ = run_col(h)
check('恢复正常 → 4 条 recovered',
      len(facts3) == 4 and all(f['metric'] == 'recovered' for f in facts3), str(len(facts3)))

h = fresh('c2b')          # 同一故障被重复执行两遍(两条日志相隔 1.9s) → 只算 1 次, 不报
write_log(h, [FAIL('global-risk', off=-120), FAIL('global-risk', off=-118)])
rc, facts, _ = run_col(h)
check('同一源 2 秒内重复失败 → 算 1 次, 不报',
      not facts, str([f['meta']['key'] for f in facts]))

h = fresh('c2c')          # 重启过滤: 重启前的失败不该被 60 分钟窗口回放
pre1 = f'[{iso(-3600)}] L0 mail failed: boom'
pre2 = f'[{iso(-3500)}] L0 mail failed: boom'
post1 = f'[{iso(-120)}] L0 mail failed: boom'
write_log(h, [pre1, pre2, post1])
BOOT = int((NOW - 600) * 1000)          # 10 分钟前刚重启
rc, facts, _ = run_col(h, {'REFLEX_HEALTH_BOOT_MS': str(BOOT)})
check('重启前的失败不回放(只剩 1 次 → 不报)',
      not facts, str([f['meta']['key'] for f in facts]))

h = fresh('c2d')
write_log(h, [pre1, pre2, post1, f'[{iso(-60)}] L0 mail failed: boom'])
rc, facts, _ = run_col(h, {'REFLEX_HEALTH_BOOT_MS': str(BOOT)})
keys = sorted(f['meta']['key'] for f in facts)
check('重启后的失败正常计数(2 次 → 报)',
      keys == ['collector-failure:mail'], str(keys))

h = fresh('c2c')          # 系统级故障: 多源同时 EAGAIN → 合并成一条, 不逐个报
# 只用内置源(disk/mail/swap): 沙箱里没有 collectors 目录, 非内置源会被 source_exists 过滤掉
write_log(h, [FAIL('disk', 'spawn df EAGAIN', off=-600),
              FAIL('disk', 'spawn df EAGAIN', off=-540),
              FAIL('mail', 'spawn /bin/bash EAGAIN', off=-600),
              FAIL('mail', 'spawn /bin/bash EAGAIN', off=-540),
              FAIL('swap', 'spawn /bin/bash EAGAIN', off=-600),
              FAIL('swap', 'spawn /bin/bash EAGAIN', off=-540)])
rc, facts, _ = run_col(h)
keys = sorted(f['meta']['key'] for f in facts)
check('3 个源同时 EAGAIN → 合并为一条环境级问题',
      keys == ['environment-failure:-'], str(keys))
rc2, out, _ = run_tgt(h, facts)
check('环境级问题 → target 渲染正确(不出现 None)',
      bool(out and out.get('wake') and '系统无法创建进程' in out['items'][0]['title']
           and 'None' not in json.dumps(out, ensure_ascii=False)),
      str(out)[:160])

print('== 采集器: 静默判据 ==')
# ⚠️ 这两条不能依赖"跑测试的时间恰好在安静时段" —— 凌晨写的用例到了上午就会假失败(踩过)。
#    用显式的安静窗口把两种情形钉死: 全天安静 / 除最后一分钟外都算工作时段。
QUIET_ALL = {'REFLEX_HEALTH_QUIET_FROM': '00:00', 'REFLEX_HEALTH_QUIET_TO': '23:59'}
QUIET_NONE = {'REFLEX_HEALTH_QUIET_FROM': '23:59', 'REFLEX_HEALTH_QUIET_TO': '00:00'}

h = fresh('c3')
write_log(h, [CLEAN])
write_fact(h, 'mail', '2026-10-12.jsonl', int((NOW - 3 * 86400) * 1000))
write_fact(h, 'disk', '2026-10-15.jsonl', int((NOW - 60) * 1000))
rc, facts, _ = run_col(h, QUIET_ALL)
check('安静时段(E1) → 不报静默', not facts, str([f['metric'] for f in facts]))

h = fresh('c3b')                      # 独立沙箱: E1 已经写过状态文件, 共用会被去重压掉
write_log(h, [CLEAN])
write_fact(h, 'mail', '2026-10-12.jsonl', int((NOW - 3 * 86400) * 1000))
write_fact(h, 'disk', '2026-10-15.jsonl', int((NOW - 60) * 1000))
rc, facts, _ = run_col(h, QUIET_NONE)
keys = sorted(f['meta']['key'] for f in facts)
check('工作时段(E2) → 只报 mail, 不报刚有数据的 disk',
      keys == ['source-silent:mail'], str(keys))

h = fresh('c4')
write_log(h, [CLEAN])
write_fact(h, 'mail', '2026-10-12.jsonl', int((NOW - 3 * 86400) * 1000))
rc, facts, _ = run_col(h, dict(QUIET_NONE, REFLEX_HEALTH_STALE_MIN='mail=8000'))
check('阈值 env 覆盖生效 → 压住不报', not facts or facts[0]['metric'] == 'recovered', str(len(facts)))

h = fresh('c5')                       # 采集失败 + 静默同源: 只报一次(采集失败)
write_log(h, [FAIL('mail', off=-600), FAIL('mail', off=-540), FAIL('mail', off=-480)])
write_fact(h, 'mail', '2026-10-12.jsonl', int((NOW - 3 * 86400) * 1000))
rc, facts, _ = run_col(h, QUIET_NONE)
keys = sorted(f['meta']['key'] for f in facts)
check('同一源既有采集失败又静默 → 只报采集失败, 静默去重',
      keys == ['collector-failure:mail'], str(keys))

print('== 采集器: 事件型源静默要先探活(mail) ==')
# 背景: mail 的"合法安静时长"没有上界 —— 就是没人发邮件。固定阈值只能在 150 → 240
# 之间来回抬(两次都误报过)。所以超过阈值时先探活: 通 = 只是安静, 不通 = 真故障。
# 探活指向一个桩 helper, 测试因此完全封闭, 不碰外部世界。


def stub_helper(home, name, body, rc=0):
    p = os.path.join(home, name)
    with open(p, 'w') as fh:
        fh.write('#!/bin/bash\n' + body + f'\nexit {rc}\n')
    os.chmod(p, 0o755)
    return p


OLD_MAIL = int((NOW - 3 * 86400) * 1000)

h = fresh('p1')
write_log(h, [CLEAN]); write_fact(h, 'mail', '2026-10-12.jsonl', OLD_MAIL)
alive = stub_helper(h, 'helper-alive.sh', """echo '{"messages":[{"id":"m1"}]}'""")
rc, facts, _ = run_col(h, dict(QUIET_NONE, REFLEX_HEALTH_PROBE='1', REFLEX_HELPER=alive))
check('探活成功 → 不报静默(源是好的, 只是没信)', not facts, str([f['metric'] for f in facts]))

h = fresh('p2')
write_log(h, [CLEAN]); write_fact(h, 'mail', '2026-10-12.jsonl', OLD_MAIL)
dead = stub_helper(h, 'helper-dead.sh', 'echo "boom" >&2', rc=1)
rc, facts, _ = run_col(h, dict(QUIET_NONE, REFLEX_HEALTH_PROBE='1', REFLEX_HELPER=dead))
check('探活失败 → 照报静默', [f['meta']['key'] for f in facts] == ['source-silent:mail'],
      str([f['metric'] for f in facts]))

h = fresh('p3')
write_log(h, [CLEAN]); write_fact(h, 'mail', '2026-10-12.jsonl', OLD_MAIL)
empty = stub_helper(h, 'helper-empty.sh', """echo '{"messages":[]}'""")
rc, facts, _ = run_col(h, dict(QUIET_NONE, REFLEX_HEALTH_PROBE='1', REFLEX_HELPER=empty))
check('探活通了但接口返回空 → 报(这才是真故障长相)',
      [f['meta']['key'] for f in facts] == ['source-silent:mail'], str([f['metric'] for f in facts]))

h = fresh('p4')
write_log(h, [CLEAN]); write_fact(h, 'mail', '2026-10-12.jsonl', OLD_MAIL)
rc, facts, _ = run_col(h, dict(QUIET_NONE, REFLEX_HEALTH_PROBE='1',
                               REFLEX_HELPER=os.path.join(h, 'does-not-exist')))
# 2026-10-17 改判: 探活本身跑不起来(helper 网关不可达/超时) ≠ 源坏了。
# 真故障会以"采集失败"(采集器非 0 退出)出现; 静默是弱信号, 不可判定时不该打扰。
check('探活根本跑不起来(不可判定) → 不报静默, 让采集失败路径负责',
      not facts, str([f['metric'] for f in facts]))

print('== 采集器: zoom-im 静默探活(与 mail 同机制) ==')
# 事件型源 zoom-im 同样适用"先探活再报": 通道活着(能列会话) → 只是没新消息, 不报。
# 用桩 helper 分别模拟"返回会话列表"(活) 和 "接口失败"(死)。

h = fresh('z1')
write_log(h, [CLEAN]); write_fact(h, 'zoom-im', '2026-10-12.jsonl', OLD_MAIL)
alive = stub_helper(h, 'helper-zalive.sh', """echo '{"sessions":[{"id":"s1"}]}'""")
rc, facts, _ = run_col(h, dict(QUIET_NONE, REFLEX_HEALTH_PROBE='1', REFLEX_HELPER=alive))
check('zoom-im 探活成功(能列会话) → 不报静默', not facts, str([d['metric'] for d in facts]))

h = fresh('z2')
# 收编泛化后, defaults 默认 STALE 不含 zoom-im(个人源) —— 用 env 覆盖注册阈值,
# 顺带覆盖 REFLEX_HEALTH_STALE_MIN 注入路径本身。
write_log(h, [CLEAN]); write_fact(h, 'zoom-im', '2026-10-12.jsonl', OLD_MAIL)
dead = stub_helper(h, 'helper-zdead.sh', 'echo "boom" >&2', rc=1)
rc, facts, _ = run_col(h, dict(QUIET_NONE, REFLEX_HEALTH_PROBE='1', REFLEX_HELPER=dead,
                               REFLEX_HEALTH_STALE_MIN='zoom-im=240'))
check('zoom-im 探活失败 → 照报静默(env 覆盖注册阈值)', [f['meta']['key'] for f in facts] == ['source-silent:zoom-im'],
      str([f['meta']['key'] for f in facts]))

print('== 采集器: 重载阈值边界 ==')
for n, want in ((6, False), (20, True), (25, True)):
    h = fresh(f'r{n}')
    write_log(h, [RELOAD(i) for i in range(n)])
    rc, facts, _ = run_col(h)
    got = any(f['metric'] == 'crash-loop' for f in facts)
    check(f'{n} 次重载 → {"报" if want else "不报"}', got == want, f'got={got}')

print('== 采集器: 投递失败阈值 (单次必报) ==')
h = fresh('w1')
write_log(h, [WAKE])
rc, facts, _ = run_col(h)
check('单次 wake failed → 报', any(f['meta']['key'] == 'wake-failed:-' for f in facts),
      str([f['meta']['key'] for f in facts]))

h = fresh('w2')
write_log(h, [FAIL('mail')])
rc, facts, _ = run_col(h)
check('单次采集失败 → 仍不报(抖动不打扰)', not facts, str([f['meta']['key'] for f in facts]))

print('== 集成: 采集器的真实输出直接喂给 target ==')
# 为什么单列这一节: 之前 target 的用例喂的是手写事实, 而手写时我"顺手"写了 source 字段,
# 采集器实际写的是 subject —— 两边字段名不一致, 测试全绿, 通知里却显示 "数据源静默 · None"
# 和 "collectors/None.sh"。现在改成跑真采集器、把它的 stdout 原样喂给 target。
h = fresh('i1')
write_log(h, [FAIL('mail', off=-600), FAIL('mail', off=-540), FAIL('mail', off=-480)])
rc, facts, _ = run_col(h)
rc2, out, _ = run_tgt(h, facts)
txt = ' '.join((i.get('title', '') + ' ' + i.get('body', '')) for i in (out or {}).get('items', []))
check('采集器→target: 唤醒', bool(out and out.get('wake')), str(out)[:120])
check('采集器→target: 源名渲染正确(不出现 None)',
      'mail' in txt and 'None' not in txt, txt[:140])
check('采集器→target: item id 用 key',
      bool(out and out['items'] and out['items'][0]['id'] == 'collector-failure:mail'),
      str([i.get('id') for i in (out or {}).get('items', [])]))

h = fresh('i2')
write_log(h, [CLEAN])
write_fact(h, 'mail', '2026-10-12.jsonl', int((NOW - 3 * 86400) * 1000))
rc, facts, _ = run_col(h, {'REFLEX_HEALTH_QUIET_FROM': '23:00', 'REFLEX_HEALTH_QUIET_TO': '23:30'})
rc2, out, _ = run_tgt(h, facts)
txt = ' '.join((i.get('title', '') + ' ' + i.get('body', '')) for i in (out or {}).get('items', []))
check('采集器→target: 静默事件的源名也正确',
      'mail' in txt and 'None' not in txt, txt[:140])

# recovered 事实里的源名同样不能是 None —— 它带着 source 进事实库, 供以后查账
rc, facts, _ = run_col(h, {'REFLEX_HEALTH_QUIET_FROM': '23:00', 'REFLEX_HEALTH_QUIET_TO': '23:30',
                           'REFLEX_HEALTH_STALE_MIN': 'mail=8000'})
rec = [f for f in facts if f['metric'] == 'recovered']
check('recovered 事实带正确的源名',
      bool(rec) and rec[0]['raw'].get('source') == 'mail', str(rec)[:140])

print('== target 判定 ==')
F_MAIL = {'metric': 'collector-failure', 'raw': {'source': 'mail', 'count': 3, 'windowMinutes': 60, 'lastError': 'boom'}, 'meta': {'key': 'collector-failure:mail'}}
F_GHOST = {'metric': 'source-silent', 'raw': {'source': 'ghost', 'silentActiveMinutes': 999, 'thresholdMinutes': 150, 'lastFactAt': '2026-10-01T00:00:00+08:00', 'silentWallMinutes': 9999}, 'meta': {'key': 'source-silent:ghost'}}
F_REC = {'metric': 'recovered', 'raw': {'problem': 'collector-failure:mail'}, 'meta': {'key': 'collector-failure:mail'}}


def with_state(name, problems):
    h = fresh(name)
    json.dump({'problems': problems}, open(os.path.join(h, 'reflex-health-state.json'), 'w'))
    return h


h = with_state('t1', {'collector-failure:mail': {'at': int(NOW * 1000)}})
rc, out, _ = run_tgt(h, [F_MAIL, F_GHOST, F_REC])
check('状态里只有 mail → 只报 mail 一条',
      out and out['wake'] and [i['id'] for i in out['items']] == ['collector-failure:mail'],
      json.dumps(out, ensure_ascii=False)[:120])

h = with_state('t2', {})
rc, out, _ = run_tgt(h, [F_MAIL, F_GHOST])
check('状态全干净 → 陈旧事实被压成 wake=false', out and out['wake'] is False, json.dumps(out)[:120])

# 阶梯提醒: 未修复的问题不能每 30 分钟叫一次 —— item id 只在 1h/6h/24h/72h 台阶上变化
def state_at_age(name, age_min):
    d = os.path.join(BASE, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)
    at = int((NOW - age_min * 60) * 1000)
    json.dump({'problems': {'collector-failure:mail': {'at': at}}},
              open(os.path.join(d, 'reflex-health-state.json'), 'w'))
    return d

for age, want in ((5, 'collector-failure:mail'), (47, 'collector-failure:mail'),
                  (90, 'collector-failure:mail'),                 # 数据源类: 6h 才起第一个台阶
                  (7 * 60, 'collector-failure:mail#6h'),
                  (30 * 60, 'collector-failure:mail#24h')):
    h = state_at_age(f'esc{age}', age)
    rc, out, _ = run_tgt(h, [F_MAIL])
    got = (out or {}).get('items', [{}])[0].get('id')
    check(f'阶梯提醒(数据源): 已持续 {age} 分钟 → id={want}', got == want, f'got={got}')

# 基础设施类要快: "reflex 叫不醒 L2" 1 小时就该再提醒 —— 整条链断了，不是少一路信息
def state_wake_failed(name, age_min):
    d = os.path.join(BASE, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)
    at = int((NOW - age_min * 60) * 1000)
    json.dump({'problems': {'wake-failed:-': {'at': at}}},
              open(os.path.join(d, 'reflex-health-state.json'), 'w'))
    return d

F_WAKE = {'metric': 'wake-failed', 'raw': {'count': 2, 'windowMinutes': 60, 'lastError': 'sessionController unavailable'}, 'meta': {'key': 'wake-failed:-'}}
for age, want in ((10, 'wake-failed:-'), (70, 'wake-failed:-#1h'), (200, 'wake-failed:-#3h')):
    h = state_wake_failed(f'infra{age}', age)
    rc, out, _ = run_tgt(h, [F_WAKE])
    got = (out or {}).get('items', [{}])[0].get('id')
    check(f'阶梯提醒(基础设施): 已持续 {age} 分钟 → id={want}', got == want, f'got={got}')

# 节流: 插件的"过冷却期重新关注"规则不看指纹, 所以同一个未修复的问题会被每 30 分钟叫一次
# (2026-10-16 凌晨 02:11/02:49/03:22 实测)。拦住它的只能是 target 自己的台账 —— 同一台阶只报一次。
h = state_at_age('throttle', 30)
rc, o1, _ = run_tgt(h, [F_MAIL])
rc, o2, _ = run_tgt(h, [F_MAIL])
rc, o3, _ = run_tgt(h, [F_MAIL])
check('提醒节流: 首次报, 之后同一台阶不重复打扰',
      bool(o1 and o1['wake']) and bool(o2 and o2['wake'] is False) and bool(o3 and o3['wake'] is False),
      f"{bool(o1 and o1['wake'])}/{bool(o2 and o2['wake'])}/{bool(o3 and o3['wake'])}")

# 反例: 台账不能让"恢复了又复发"的问题被永久静音
os.remove(os.path.join(h, 'reflex-health-target-state.json'))
rc, o5, _ = run_tgt(h, [F_MAIL])                     # 台账已清 → 该报
check('提醒节流: 台账清掉后仍会报(不会被永久静音)', bool(o5 and o5['wake']), str(o5)[:100])

h = fresh('t3')          # 无状态文件
rc, out, _ = run_tgt(h, [F_MAIL, F_GHOST])
check('状态缺失 → 退化为只信事实(不漏报)', out and out['wake'] and len(out['items']) == 2, json.dumps(out)[:120])

h = fresh('t4')
open(os.path.join(h, 'reflex-health-state.json'), 'w').write('not json{')
rc, out, _ = run_tgt(h, [F_MAIL])
check('状态损坏 → 同样退化, 不静默', out and out['wake'] is True, json.dumps(out)[:120])

h = with_state('t5', {})
rc, out, _ = run_tgt(h, [F_REC])
check('只有 recovered → wake=false', out and out['wake'] is False, json.dumps(out)[:120])

rc, out, _ = run_tgt(h, [])
check('空 stdin → wake=false, 退出码 0', rc == 0 and out and out['wake'] is False, f'rc={rc}')

h = with_state('t6', {'crash-loop:-': {'at': int(NOW * 1000)}})
F_CRASH = {'metric': 'crash-loop', 'raw': {'reloads': 25, 'windowMinutes': 60, 'firstAt': 'x', 'lastAt': 'y'}, 'meta': {'key': 'crash-loop:-'}}
rc, out, _ = run_tgt(h, [F_CRASH])
body = out['items'][0]['body'] if out and out.get('items') else ''
check('crash-loop 条目正文带排查线索', out['wake'] and 'dsh-reflex.log' in body, body[:80])

# 同一批里同一 key 出现两次: 只能报一条, 且用【最新】那条的时间窗。
# 2026-10-16 11:26 真实踩到: 批次里躺着凌晨那次 x-timeline 失败 + 刚才那次的,
# 结果唤醒消息报成 01:06→01:25, 真实窗口是 10:55→11:25 —— 报旧窗口会把人引到已经
# 恢复的那次故障上。(根因是游标把历史重投, 已在 index.js 修掉; 这里是第二道防线。)
F_X_OLD = {'metric': 'collector-failure',
           'raw': {'source': 'x-timeline', 'count': 2, 'windowMinutes': 60,
                   'firstAt': '2026-10-16T01:06:24+08:00', 'lastAt': '2026-10-16T01:25:28+08:00',
                   'lastError': 'boom'},
           'meta': {'key': 'collector-failure:x-timeline'}}
F_X_NEW = {'metric': 'collector-failure',
           'raw': {'source': 'x-timeline', 'count': 2, 'windowMinutes': 60,
                   'firstAt': '2026-10-16T10:55:28+08:00', 'lastAt': '2026-10-16T11:25:28+08:00',
                   'lastError': 'boom'},
           'meta': {'key': 'collector-failure:x-timeline'}}
h = with_state('t7', {'collector-failure:x-timeline': {'at': int(NOW * 1000)}})
rc, out, _ = run_tgt(h, [F_X_OLD, F_X_NEW])
items = out.get('items') or []
check('同一 key 一批两次 → 只报一条', len(items) == 1, f'n={len(items)}: {json.dumps(items)[:120]}')
check('报的是最新那条的时间窗',
      bool(items) and '10:55:28' in items[0]['body'] and '01:06:24' not in items[0]['body'],
      (items[0]['body'] if items else '')[:160])

# ================= ASG 失败分类学 (2026-10-24, arXiv:2610.31461 §4.6) =================
# 采集器给问题打 failureClass(五类), target 条目带分类行; executor-exception 升 infra 台阶。

print('== ASG 失败分类 ==')

# 语料驱动: 真实 lastError/stderr 组合 → 期望类。规则改动必须同步这里。
h = fresh('cls1')
os.makedirs(os.path.join(h, 'collectors'), exist_ok=True)
for _s in ('x-timeline', 'finnhub'):
    open(os.path.join(h, 'collectors', _s + '.sh'), 'w').write('#!/bin/bash\n')
write_log(h, [
    # x-timeline: 包装层错误 + stderr 详情(打不开 feed = 网络/超时) → executor-exception
    FAIL('x-timeline', 'Command failed: /bin/bash x.sh', off=-600),
    'x-timeline: 打不开 feed (exit=1, 用了 28s, 当前负载 8.86)',
    FAIL('x-timeline', 'Command failed: /bin/bash x.sh', off=-540),
    FAIL('x-timeline', 'Command failed: /bin/bash x.sh', off=-480),
    # mail: 登录态缺失 → precondition-mismatch
    FAIL('mail', 'Command failed: /bin/bash m.sh', off=-500),
    'mail: login state missing: /path/state.json',
    FAIL('mail', 'Command failed: /bin/bash m.sh', off=-480),
    FAIL('mail', 'Command failed: /bin/bash m.sh', off=-460),
    # disk: EAGAIN → executor-exception (lastError 直接可见)
    FAIL('disk', 'spawn df EAGAIN', off=-600),
    FAIL('disk', 'spawn df EAGAIN', off=-580),
    FAIL('disk', 'spawn df EAGAIN', off=-560),
    # finnhub: 缺 API key → precondition-mismatch
    FAIL('finnhub', 'finnhub API key missing', off=-600),
    FAIL('finnhub', 'finnhub API key missing', off=-580),
    FAIL('finnhub', 'finnhub API key missing', off=-560),
])
rc, facts, _ = run_col(h)
fc = {f['meta']['key']: (f['raw'] or {}).get('failureClass') for f in facts
      if (f.get('raw') or {}).get('failureClass')}
check('分类: 打不开 feed → executor-exception', fc.get('collector-failure:x-timeline') == 'executor-exception', str(fc))
check('分类: login state missing → precondition-mismatch', fc.get('collector-failure:mail') == 'precondition-mismatch', str(fc))
check('分类: EAGAIN → executor-exception', fc.get('collector-failure:disk') == 'executor-exception', str(fc))
check('分类: API key missing → precondition-mismatch', fc.get('collector-failure:finnhub') == 'precondition-mismatch', str(fc))

# 未知根因(只有包装层) → 不猜, 不带 failureClass
h = fresh('cls2')
write_log(h, [FAIL('arxiv', 'Command failed: /bin/bash a.sh', off=-600),
              FAIL('arxiv', 'Command failed: /bin/bash a.sh', off=-540),
              FAIL('arxiv', 'Command failed: /bin/bash a.sh', off=-480)])
rc, facts, _ = run_col(h)
has_fc = any((f.get('raw') or {}).get('failureClass') for f in facts if f['metric'] == 'collector-failure')
check('分类: 无详情的包装层错误 → 不猜(无 failureClass)', not has_fc, json.dumps(facts)[:160])

# target 兼容: 带 failureClass 的条目显示分类行; 不带的照常渲染(向后兼容反例)
F_FC = {'metric': 'collector-failure',
        'raw': {'source': 'mail', 'count': 3, 'windowMinutes': 60,
                'firstAt': '2026-10-24T09:00:00+08:00', 'lastAt': '2026-10-24T09:20:00+08:00',
                'lastError': 'Command failed: m.sh', 'failureClass': 'precondition-mismatch'},
        'meta': {'key': 'collector-failure:mail'}}
h = fresh('cls3')
rc, out, _ = run_tgt(h, [F_FC])
body = out['items'][0]['body'] if out and out.get('items') else ''
check('target: 带 failureClass → 条目含分类行',
      out['wake'] and 'precondition-mismatch' in body and '前置条件不满足' in body, body[:120])

F_NOFC = {'metric': 'collector-failure',
          'raw': {'source': 'mail', 'count': 3, 'windowMinutes': 60,
                  'firstAt': '2026-10-24T09:00:00+08:00', 'lastAt': '2026-10-24T09:20:00+08:00',
                  'lastError': 'boom'},
          'meta': {'key': 'collector-failure:mail'}}
h = fresh('cls4')
rc, out, _ = run_tgt(h, [F_NOFC])
body = (out.get('items') or [{}])[0].get('body', '') if out else ''
check('target: 缺 failureClass → 照常渲染无分类行(兼容反例)',
      out is not None and out.get('wake') and '分类:' not in body, body[:120])

# executor-exception 的采集失败升 infra 台阶(1h/3h/6h/12h)而非 source(6h/24h/72h/168h)
F_EG = dict(F_NOFC)
F_EG = {'metric': 'collector-failure',
        'raw': {'source': 'uptime', 'count': 5, 'windowMinutes': 60,
                'firstAt': '2026-10-24T05:00:00+08:00', 'lastAt': '2026-10-24T09:30:00+08:00',
                'lastError': 'spawn /bin/bash EAGAIN', 'failureClass': 'executor-exception'},
        'meta': {'key': 'collector-failure:uptime'}}
# 台阶语义: age≥b 的最大 b。infra=(1,3,6,12)。4h → #3h; 且必须是 infra 组(否则会是 source 组的 #1h)。
h = with_state('cls5', {'collector-failure:uptime': {'at': int((NOW - 4 * 3600) * 1000)}})  # 持续 4h
rc, out, _ = run_tgt(h, [F_EG])
items = out.get('items') or []
check('分类: EAGAIN 采集失败按 infra 台阶(4h → #3h, 非 source 的 #1h)',
      bool(items) and any('#3h' in i['id'] for i in items), json.dumps(items)[:160])

# ================= 台账跨事故残留 bug (2026-10-24) =================
# 场景: 上次同类故障报过(step-0 台账) → 恢复(recovered) → 再次发生 →
#       第一次报告【不该】被旧台账吞掉。
h = fresh('ledger1')
json.dump({'collector-failure:x-timeline': 0},           # 上次事故残留的 step-0 台账
          open(os.path.join(h, 'reflex-health-target-state.json'), 'w'))
FX = {'metric': 'collector-failure',
      'raw': {'source': 'x-timeline', 'count': 1, 'windowMinutes': 60, 'lastError': 'boom'},
      'meta': {'key': 'collector-failure:x-timeline'}}
rc, o1, _ = run_tgt(h, [FX])                            # 第一次失败(1 次 < 2 不报)
h = fresh('ledger2')
json.dump({'collector-failure:x-timeline': 0},
          open(os.path.join(h, 'reflex-health-target-state.json'), 'w'))
REC = {'metric': 'recovered', 'raw': {'problem': 'collector-failure:x-timeline',
                                      'kind': 'collector-failure', 'source': 'x-timeline'},
       'meta': {'key': 'collector-failure:x-timeline', 'check': 'recovery'}}
rc, o2, _ = run_tgt(h, [REC])                            # 恢复 → 台账应清零(wake=false)
led = json.load(open(os.path.join(h, 'reflex-health-target-state.json')))
check('ledger: recovered 清台账', led == {} or 'collector-failure:x-timeline' not in led, str(led))
rc, o3, _ = run_tgt(h, [FX, FX])                         # 再次发生 → 台账已清 → 该报
check('ledger: 清零后新事故正常报',
      bool(o3 and o3['wake']) and bool(o3.get('items')),
      str(o3)[:120])

print('== 采集器: 判定失败连续窗口升级 (2026-10-24 ai-policy 每小时1次x10h 隐身事故) ==')
# 事故形态: 同源每小时 1 次 decision-failure, 60 分钟窗口内永远只有 1 次,
# FAIL_MIN=2 的速率判据数学上永不触发 → 需要"连续 N 窗口"状态升级机制。
DFL = lambda off=-120, src='ai-policy': (
    f'[{iso(off)}] L1[{src}] error: exit 1: '
    f'{src}: SemIf 打分脚本不存在: /x/scripts/scripts/shadow-semif.sh')
ST3 = {'REFLEX_HEALTH_DECIDE_STREAK': '3'}

h = fresh('d1')
os.makedirs(os.path.join(h, 'collectors'), exist_ok=True)   # 源存在才报(防已删源刷屏守卫)
open(os.path.join(h, 'collectors', 'ai-policy.sh'), 'w').write('#!/bin/bash\n')
write_log(h, [DFL()])
rc, facts, _ = run_col(h, ST3)
check('streak: 连续第 1 窗 → 不报', not facts, str([f['meta']['key'] for f in facts]))
write_log(h, [DFL()])
rc, facts, _ = run_col(h, ST3)
check('streak: 连续第 2 窗 → 不报', not facts, str([f['meta']['key'] for f in facts]))
write_log(h, [DFL()])
rc, facts, _ = run_col(h, ST3)
keys = sorted(f['meta']['key'] for f in facts)
check('streak: 连续第 3 窗 → 升级报 decision-failure',
      keys == ['decision-failure:ai-policy'], str(keys))
write_log(h, [CLEAN])
rc, facts, _ = run_col(h, ST3)
check('streak: 恢复 → recovered 事实',
      any(f['metric'] == 'recovered' and f['raw'].get('problem') == 'decision-failure:ai-policy'
          for f in facts), str([(f['metric'], f['raw'].get('problem')) for f in facts]))
write_log(h, [DFL()])
rc, facts, _ = run_col(h, ST3)
write_log(h, [DFL()])
rc, facts, _ = run_col(h, ST3)
check('streak: 恢复后重新累计, 连续 2 窗仍不报', not facts,
      str([f['meta']['key'] for f in facts]))
write_log(h, [DFL()])
rc, facts, _ = run_col(h, ST3)
keys = sorted(f['meta']['key'] for f in facts)
check('streak: 重置后再满 3 窗 → 再报', keys == ['decision-failure:ai-policy'], str(keys))

print('== 2026-10-26: 构建饱和期的采集失败不叫醒 ==')


def sat_home(name, load5=52, cores=12, build=30):
    h = fresh(name)
    os.makedirs(os.path.join(h, 'facts', 'cpu-top'), exist_ok=True)
    with open(os.path.join(h, 'facts', 'cpu-top', '2026-10-26.jsonl'), 'w') as fh:
        fh.write(json.dumps({'ts': int(NOW * 1000), 'metric': 'load',
                             'raw': {'load1': 60, 'load5': load5, 'load15': 40,
                                     'cores': cores, 'buildProcs': build, 'top': []}}) + '\n')
    return h


def cf_fact(src='global-risk', fc='executor-exception'):
    return {'metric': 'collector-failure',
            'raw': {'kind': 'collector-failure', 'source': src, 'count': 2, 'windowMinutes': 60,
                    'firstAt': iso(-1200), 'lastAt': iso(-60), 'lastError': 'Command failed',
                    'failureClass': fc},
            'meta': {'key': f'collector-failure:{src}', 'check': 'log-scan', 'window': '60m'}}


def wf_fact():
    return {'metric': 'wake-failed',
            'raw': {'kind': 'wake-failed', 'count': 2, 'windowMinutes': 5,
                    'firstAt': iso(-300), 'lastAt': iso(-60), 'lastError': 'L2 wake failed'},
            'meta': {'key': 'wake-failed:-', 'check': 'log-scan', 'window': '5m'}}


h = sat_home('sat-fail')
rc, out, _ = run_tgt(h, [cf_fact()])
check('构建饱和(load5 52/12核, 30 个 clang)期采集失败 → 不叫醒',
      bool(out and out.get('wake') is False), str(out)[:150])
check('抑制在 reason 里留痕', bool(out and '构建饱和期跳过' in (out.get('reason') or '')), str(out)[:150])

h = sat_home('sat-wakefail')
rc, out, _ = run_tgt(h, [wf_fact()])
check('构建饱和期「叫不醒 L2」→ 照报(整条链断了, 不抑制)',
      bool(out and out.get('wake')), str(out)[:150])

h = sat_home('sat-class')
rc, out, _ = run_tgt(h, [cf_fact(src='mail', fc='precondition-mismatch')])
check('构建饱和期但失败类不是执行环境异常 → 照报',
      bool(out and out.get('wake')), str(out)[:150])

h = sat_home('idle-fail', load5=8, cores=12, build=0)
rc, out, _ = run_tgt(h, [cf_fact()])
check('非构建期采集失败 → 照报(抑制不外溢)',
      bool(out and out.get('wake')), str(out)[:150])

h = sat_home('load-only', load5=52, cores=12, build=0)
rc, out, _ = run_tgt(h, [cf_fact()])
check('高负载但没有编译进程 → 照报(只豁免真在编译)',
      bool(out and out.get('wake')), str(out)[:150])

h = sat_home('sat-off')
rc, out, _ = run_tgt(h, [cf_fact()], {'REFLEX_HEALTH_BUILD_LOAD_X': '0'})
check('抑制可关(REFLEX_HEALTH_BUILD_LOAD_X=0) → 照报',
      bool(out and out.get('wake')), str(out)[:150])

print()
bad = [r for r in results if not r[1]]
print(f"总计 {len(results)} 项, 通过 {len(results) - len(bad)}, 失败 {len(bad)}")
sys.exit(1 if bad else 0)
