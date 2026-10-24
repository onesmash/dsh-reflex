#!/bin/bash
# L1 target 脚本: reflex-health —— reflex 自己出问题时叫醒 L2
#
# 职责分界 (脚本 target 契约): 本脚本只负责【判定 + 条目内容】;
#   去重/冷却/节流/累积合并/排版信封全部归插件 —— 所以这里不判重、不写标题栏/编号/L0 入口。
#
# stdin : 本轮新事实 (JSONL, 来自 collectors/reflex-health.sh)
# stdout: 一行 JSON 决策 {wake, reason, fingerprint, scanned, items}
#
# 只有"现在就是坏的"才唤醒: 采集失败 / 判定失败 / 叫不醒 L2 / 插件重载风暴 / 数据源静默。
# recovered 事实只记录、不唤醒 —— "它好了"对 L2 不是可行动信息(没活可干), 要查去 facts 里查。
# 这样定是有原因的: 摇摆在"坏了/好了"之间的源会把唤醒次数翻倍, 而噪音是这套系统最常见的死法。
#
# ⚠️ 别把 python 写成 `python3 - <<'PY'` —— heredoc 会顶掉 stdin, target 就读不到 facts 了。
#    必须先把脚本落到临时文件, 再用 cat 吃 stdin, 最后 python3 <文件> <facts>。
#
# ⚠️ 本 target 必须让 minIntervalMs = 0 (见同目录 .env.json) —— 这不是随手填的:
#    设了限流, 命中项就会在冷却期里被攒进插件的 pending 队列, 而 pending 只按内容指纹合并、
#    **不看采集器的状态文件**。于是问题已经恢复(target 判 wake=false)、那条旧条目仍会每分钟被
#    merge 回来, 冷却期一过就被当"新事"重发一遍 —— 2026-10-16 00:31 就这样把 23:59 的
#    mail 静默误报又发了一次(内容还是修复前的阈值 150)。
#    设 0 后没有 pending 这条路, 判定完全由状态文件说了算; 重复打扰仍由插件的
#    cooldownMs(默认 30 分钟)+ 内容指纹兜着, 频率不变。

set -uo pipefail

export LHOME="${REFLEX_HOME:-$HOME/.dsh/dsh-reflex}"

WORK=$(mktemp -d -t rh-target) || exit 1
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/decide.py" <<'PY'
import json, os, sys, time

LHOME = os.environ.get('LHOME') or os.path.expanduser('~/.dsh/dsh-reflex')

# 提醒台阶(小时) —— 按问题类别分两套, 见下面节流处的说明
STEP_HOURS = {'infra': (1, 3, 6, 12), 'source': (6, 24, 72, 168)}

KIND_CN = {
    'collector-failure': '采集失败',
    'decision-failure': '判定失败',
    'wake-failed': '叫不醒 L2',
    'crash-loop': '插件反复重载',
    'source-silent': '数据源静默',
    'environment-failure': '系统无法创建进程',
}

# ASG 失败分类 (arXiv:2610.31461 §4.6) → 中文 + 一句话处置。
# 采集器 2026-10-24 起在 problems 里带 failureClass; 缺失=legacy, 不显示分类行。
CLASS_HINT = {
    'precondition-mismatch': ('前置条件不满足', '配置/凭据/登录态问题, 修复后手工重跑(带去重窗口的源注意 seen 窗口)'),
    'executor-exception': ('执行环境异常', '资源/网络/超时, 先看负载与网络(高峰期 EAGAIN 风暴是已知形态)'),
    'validation-failure': ('产出校验失败', '上游格式或脚本解析问题, 查格式变化'),
    'tool-schema-failure': ('参数/契约错误', '查配置字段与 schema'),
    'partial-side-effect': ('部分产出后失败', 'seen 窗口已推进, 下轮可能漏数据(需采集器自报, 尚未上线)'),
    'output-gap': ('有运行无产出', '退出码正常但零数据, 查上游是否改版'),
}

# 存量以采集器的状态文件为准。为什么不能只信本轮事实:
#   插件的游标是粗粒度的(一轮只推进一个源), 同一批事实会被反复重读 ——
#   只信事实的话, 早就恢复的旧问题会被一直带进后续每一次唤醒, 越滚越多。
#   状态文件是"当前还有哪些问题"的单一事实来源(跨源 target 的既定模式)。
#   读不到状态时退化为"只信事实": 宁可多报, 也不能把告警静默掉。
STATE = os.path.join(LHOME, 'reflex-health-state.json')
active, active_at = None, {}
try:
    with open(STATE, encoding='utf-8') as fh:
        _probs = json.load(fh).get('problems') or {}
    active = set(_probs.keys())
    active_at = {k: (v or {}).get('at') for k, v in _probs.items()}   # 首次报告时间, 用于阶梯提醒
except Exception:
    active = None

# 本 target 自己的提醒台账: {问题 key: 已经报到第几个台阶}。与采集器的状态文件分开 ——
# 采集器每轮会重写它那份(只保留 at), 往里面塞字段会被冲掉。
TSTATE = os.path.join(LHOME, 'reflex-health-target-state.json')
try:
    reported = json.load(open(TSTATE, encoding='utf-8'))
except Exception:
    reported = {}
pending_reports = dict(reported)
ledger_dirty = False

facts = []
with open(sys.argv[1], encoding='utf-8') as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            f = json.loads(line)
        except Exception:
            continue
        if isinstance(f, dict):
            facts.append(f)


def key_of(f):
    meta = f.get('meta') or {}
    raw = f.get('raw') or {}
    return meta.get('key') or f"{f.get('metric')}:{raw.get('source') or '-'}"


def describe(f):
    """→ (标题, 正文); 非问题类返回 None"""
    metric = f.get('metric')
    raw = f.get('raw') or {}
    if metric not in KIND_CN:
        return None
    cn = KIND_CN[metric]
    # 采集器写 'source'; 老的 'subject' 兜底 —— 免得字段名再对不上时通知里显示成 None
    src = raw.get('source') or raw.get('subject')
    win = raw.get('windowMinutes')
    body = []

    if metric == 'collector-failure':
        title = f"{cn} · {src} · {win} 分钟内 {raw.get('count')} 次"
        body += [f"采集器: {LHOME}/collectors/{src}.sh",
                 f"最后错误: {raw.get('lastError') or '(无)'}",
                 f"时间: {raw.get('firstAt')} → {raw.get('lastAt')}"]
        body.append("排查: 日志里搜 `L0 %s failed` 看完整报错。手工重跑前先确认该源有没有状态 —— "
                    "带去重窗口的源(如 mail)手工跑会烧掉本轮窗口。" % src)

    elif metric == 'decision-failure':
        title = f"{cn} · L1[{src}] · {win} 分钟内 {raw.get('count')} 次"
        body += [f"最后错误: {raw.get('lastError') or '(无)'}",
                 f"时间: {raw.get('firstAt')} → {raw.get('lastAt')}"]
        body.append("这条源正在被采集, 但 L1 打不了分 —— 它的事实等于没进判断环节。"
                    "常见原因: SemIf/适配层不可用、决策后端缺 key、模型文件被删。")

    elif metric == 'wake-failed':
        title = f"{cn} · {win} 分钟内 {raw.get('count')} 次"
        body += [f"最后错误: {raw.get('lastError') or '(无)'}",
                 f"时间: {raw.get('firstAt')} → {raw.get('lastAt')}"]
        body.append("reflex 判定该叫醒 L2, 但消息送不进来 —— 整条链的终点断了, 期间所有判定都是白判。"
                    "查 sessionController 是否可用、DSH 是否刚重启过。")

    elif metric == 'crash-loop':
        title = f"{cn} · {win} 分钟内 {raw.get('reloads')} 次"
        body += [f"时间: {raw.get('firstAt')} → {raw.get('lastAt')}"]
        body.append("插件在反复重新加载。上一次这个量级(一小时 160+ 次)是声明了 dsh.client 却没导出 "
                    "./client bundle, 宿主启动即崩。看 dsh-reflex.log 的启动段。")

    elif metric == 'source-silent':
        title = (f"{cn} · {src} · 工作时段已 {raw.get('silentActiveMinutes')} 分钟没有数据"
                 f" (阈值 {raw.get('thresholdMinutes')})")
        body += [f"最近一条事实: {raw.get('lastFactAt')} (墙上时钟 {raw.get('silentWallMinutes')} 分钟前)",
                 f"采集器: {LHOME}/collectors/{src}.sh"]
        body.append("常见原因: 凭据/cookie 过期、上游接口改了、或采集器退出码 0 但什么都没采到"
                    " —— 最后一次见到就是这个样子(mail 静默 9 个工作小时, 退出码却是 0)。")
    elif metric == 'environment-failure':
        title = f"{cn} · {win} 分钟内 {raw.get('count')} 个源同时失败"
        body += [f"受影响: {raw.get('sources') or '(未记录)'}",
                 f"最后错误: {raw.get('lastError') or '(无)'}",
                 f"时间: {raw.get('firstAt')} → {raw.get('lastAt')}"]
        body.append("不是采集器的问题: 系统已经无法创建新进程(fork/posix_spawn 返回 EAGAIN), 所以所有源一起失败。"
                    "先看进程数(ps -U $USER | wc -l)、内存/swap; 找有没有 app 在疯狂 spawn "
                    "(Xcode 的 source control 风暴是已知案例), 必要时重启。")
    else:
        return None

    body.append(f"日志: {LHOME}/dsh-reflex.log")
    fc = raw.get('failureClass')
    if fc and fc in CLASS_HINT:
        cn2, hint = CLASS_HINT[fc]
        body.append(f"分类: {fc}（{cn2}）— {hint}")
    return title, "\n".join(body)


items_by_key, kinds = {}, {}
for f in facts:
    d = describe(f)
    if not d:
        # recovered = 事故边界: 清该问题的台阶台账, 下次同类问题按【新事故】重报第一步。
        # 否则台账跨事故残留 step-0, 同类问题再发生时第一次报告被吞(2026-10-24 实测)。
        if f.get('metric') == 'recovered':
            k = key_of(f)
            if k in pending_reports:
                pending_reports.pop(k)
                ledger_dirty = True
        continue
    k = key_of(f)
    if active is not None and k not in active:     # 已经恢复/不再活跃的旧问题, 不带进唤醒
        continue
    # 提醒节流 —— 必须由本脚本自己管, 不能指望 item id:
    #   插件有条规定是「同一内容 + 过了 cooldownMs(30 分钟) → 当作重新关注」, 所以只要问题还在,
    #   不管指纹变不变都会每 30 分钟叫一次(2026-10-16 凌晨实测 02:11 / 02:49 / 03:22)。
    #   改 id 只能增加叫的次数, 拦不住它。真正管用的是这里记住「报过没有」。
    #
    # 两类问题两套节奏 —— 半夜被"X 源挂了"叫醒是不合理的, 被"reflex 叫不醒 L2"叫醒是合理的:
    #   基础设施(叫不醒 L2 / 重载风暴): 1h / 3h / 6h / 12h —— 整条链断了, 值得快
    #   数据源(采集失败 / 判定失败 / 静默): 6h / 24h / 72h / 168h —— 少了一路信息, 明早再说
    fc = (f.get('raw') or {}).get('failureClass')
    is_infra = f.get('metric') in ('wake-failed', 'crash-loop', 'environment-failure') or \
               (f.get('metric') == 'collector-failure' and fc == 'executor-exception')
    group = 'infra' if is_infra else 'source'
    age_h = None
    if active_at.get(k):
        age_h = (time.time() * 1000 - active_at[k]) / 3600000.0
    step = max([b for b in STEP_HOURS[group] if age_h is not None and age_h >= b] or [0])
    if reported.get(k, -1) >= step:                # 这个台阶已经报过 → 不再打扰
        continue
    pending_reports[k] = step
    suffix = f'#{step}h' if step else ''
    title = d[0] + (f" · 已持续 {age_h:.1f} 小时" if suffix else '')
    # 同一个 key 在一批里出现多次时, 后面的(更新)覆盖前面的 —— 否则会拿旧一次故障的
    # 时间窗口去报告当前故障: 2026-10-16 11:26 那条唤醒就报成 01:06→01:25 (同一批里
    # 躺着凌晨那次失败的事实), 真实窗口是 10:55→11:25。批量里的事实有先后, 取最后一个。
    items_by_key[k] = {'id': k + suffix, 'title': title, 'body': d[1], '_metric': f.get('metric')}

items = sorted(items_by_key.values(), key=lambda x: x['id'])
for it in items:
    cn = KIND_CN.get(it.pop('_metric'), '异常')
    kinds[cn] = kinds.get(cn, 0) + 1

if not items:
    if ledger_dirty:                       # 台账清了也要落盘, 否则清零不生效
        keep = {k: v for k, v in pending_reports.items() if active is None or k in active}
        tmp = TSTATE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(keep, fh)
        os.replace(tmp, TSTATE)
    print(json.dumps({'wake': False, 'scanned': len(facts),
                      'reason': f'扫描 {len(facts)} 条, 无异常(或全部为恢复记录)'}, ensure_ascii=False))
    sys.exit(0)

# 真的要叫了 → 记台账(顺手把已经不在活跃列表里的 key 清掉, 免得无限增长)
try:
    keep = {k: v for k, v in pending_reports.items() if active is None or k in active}
    tmp = TSTATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(keep, fh)
    os.replace(tmp, TSTATE)
except Exception:
    pass          # 台账写不进去只是退化成"可能多叫一次", 不该因此不叫

items.sort(key=lambda x: x['id'])
summary = ', '.join(f'{k} {v}' for k, v in sorted(kinds.items()))
print(json.dumps({
    'wake': True,
    'reason': f'reflex 自检: {len(items)} 项异常 ({summary})',
    'fingerprint': {'ids': sorted(i['id'] for i in items)},
    'scanned': len(facts),
    'items': items,
}, ensure_ascii=False))
PY

cat > "$WORK/facts.jsonl"
python3 "$WORK/decide.py" "$WORK/facts.jsonl"
exit $?
