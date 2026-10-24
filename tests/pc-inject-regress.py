#!/usr/bin/env python3
"""pc_inject 回归测试: Predictable-Change 注入器 (算子确定性/采样分层/配对报告数学)。

用法: python3 tests/pc-inject-regress.py
被测对象优先级: repo skill/reflex-tuning/scripts → 运行目录部署副本。
打分器用 stub 替身(脚本化分数), 不调用真实 SemIf —— 本套件锁的是
注入变换的确定性与配对/报告数学, 不锁模型行为。
"""
import importlib.util, json, os, subprocess, sys, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..'))
REAL = os.path.expanduser('~/.dsh/dsh-reflex')
_CAND = [
    os.path.join(REPO, 'skill/reflex-tuning/scripts/pc_inject.py'),
    os.path.expanduser('~/.agents/skills/reflex-tuning/scripts/pc_inject.py'),
]
PC = next((p for p in _CAND if os.path.exists(p)), _CAND[-1])

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:200]))


def load_mod():
    spec = importlib.util.spec_from_file_location('pc_inject', PC)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


PROFILE = '用户: 测试用户, 工程师。'
BODY = '这条推文讨论 AI 编码工具的最新发布，含基准分数与开源链接。'


def mk_state(body=BODY):
    return (f'{PROFILE}\n\n推文作者: @alice (Alice)\n发布时间: 2026-10-24T10:00:00Z\n正文: {body}')


def mk_rec(i, passed, body=BODY):
    return {'id': f'fact-{i}', 'key': f'k{i}', 'tag': 'x-timeline', 'mode': 'live',
            'ts': 1792800000000 + i, 'question': '这条推文值得立即打断用户关注吗？',
            'state': mk_state(body), 'score': 0.95 if passed else 0.30,
            'p_yes': 0.95 if passed else 0.30, 'threshold': 0.93,
            'passed': passed, 'state_hash': f'h{i}'}


# ---------- t1: 算子确定性 ----------
def t1(m):
    s = mk_state()
    for op in ('strip_signal', 'swap_irrelevant', 'noise_append', 'shuffle_fields'):
        f = getattr(m, op)
        check(f't1 {op} 确定性', f(s) == f(s), '两次输出不同')
    st = m.strip_signal(s)
    check('t1 strip_signal 去载荷保壳', ('推文作者' in st and '发布时间' in st and BODY not in st), st[:120])
    sw = m.swap_irrelevant(s)
    body_out = sw.split('正文: ', 1)[1] if '正文: ' in sw else ''
    ratio = len(body_out) / max(len(BODY), 1)
    check('t1 swap_irrelevant 等长替换且非原正文', 0.3 <= ratio <= 3.0 and BODY not in sw, f'ratio={ratio:.2f}')
    na = m.noise_append(s)
    check('t1 noise_append 原文完整保留在前', na.startswith(s) and len(na) > len(s), na[-60:])
    sf = m.shuffle_fields(s)
    fields = ['推文作者', '发布时间', '正文']
    check('t1 shuffle_fields 字段齐全且顺序改变',
          all(f in sf for f in fields) and sf.find('正文') < sf.find('推文作者'), sf[:120])


# ---------- t2: 采样分层 ----------
def t2(m):
    recs = []
    for i in range(4): recs.append(mk_rec(100+i, True, body=f'高分推文 {i}。'))   # p_orig 0.95 -> near
    for i in range(4): recs.append(dict(mk_rec(200+i, True, body=f'高分2 {i}。'), score=0.99))
    for i in range(4): recs.append(dict(mk_rec(300+i, False, body=f'低分 {i}。'), score=0.20))
    picked = m.sample_records(recs, 12, seed=7)
    def band(r):
        sc = r.get('score')
        return 'high' if sc >= 0.97 else ('near' if sc >= 0.85 else ('mid' if sc >= 0.5 else 'low'))
    cnt = {b: sum(1 for r in picked if band(r) == b) for b in ('high', 'near', 'mid', 'low')}
    check('t2 分数带分层 4/4/4', cnt['near'] == 4 and cnt['high'] == 4 and cnt['low'] == 4, str(cnt))
    p6 = m.sample_records(recs, 6, seed=7)
    check('t2 半数采样 n=6', len(p6) == 6, f'n={len(p6)}')
    dup = recs + [dict(recs[0])]
    p3 = m.sample_records(dup, 12, seed=7)
    hashes = [r.get('state_hash') for r in p3]
    check('t2 state_hash 去重', len(hashes) == len(set(hashes)), f'{len(hashes)} vs {len(set(hashes))}')


# ---------- t3/t4: 端到端 stub 流程 + 报告数学 + ε 可调 ----------
def run_pc(tmp, eps, stub_body, sample=4, tag='x-timeline', days='2026-10-24', recs=None,
           out_dir=None, snapshot_out=None, from_snapshot=None, template=None):
    home = os.path.join(tmp, 'home')
    os.makedirs(os.path.join(home, 'shadow'), exist_ok=True)
    recs = recs if recs is not None else [mk_rec(i, i % 2 == 0) for i in range(sample)]
    with open(os.path.join(home, 'shadow', f'{tag}-{days}.jsonl'), 'w') as f:
        for r in recs:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    stub = os.path.join(tmp, 'stub-score.sh')
    with open(stub, 'w') as f:
        f.write(stub_body)
    os.chmod(stub, 0o755)
    out = out_dir or os.path.join(tmp, 'out')
    cmd = ['python3', PC, '--tag', tag, '--days', days, '--sample', str(sample),
           '--eps', str(eps), '--score-cmd', stub, '--out', out,
           '--options-json', os.path.join(tmp, 'opts.json')]
    if snapshot_out:
        cmd += ['--snapshot-out', snapshot_out]
    if from_snapshot:
        cmd += ['--from-snapshot', from_snapshot]
    if template:
        cmd += ['--template', template]
    env = dict(os.environ, REFLEX_HOME=home)
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=120)
    return p, out, home, tmp


STUB = """#!/bin/bash
IN=""; OUT=""
while [ $# -gt 0 ]; do case "$1" in --input) IN="$2"; shift 2;; --output) OUT="$2"; shift 2;; *) shift;; esac; done
[ -n "$IN" ] && [ -n "$OUT" ] || { echo "stub: missing --input/--output" >&2; exit 1; }
python3 - "$IN" "$OUT" <<'PYEOF'
import sys, json
inp, out = sys.argv[1], sys.argv[2]
with open(inp, encoding='utf-8') as f, open(out, 'w', encoding='utf-8') as g:
    for line in f:
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        rid = r['id']
        if rid.endswith(':orig'):
            p = 0.90
        elif ':strip_signal' in rid or ':swap_irrelevant' in rid:
            p = 0.10
        else:
            p = 0.91
        g.write(json.dumps({'id': rid, 'option_ids': ['yes', 'no', 'insufficient'],
                            'probabilities': [p, round(1 - p, 3), 0.0]}) + chr(10))
PYEOF
"""


def t3(tmp):
    opts = os.path.join(tmp, 'opts.json')
    with open(opts, 'w') as f:
        json.dump([{"id": "yes", "description": "值得"}, {"id": "no", "description": "不值得"},
                   {"id": "insufficient", "description": "不足"}], f)
    p, out, home, tmp2 = run_pc(tmp, 0.05, STUB)
    check('t3 pc_inject 退出码 0', p.returncode == 0, p.stderr[-200:])
    md = os.path.join(out, 'pc-report-x-timeline-2026-10-24.md')
    raw = os.path.join(out, 'pc-raw-x-timeline-2026-10-24.jsonl')
    check('t3 报告与原始记录落盘', os.path.exists(md) and os.path.exists(raw), f'{md}')
    if os.path.exists(md):
        txt = open(md, encoding='utf-8').read()
        check('t3 方向符合率 100%', '100.0%' in txt and '方向符合率' in txt, txt[:300])
        check('t3 不变性符合率 100%', txt.count('100.0%') >= 2, txt[:300])
    inp = os.path.join(out, 'pc-in-x-timeline-2026-10-24.jsonl')
    if os.path.exists(inp):
        ids = [json.loads(l)['id'] for l in open(inp, encoding='utf-8') if l.strip()]
        check('t3 候选载体 id 唯一(防分数覆盖)', len(ids) == len(set(ids)), f'{len(ids)} vs {len(set(ids))}')
    if os.path.exists(raw):
        rows = [json.loads(l) for l in open(raw, encoding='utf-8') if l.strip()]
        check('t3 原始行数 = 样本×算子数', len(rows) == 4 * 4, f'{len(rows)}')
        strip = [r for r in rows if r['op'] == 'strip_signal']
        check('t3 strip 全部方向正确', all(r['delta_p'] < 0 for r in strip), str(strip[:1]))
    return home


def t4(tmp):
    tmp = os.path.join(tmp, 'e2')
    os.makedirs(tmp, exist_ok=True)
    opts = os.path.join(tmp, 'opts.json')
    with open(opts, 'w') as f:
        json.dump([{"id": "yes", "description": "值得"}, {"id": "no", "description": "不值得"},
                   {"id": "insufficient", "description": "不足"}], f)
    stub = STUB.replace('p = 0.91', 'p = 0.905')   # noise Δ=0.005
    p, out, home, _ = run_pc(tmp, 0.001, stub)
    md = os.path.join(out, 'pc-report-x-timeline-2026-10-24.md')
    if os.path.exists(md):
        txt = open(md, encoding='utf-8').read()
        check('t4 ε 收紧后不变性判 0%', '0.0%' in txt, txt[:300])
    else:
        check('t4 ε 收紧后不变性判 0%', False, f'rc={p.returncode} stderr={p.stderr[-250:]} stdout={p.stdout[-120:]}')


def t5(tmp):
    tmp = os.path.join(tmp, 'dup2')
    os.makedirs(tmp, exist_ok=True)
    opts = os.path.join(tmp, 'opts.json')
    with open(opts, 'w') as f:
        json.dump([{"id": "yes", "description": "值得"}, {"id": "no", "description": "不值得"},
                   {"id": "insufficient", "description": "不足"}], f)
    recs = [mk_rec(9, True), dict(mk_rec(9, True), state_hash='h9b', ts=1792800000002)]
    p, out, home, _ = run_pc(tmp, 0.05, STUB, sample=2, recs=recs)
    raw = os.path.join(out, 'pc-raw-x-timeline-2026-10-24.jsonl')
    ok = p.returncode == 0 and os.path.exists(raw)
    rows = [json.loads(l) for l in open(raw)] if os.path.exists(raw) else []
    ids = {r['id'] for r in rows}
    check('t5 同 id 不同状态均保留且载体 id 唯一(8 行/2 id)',
          ok and len(rows) == 8 and len(ids) == 2,
          f'rc={p.returncode} rows={len(rows)} ids={len(ids)}')


# ---------- t6: 决策区间判定纯函数 ----------
def t6(m):
    def row(sc, ok, kind, ppert=None):
        pp = ppert if ppert is not None else sc
        return {'p_orig': sc, 'p_pert': pp, 'delta_p': pp - sc, 'ok': ok, 'kind': kind,
                'recorded_score': sc}
    def fill(op_rows):
        return op_rows
    per_op = {
        'strip_signal': [row(0.90, True, 'direction') for _ in range(18)] +
                        [row(0.90, False, 'direction') for _ in range(2)],
        'swap_irrelevant': [row(0.90, True, 'direction') for _ in range(17)] +
                           [row(0.90, False, 'direction') for _ in range(3)],
        'noise_append': [row(0.90, True, 'invariance') for _ in range(17)] +
                        [row(0.90, False, 'invariance') for _ in range(3)],
        'shuffle_fields': [row(0.90, True, 'invariance') for _ in range(16)] +
                          [row(0.90, False, 'invariance') for _ in range(4)],
    }
    for op in list(per_op):
        kind = 'direction' if op in ('strip_signal', 'swap_irrelevant') else 'invariance'
        per_op[op] += [row(0.99, True, kind) for _ in range(10)]
    v = m.judge_fingerprint(per_op)
    check('t6 方向 near 90% 恰过', v['verdict']['strip_signal'] == 'pass', str(v['verdict']))
    check('t6 方向 near 85% 判 fail', v['verdict']['swap_irrelevant'] == 'fail', str(v['verdict']))
    check('t6 不变 near 85% 判 pass', v['verdict']['noise_append'] == 'pass', str(v['verdict']))
    check('t6 不变 near 80% 判 fail', v['verdict']['shuffle_fields'] == 'fail', str(v['verdict']))
    check('t6 overall 不通过', v['overall'] is False, str(v['overall']))
    per_op2 = {op: (per_op[op][:20] if op in ('strip_signal', 'swap_irrelevant') else per_op[op][:20])
               for op in per_op}
    per_op2['strip_signal'] = [row(0.90, True, 'direction') for _ in range(18)] + \
                              [row(0.90, False, 'direction') for _ in range(2)]
    per_op2['swap_irrelevant'] = [row(0.90, True, 'direction') for _ in range(20)]
    per_op2['noise_append'] = [row(0.90, True, 'invariance') for _ in range(20)]
    per_op2['shuffle_fields'] = [row(0.90, True, 'invariance') for _ in range(20)]
    v2 = m.judge_fingerprint(per_op2)
    check('t6 全过 → overall True', v2['overall'] is True, str(v2))
    per_op3 = {op: [row(0.99, True, 'direction' if op in ('strip_signal', 'swap_irrelevant') else 'invariance')
                    for _ in range(10)] for op in per_op}
    v3 = m.judge_fingerprint(per_op3)
    check('t6 空 near 带 → 用 high 判定', v3['overall'] is True, str(v3))
    per_op4 = {op: [{'p_orig': 0.10, 'p_pert': 0.12, 'delta_p': 0.02, 'ok': False,
                     'kind': 'direction' if op in ('strip_signal', 'swap_irrelevant') else 'invariance',
                     'recorded_score': 0.10} for _ in range(5)] for op in per_op}
    v4 = m.judge_fingerprint(per_op4)
    check('t6 全地板样本 → overall None(无法判定)',
          v4['overall'] is None and all(x == 'n/a' for x in v4['verdict'].values()), str(v4))


# ---------- t7: blob 模板自适应 ----------
def t7(m):
    blob = '响应国家就业友好型 AI 发展指引，某公司助力高危岗位人机协同升级 - 搜狐网'
    ops = m.ops_for_state(blob)
    check('t7 blob 检测: 无 shuffle、有 strip', 'shuffle_fields' not in ops and 'strip_signal' in ops, str(list(ops)))
    st = ops['strip_signal'](blob)
    check('t7 blob strip 去原文', blob[:20] not in st and len(st) < 40, st[:60])
    sw = ops['swap_irrelevant'](blob)
    check('t7 blob swap 等长且非原文', sw != blob and blob[:20] not in sw
          and 0.3 <= len(sw) / len(blob) <= 3.0, 'len=%d' % len(sw))
    na = ops['noise_append'](blob)
    check('t7 blob noise 前缀保留', na.startswith(blob) and len(na) > len(blob), na[-40:])
    ops2 = m.ops_for_state(mk_state())
    check('t7 fielded 检测: 四算子齐全', set(ops2) == {'strip_signal', 'swap_irrelevant', 'noise_append', 'shuffle_fields'}, str(list(ops2)))


# ---------- t8: 快照复现 ----------
def t8(tmp):
    tmp = os.path.join(tmp, 'snap')
    os.makedirs(tmp, exist_ok=True)
    opts = os.path.join(tmp, 'opts.json')
    with open(opts, 'w') as f:
        json.dump([{"id": "yes", "description": "值得"}, {"id": "no", "description": "不值得"},
                   {"id": "insufficient", "description": "不足"}], f)
    snapdir = os.path.join(tmp, 'snapshots')
    p, out, home, _ = run_pc(tmp, 0.05, STUB, sample=4, snapshot_out=snapdir)
    snaps = os.listdir(snapdir) if os.path.isdir(snapdir) else []
    check('t8 快照文件生成', len(snaps) == 1, str(snaps))
    r1 = [json.loads(l) for l in open(os.path.join(out, 'pc-raw-x-timeline-2026-10-24.jsonl'))] if os.path.exists(os.path.join(out, 'pc-raw-x-timeline-2026-10-24.jsonl')) else []
    h1 = r1[0]['state_hash'] if r1 else None
    # 语料变化: 10 条 shadow + from-snapshot 复跑
    recs10 = [mk_rec(i, i % 2 == 0) for i in range(10)]
    out2 = os.path.join(tmp, 'out2')
    p2, _, _, _ = run_pc(tmp, 0.05, STUB, sample=4, recs=recs10, out_dir=out2,
                         from_snapshot=os.path.join(snapdir, snaps[0]) if snaps else '')
    raw2 = os.path.join(out2, 'pc-raw-x-timeline-2026-10-24.jsonl')
    r2 = [json.loads(l) for l in open(raw2)] if os.path.exists(raw2) else []
    check('t8 快照复跑: 样本不随语料漂移',
          p2.returncode == 0 and len(r1) == len(r2) and {x['state_hash'] for x in r1} == {x['state_hash'] for x in r2},
          'rc=%s %d vs %d' % (p2.returncode, len(r1), len(r2)))
    import re as _re
    md1 = open(os.path.join(out, 'pc-report-x-timeline-2026-10-24.md')).read()
    md2 = open(os.path.join(out2, 'pc-report-x-timeline-2026-10-24.md')).read()
    m1 = _re.search(r'sample_hash=([0-9a-f]+)', md1)
    m2 = _re.search(r'sample_hash=([0-9a-f]+)', md2)
    check('t8 sample_hash 一致且落盘', bool(m1 and m2 and m1.group(1) == m2.group(1)),
          '%s vs %s' % (m1 and m1.group(1), m2 and m2.group(1)))


def main():
    if not os.path.exists(PC):
        print(f'FAIL pc_inject.py 不存在: {PC}')
        sys.exit(1)
    m = load_mod()
    t1(m)
    t2(m)
    tmp = tempfile.mkdtemp(prefix='pc-inject-test-')
    try:
        t3(tmp)
        t4(tmp)
        t5(tmp)
        t6(load_mod())
        t7(load_mod())
        t8(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    fails = [r for r in results if not r[1]]
    print(f'\n== {len(results) - len(fails)}/{len(results)} passed ==')
    sys.exit(1 if fails else 0)


main()
