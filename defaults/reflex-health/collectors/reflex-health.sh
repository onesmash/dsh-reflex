#!/bin/bash
# 数据源: reflex-health — 盯住 reflex 自己: 谁静默了、谁报错了、唤醒通道还通不通
#
# 为什么需要: 2026-10-15 mail 源静默了 9 个工作小时才被用户问出来。采集器退出码是 0
#   (它"成功地"什么都没采到), 插件不报错, 不问就永远发现不了。
#   看门狗也得有人看。本脚本只做确定性规则, 不走 SemIf —— 健康判定没有语义歧义。
#
# 检查项 (只在异常时产出 fact, 一切正常时零输出):
#   collector-failure  日志里 "L0 <src> failed" (聚合窗口内 >= REFLEX_HEALTH_FAIL_MIN 次)
#   decision-failure   日志里 "L1[<src>] error" (SemIf/适配层打不了分)
#   wake-failed        日志里 "L2 wake failed" (叫不到 L2 —— 整条链的终点断了; 阈值 1)
#   crash-loop         窗口内插件重载 >= REFLEX_HEALTH_RELOAD_LIMIT 次
#   source-silent      该冒泡的源在工作时段安静超过阈值(见下表)
#   recovered          上面某一项恢复 (只记录事实, target 不会为此唤醒)
#
# 判据来源 (2026-10-15 实测工作时段间隔, 单位分钟):
#   disk/swap max 18.7 | x-timeline max 109 | zoom-im max 131 | mail max 540 (就是那次故障)
#   阈值取观测最大值约 2 倍留头寸。不合口味用 env 覆盖:
#   REFLEX_HEALTH_STALE_MIN="mail=90,zoom-im=240"  (只覆盖列出来的源)
#   重载风暴阈值 20 次/小时: 开发时段改文件触发的正常重载实测 11~63 次/小时,
#   真正的崩溃循环是 160+ 次/小时 —— 阈值压在中间会把正常开发当成故障。
#
# 幂等: state 文件记住"已经报过的", 同一问题只报一次, 恢复了才允许再报
# 自保: 顶层 try/except 吞异常并 exit 0 —— 自检脚本自己报错会变成自我放大的报警回环
#
# ⚠️ 契约(改错会让对端静默失效): reflex-health-state.json 的 problems 键集合 =
#   "当前还没恢复的问题"。targets/reflex-health.sh 直接读它过滤条目 —— 因为插件的游标是
#   粗粒度的(一轮只推进一个源), 同一批事实会被反复重读, 只信事实的话早已恢复的旧问题会被
#   一直带进后续每一次唤醒。动这个文件的结构, 必须同步改 target。

set -uo pipefail

python3 - <<'PY'
import json, os, re, sys, time, subprocess, datetime as dt

try:
    HOME_DIR = os.environ.get('REFLEX_HOME') or os.path.expanduser('~/.dsh/dsh-reflex')
    LOG   = os.path.join(HOME_DIR, 'dsh-reflex.log')
    STATE = os.path.join(HOME_DIR, 'reflex-health-state.json')
    now = int(time.time() * 1000)

    # 重启后不要把【重启前】的失败当成"当前故障"回放: 2026-10-19 13:14 实测 —— 重启前
    # fork 打满那批旧失败(11:57-12:51)在重启后被 60 分钟窗口重新扫到, 一次报了 13 项。
    # 用 kern.boottime 把窗口左边界抬到本次启动时间; REFLEX_HEALTH_BOOT_MS 可覆盖
    # (=0 关闭过滤, 回归测试用固定值)。
    _boot_env = os.environ.get('REFLEX_HEALTH_BOOT_MS')
    if _boot_env is not None:
        BOOT_MS = int(_boot_env)
    else:
        try:
            _o = subprocess.run(['sysctl', '-n', 'kern.boottime'], capture_output=True, text=True, timeout=5).stdout
            _m = re.search(r'sec = (\d+)', _o)
            BOOT_MS = int(_m.group(1)) * 1000 if _m else 0
        except Exception:
            BOOT_MS = 0

    WIN_MIN      = int(os.environ.get('REFLEX_HEALTH_WINDOW_MIN', '60'))
    WIN_MS       = WIN_MIN * 60000
    FAIL_MIN     = int(os.environ.get('REFLEX_HEALTH_FAIL_MIN', '2'))
    # 同一次故障可能被重复执行两遍(采集循环重叠时同一源 1~2 秒内跑两次), 日志里
    # 就是两条 "L0 <src> failed"。把几秒内的重复算成"2 次独立失败"会误报: 2026-10-19
    # 09:43 global-risk 就是 DNS 抖动 + 两次运行相隔 1.9s, 被当成 2 次失败误唤醒 L2。
    # 30s 内同一源的重复失败只算 1 次(合法失败的最小间隔 = 源节拍, 最短 60s)。
    FAIL_DEDUPE_MS = int(float(os.environ.get('REFLEX_HEALTH_FAIL_DEDUPE_SEC', '30')) * 1000)
    # 投递失败单独用 1: 每一次都是"这条告警没了", 不是抖动。
    # 2026-10-15 20:55 就单发过一次(sessionController unavailable), 阈值 2 会放它过去。
    WAKE_FAIL_MIN = int(os.environ.get('REFLEX_HEALTH_WAKE_FAIL_MIN', '1'))
    RELOAD_LIMIT = int(os.environ.get('REFLEX_HEALTH_RELOAD_LIMIT', '20'))

    # 该冒泡的源 → 工作时段静默阈值(分钟)。事件型源(zoom-channel/jira-my-tasks)不进表:
    # 它们本来就长时间没消息, 报静默等于天天误报。
    #
    # 阈值的含义是「这个源能合法地安静多久」, 所以必须覆盖活跃时段里最长的一次合理安静 ——
    # 包括晚间。教训(2026-10-15 深夜实测): mail 定 150 分钟是按白天频率校准的, 而晚上
    # 21:28 之后没人发邮件是常态 → 00:00 整点在 150.9 分钟时误报了一次「数据源静默」。
    # 活跃时段被拉长到 24:00 之后, 阈值必须跟着放宽。
    # 默认只含内置源+mail; 个人源的阈值用 REFLEX_HEALTH_STALE_MIN="src=min" 覆盖
    # (包内版本不预设使用者机器上的源名 —— 2026-10-24 收编进插件时泛化)
    STALE = {'disk': 60, 'swap': 60, 'mail': 240}
    for part in (os.environ.get('REFLEX_HEALTH_STALE_MIN') or '').split(','):
        if '=' in part:
            k, v = part.split('=', 1)
            try:
                STALE[k.strip()] = int(v)
            except ValueError:
                pass

    # ---------- 安静时段 (与插件 l1.quietHours 同源, 读不到就用默认) ----------
    def quiet_hours():
        qf, qt = '18:00', '09:00'
        import glob
        for p in sorted(glob.glob(os.path.expanduser('~/.dsh/profiles/*/cordis.patch.yml'))):
            try:
                txt = open(p, encoding='utf-8').read()
            except Exception:
                continue
            if 'dsh-reflex' not in txt:
                continue
            m = re.search(r'quietHours:\s*\n\s*from:\s*"?([\d:]{4,5})"?\s*\n\s*to:\s*"?([\d:]{4,5})"?', txt)
            if m:
                return m.group(1), m.group(2)
        return qf, qt

    def hhmm(s, default):
        try:
            h, m = str(s).split(':')[:2]
            return dt.time(int(h), int(m))
        except Exception:
            return default

    QF, QT = quiet_hours()
    QF = hhmm(os.environ.get('REFLEX_HEALTH_QUIET_FROM') or QF, dt.time(18, 0))
    QT = hhmm(os.environ.get('REFLEX_HEALTH_QUIET_TO') or QT, dt.time(9, 0))

    def is_quiet(ms):
        t = dt.datetime.fromtimestamp(ms / 1000).time()
        return (t >= QF or t < QT) if QF > QT else (QF <= t < QT)

    def active_seconds(a_ms, b_ms):
        """[a,b] 内落在工作时段(安静时段之外)的秒数 —— 夜里不算数, 否则每天早上一片误报"""
        A = dt.datetime.fromtimestamp(a_ms / 1000)
        B = dt.datetime.fromtimestamp(b_ms / 1000)
        if B <= A:
            return 0.0
        quiet = 0.0
        day = A.date() - dt.timedelta(days=1)
        while day <= B.date() + dt.timedelta(days=1):
            qs = dt.datetime.combine(day, QF)
            qe = dt.datetime.combine(day, QT)
            if QT <= QF:
                qe += dt.timedelta(days=1)
            s, e = max(qs, A), min(qe, B)
            if e > s:
                quiet += (e - s).total_seconds()
            day += dt.timedelta(days=1)
        return (B - A).total_seconds() - quiet

    # ---------- 读日志尾部 ----------
    def read_tail(path, maxbytes=400000):
        try:
            size = os.path.getsize(path)
            with open(path, 'rb') as f:
                if size > maxbytes:
                    f.seek(size - maxbytes)
                    data = f.read().decode('utf-8', 'ignore')
                    return data.splitlines()[1:]      # 首行可能是半截
                return f.read().decode('utf-8', 'ignore').splitlines()
        except Exception:
            return []

    TS_RE = re.compile(r'^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]\s?(.*)$')

    def parse_ts(s):
        for fmt in ('%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ'):
            try:
                return int(dt.datetime.strptime(s, fmt).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
            except Exception:
                pass
        return None

    def iso(ms):
        try:
            return dt.datetime.fromtimestamp(ms / 1000).astimezone().isoformat(timespec='seconds')
        except Exception:
            return None

    fails, dfails, wakes, reloads = {}, {}, [], []
    cut = now - WIN_MS
    if BOOT_MS and BOOT_MS > cut:
        cut = BOOT_MS
    raw_lines = read_tail(LOG)
    for line in raw_lines:
        m = TS_RE.match(line)
        if not m:
            continue
        ts = parse_ts(m.group(1))
        if ts is None or ts < cut:
            continue
        msg = m.group(2)

        mf = re.match(r'^L0 (\S+) failed: (.*)$', msg)
        if mf:
            d = fails.setdefault(mf.group(1), {'n': 0, 'first': ts, 'last': ts, 'err': '', 'lastCounted': 0})
            # 去抖: 同一源的重复执行(几秒内)不算独立失败
            if ts - d['lastCounted'] >= FAIL_DEDUPE_MS:
                d['n'] += 1
                d['lastCounted'] = ts
            d['first'] = min(d['first'], ts)
            d['last'] = max(d['last'], ts)
            d['err'] = mf.group(2)[:300]
            continue

        md = re.match(r'^L1\[([^\]]+)\] error: (.*)$', msg)
        if md:
            d = dfails.setdefault(md.group(1), {'n': 0, 'first': ts, 'last': ts, 'err': ''})
            d['n'] += 1
            d['first'] = min(d['first'], ts)
            d['last'] = max(d['last'], ts)
            d['err'] = md.group(2)[:300]
            continue

        mw = re.match(r'^L2 wake failed:?\s*(.*)$', msg)
        if mw:
            wakes.append({'ts': ts, 'err': (mw.group(1) or '').strip()[:200]})
            continue

        if re.match(r'^(dsh-reflex|layered-agent) installed:', msg):
            reloads.append(ts)

    # ---------- 组装问题集合 ----------
    problems = {}

    # 源已被删除(用户移除数据源)时, 它的历史失败不该继续报 —— 日志扫描窗口是 60 分钟,
    # 删源后这 60 分钟里每轮都会重复报"采集失败", 全是噪音 (2026-10-17 etrade-plan 实测)。
    BUILTIN_SRCS = {'disk', 'mail', 'swap'}

    def source_exists(src):
        return os.path.exists(os.path.join(HOME_DIR, 'collectors', src + '.sh')) or src in BUILTIN_SRCS

    def classify_failure(err):
        """lastError + stderr 详情 → ASG 失败类 (arXiv:2610.31461 §4.6)。
        规则顺序即优先级; 兜底 unknown —— 宁可不明, 不可误导排查。"""
        t = (err or '').lower()
        if not t:
            return 'unknown'
        if 'eagain' in t or 'resource temporarily unavailable' in t or 'fork' in t or 'table is full' in t:
            return 'executor-exception'
        if any(k in t for k in ('not parseable', '解析失败', '无输出', 'invalid json',
                                 'parse error', 'syntax error', '打分无输出')):
            return 'validation-failure'
        if any(k in t for k in ('schema', 'invalid argument', 'malformed', '参数错误')):
            return 'tool-schema-failure'
        if any(k in t for k in ('login state', 'not logged in', 'session expired', 'cookie',
                                 'api key', 'token', '凭据', '密钥', '未配置', '缺少',
                                 '401', '403')):
            return 'precondition-mismatch'
        if any(k in t for k in ('timeout', 'timed out', '不可达', 'urlerror', 'urlopen error',
                                 'unreachable', '网络', 'connection', 'dns', 'getaddrinfo',
                                 '打不开 feed')):
            return 'executor-exception'
        return 'unknown'

    # stderr 详情行: 采集器的自诊断输出不带时间戳, 但就落在 "L0 <src> failed" 行旁边
    # (lastError 只有 Node 包装层的 "Command failed: /bin/bash …"), 根因在这些行里。
    # 按 src 前缀归因(两种形态: "<src>: …" 与 target 的 "<src> target: …"), 每源最多 5 行。
    def collect_detail(raw_lines, srcs):
        detail = {}
        if not srcs:
            return detail
        prefixes = [(s, (s + ': ', s + ' target: ')) for s in srcs]
        for line in raw_lines:
            if TS_RE.match(line):
                continue
            for s, prefs in prefixes:
                for p in prefs:
                    if line.startswith(p) and len(detail.get(s, [])) < 5:
                        detail.setdefault(s, []).append(line[len(p):][:200])
        return detail

    def add_failure(kind, src, d):
        # ⚠️ 字段名是采集器与 target 的契约: target 读 raw['source'] 来写标题和采集器路径。
        #    2026-10-15 这里曾写 'subject', 于是通知显示成 "数据源静默 · None" + "collectors/None.sh"。
        #    回归测试没抓到, 因为测试喂给 target 的是手写事实 —— 手写的字段名和这里不一致。
        #    现在测试改成"跑采集器 → 把它真实的输出喂给 target"(见 tests/reflex-health-regress.py)。
        entry = {
            'kind': kind, 'source': src, 'count': d['n'], 'windowMinutes': WIN_MIN,
            'firstAt': iso(d['first']), 'lastAt': iso(d['last']), 'lastError': d['err'],
        }
        fc = classify_failure((d.get('err') or '') + ' ' + (d.get('detail') or ''))
        if fc != 'unknown':
            entry['failureClass'] = fc          # ASG 失败类; 缺失=unknown/legacy, target 向后兼容
        problems[f'{kind}:{src}'] = entry

    # stderr 详情归因到失败源 (classification 信号, 见 classify_failure)。
    # ⚠️ 必须在 classify_failure/collect_detail 定义之后调用 —— python 自上而下执行,
    #    放前面会 NameError 且被外层 except 静默吞掉(2026-10-24 实测, 回归测试抓的)。
    src_detail = collect_detail(raw_lines, set(fails) | set(dfails))
    for s2, d2 in src_detail.items():
        if s2 in fails:
            fails[s2]['detail'] = ' | '.join(d2)
        if s2 in dfails:
            dfails[s2]['detail'] = ' | '.join(d2)

    # 系统级故障(进程表/内存耗尽)会让所有源同时以同一个 EAGAIN 失败 —— 逐个报就是 13 条重复,
    # 而真正的信息只有一条: "系统已经无法 fork"。>=3 个源同时 EAGAIN 时合并成一条环境级问题,
    # 其余错误仍按源报。(2026-10-19 Xcode source control spawn 风暴实测: 13 个源同报。)
    EXHAUST_RE = re.compile(r'EAGAIN|Resource temporarily unavailable|fork:|table is full', re.I)
    EXHAUST_MIN = int(os.environ.get('REFLEX_HEALTH_EXHAUST_MIN', '3'))
    exhausted = {s: d for s, d in fails.items()
                 if d['n'] >= FAIL_MIN and source_exists(s) and EXHAUST_RE.search(d['err'] or '')}
    if len(exhausted) >= EXHAUST_MIN:
        problems['environment-failure:-'] = {
            'kind': 'environment-failure', 'source': None, 'count': len(exhausted),
            'failureClass': 'executor-exception',
            'windowMinutes': WIN_MIN,
            'firstAt': iso(min(d['first'] for d in exhausted.values())),
            'lastAt': iso(max(d['last'] for d in exhausted.values())),
            'lastError': next(iter(exhausted.values()))['err'],
            'sources': ', '.join(sorted(exhausted)),
        }
        for s in exhausted:
            fails.pop(s, None)
    for src, d in fails.items():
        if d['n'] >= FAIL_MIN and source_exists(src):
            add_failure('collector-failure', src, d)
    for src, d in dfails.items():
        if d['n'] >= FAIL_MIN and source_exists(src):
            add_failure('decision-failure', src, d)

    if len(wakes) >= WAKE_FAIL_MIN:
        problems['wake-failed:-'] = {
            'kind': 'wake-failed', 'subject': None, 'count': len(wakes), 'windowMinutes': WIN_MIN,
            'failureClass': 'executor-exception',
            'firstAt': iso(min(w['ts'] for w in wakes)), 'lastAt': iso(max(w['ts'] for w in wakes)),
            'lastError': wakes[-1]['err'],
        }

    if len(reloads) >= RELOAD_LIMIT:
        problems['crash-loop:-'] = {
            'kind': 'crash-loop', 'subject': None, 'reloads': len(reloads), 'windowMinutes': WIN_MIN,
            'failureClass': 'executor-exception',
            'firstAt': iso(min(reloads)), 'lastAt': iso(max(reloads)),
        }

    # ---------- 静默检查 (只在工作时段评, 夜里安静是正常的) ----------
    #
    # ⚠️ 事件型源不能只靠"静默多久"判定。它的"合法安静时长"没有上界 —— 就是没人发邮件。
    #    抬阈值只是把误报往后推: mail 定 150 分钟时误报过一次, 抬到 240 又误报了一次
    #    (2026-10-16 14:49 后整个下午没有新邮件, 18:55 阈值再次触发)。
    #    真正能区分"没消息"和"采集器坏了"的只有一次探活: 探活成功 = 源是好的, 只是安静;
    #    探活失败 = 真故障, 照报。探活只在超过阈值时跑一次, 成本可以忽略。
    def helper_call(args, timeout=60, attempts=2):
        """helper 调用 + 一次重试, 返回 (status, stdout)。
        status:
          'ok'      = 成功拿到输出
          'fail'    = helper 明确报错(非 0 退出, 如凭据失效/接口 4xx) → 源真的坏了, 该报
          'unknown' = 超时/起不来/网关不可达 → 不可判定, 不该据此报静默
        2026-10-17: 网络断时 devhelper 不可达, 探活超时被误当"源坏了", 反复报静默;
        真故障(采集器非 0 退出)会走"采集失败"路径, 静默只在明确坏掉时才报。"""
        helper = os.environ.get('REFLEX_HELPER') or os.path.expanduser('~/.local/bin/helper')
        last_fail = None
        for i in range(attempts):
            try:
                r = subprocess.run([helper] + args, capture_output=True, text=True, timeout=timeout)
                if r.returncode == 0:
                    return ('ok', r.stdout)
                last_fail = 'fail'
            except Exception:
                last_fail = 'unknown'
            if i + 1 < attempts:
                time.sleep(1.5)
        return (last_fail or 'unknown', '')

    def probe_mail():
        """True=源活着(只是没新邮件) / False=源坏了 / None=探不了(不改判)"""
        status, out = helper_call(['zoom', 'mail', 'zmail_list_emails',
                                   '--email', 'me', '--maxResults', '3', '--json'])
        if status == 'unknown':
            return None
        if status == 'fail':
            return False
        try:
            d = json.loads(out or '{}')
        except Exception:
            return None
        return bool((d or {}).get('messages'))

    def probe_zoom_im():
        """True=源活着(只是没新消息) / False=源坏了 / None=探不了(不改判)"""
        status, out = helper_call(['zoom', 'team_chat', 'team_chat_session_recent_list',
                                   '--page-size', '1', '--json'])
        if status == 'unknown':
            return None
        if status == 'fail':
            return False
        try:
            d = json.loads(out or '{}')
        except Exception:
            return None
        # 能拉到会话列表 => 通道活着。空列表也算活着(接口通, 只是没会话)。
        return d is not None and not d.get('error')

    PROBES = {'mail': probe_mail, 'zoom-im': probe_zoom_im}
    # 探活的开关。回归测试必须关掉: 否则测试结果取决于用户邮箱里此刻有没有信,
    # 而且会真的去调一次公司接口 —— 测试不能依赖外部世界。
    PROBE_ON = os.environ.get('REFLEX_HEALTH_PROBE', '1') != '0'

    def last_fact_ts(src):
        d = os.path.join(HOME_DIR, 'facts', src)
        if not os.path.isdir(d):
            return None
        for f in sorted(os.listdir(d), reverse=True):
            if not f.endswith('.jsonl'):
                continue
            try:
                with open(os.path.join(d, f), 'rb') as fh:
                    fh.seek(0, 2)
                    size = fh.tell()
                    fh.seek(max(0, size - 65536))
                    lines = [x for x in fh.read().decode('utf-8', 'ignore').splitlines() if x.strip()]
                if lines:
                    return json.loads(lines[-1]).get('ts')
            except Exception:
                continue
        return None

    if not is_quiet(now):
        for src, thr in STALE.items():
            # 该源被主动熔断(有 <src>.paused)时, 它的"静默"是我们自己按下的, 不算故障 ——
            # 否则一个已知故障会被"采集失败 + 数据源静默"两条路径重复报。
            if os.path.exists(os.path.join(HOME_DIR, f'{src}.paused')):
                continue
            # 同一根因只报一次: 该源在窗口内已有采集失败 → "静默"只是它的后果,
            # 不再单独报 (2026-10-17 VPN 断了 3 小时, x-timeline 同时被
            # "采集失败"和"数据源静默"报了两遍)。与上面 .paused 的哲学一致。
            if f'collector-failure:{src}' in problems:
                continue
            last = last_fact_ts(src)
            if not last:
                continue
            silent = active_seconds(last, now) / 60.0
            if silent > thr:
                # 事件型源先探活: 通了就说明只是没消息, 不是坏了 —— 不报。
                probe = PROBES.get(src) if PROBE_ON else None
                if probe is not None:
                    verdict = probe()
                    # True=活的(只是安静) → 不报; None=探不了(helper 网关不可达/超时) → 不报静默:
                    # 网络/凭据故障会以"采集失败"出现(采集器非 0 退出), 静默是弱信号,
                    # 反复拿探活超时去报静默会长出 "采集失败+静默" 两套噪音 (2026-10-17 实测)。
                    if verdict is not False:
                        continue
                problems[f'source-silent:{src}'] = {
                    'kind': 'source-silent', 'source': src,
                    'silentActiveMinutes': round(silent, 1), 'thresholdMinutes': thr,
                    'lastFactAt': iso(last), 'silentWallMinutes': round((now - last) / 60000.0, 1),
                }

    # ---------- 判定失败连续窗口升级 (2026-10-24 ai-policy 事故) ----------
    # 事故形态: 同源每小时 1 次 decision-failure, 60 分钟窗口内恒为 1 次,
    # FAIL_MIN 速率判据数学上永不触发 → 连续 STREAK_MIN 个窗口都出现同源
    # decision-failure 时, 即使 n<FAIL_MIN 也升级上报。某窗无该源失败即清零。
    STREAK_MIN = int(os.environ.get('REFLEX_HEALTH_DECIDE_STREAK', '3'))
    try:
        prev_state = json.load(open(STATE, encoding='utf-8')) or {}
    except Exception:
        prev_state = {}
    prev = prev_state.get('problems', {}) or {}
    _streak_prev = prev_state.get('dfailStreak', {}) or {}
    dfail_streak = {s: (_streak_prev.get(s) or 0) + 1 for s in dfails}
    for s, d in dfails.items():
        if d['n'] < FAIL_MIN and dfail_streak[s] >= STREAK_MIN \
                and f'decision-failure:{s}' not in problems and source_exists(s):
            add_failure('decision-failure', s, d)
            problems[f'decision-failure:{s}']['streakWindows'] = dfail_streak[s]

    # ---------- 与上轮对比: 只报新增, 恢复了报一条 recovered ----------

    out = []
    for key in sorted(problems):
        p = dict(problems[key])
        p['key'] = key
        if key in prev and prev[key].get('at'):
            p['at'] = prev[key]['at']
        else:
            p['at'] = now
        if key in prev:                       # 老问题: 只更新快照, 不再产出事实
            problems[key] = p
            continue
        problems[key] = p
        out.append({'metric': p['kind'],
                    'raw': {k: v for k, v in p.items() if k != 'kind'},
                    'meta': {'key': key, 'check': 'log-scan' if p['kind'] != 'source-silent' else 'fact-freshness',
                             'window': f'{WIN_MIN}m' if p['kind'] != 'source-silent' else None}})

    for key in sorted(set(prev) - set(problems)):
        old = prev[key]
        lasted = round((now - old.get('at', now)) / 60000.0, 1)
        out.append({'metric': 'recovered',
                    'raw': {'problem': key, 'kind': old.get('kind'),
                            'recoveredAt': iso(now),
                            # 同样用 source: 'subject' 只在修复前写下的旧记录里存在, 留作兼容
                            'source': old.get('source') or old.get('subject'),
                            'lastedMinutes': lasted, 'since': iso(old.get('at', now))},
                    'meta': {'key': key, 'check': 'recovery'}})

    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump({'problems': problems, 'dfailStreak': dfail_streak,
                       'lastRunAt': now, 'lastRunAtIso': iso(now)}, f, ensure_ascii=False)
    except Exception:
        pass                                   # 状态写不进去就少产出事实, 不能因此报错

    for o in out:
        print(json.dumps(o, ensure_ascii=False))
except Exception:
    pass                                       # 自保: 任何异常都静默退出, 见文件头
sys.exit(0)
PY
exit 0
