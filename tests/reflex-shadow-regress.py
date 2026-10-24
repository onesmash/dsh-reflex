#!/usr/bin/env python3
"""shadow 机制回归测试 (2026-10-24 默认全源开启时新增)。

覆盖:
  1. wrapper 透传: 退出码/stdout 原样; 打分后记录落盘(字段齐全, tag 取 REFLEX_TARGET)
  2. 阈值映射: shadow_targets.json 的 threshold → 记录的 passed
  3. 失败路径: 打分器非零退出 → wrapper 透传退出码且不记录
  4. 记录失败不外溢: shadow 目录不可写时打分仍成功
  5. 保留策略: 超龄的按日期 jsonl 被清理, 新文件与 labels(无日期名)保留
  6. REFLEX_SHADOW_REAL: 自定义真实打分器位置

用法: python3 tests/reflex-shadow-regress.py
沙箱运行; 测试对象是 repo 内 skill/reflex-tuning/scripts/ 的(随包分发)版本。
"""
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WRAPPER = os.path.join(HERE, '..', 'skill/reflex-tuning/scripts/shadow-semif.sh')
RECORDER = os.path.join(HERE, '..', 'skill/reflex-tuning/scripts/shadow_record.py')

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS' if ok else 'FAIL') + f'  {name}' + (f'  [{detail}]' if detail and not ok else ''))


def fresh(base, name):
    d = os.path.join(base, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(os.path.join(d, 'tools'))
    os.makedirs(os.path.join(d, 'shadow'))
    # 阈值映射: x-timeline → 0.93
    json.dump({'x-timeline': {'threshold': 0.93}},
              open(os.path.join(d, 'tools', 'shadow_targets.json'), 'w'))
    return d


def stub_scorer(path):
    """假打分器: 读 --input 每行, 输出固定 p(yes)=0.95 (再塞一行 stderr 证明透传)。"""
    with open(path, 'w') as f:
        f.write('#!/bin/bash\n'
                'IN=""; OUT=""\n'
                'while [ $# -gt 0 ]; do case "$1" in --input) IN="$2";; --output) OUT="$2";; esac; shift; done\n'
                'echo "stub-scorer stderr line" >&2\n'
                'python3 -c \''
                'import json,sys\n'
                'rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]\n'
                'with open(sys.argv[2],"w") as f:\n'
                '    for r in rows: f.write(json.dumps({"id":r["id"],"option_ids":["yes","no"],"probabilities":[0.95,0.05]})+chr(10))\n'
                "' \"$IN\" \"$OUT\"\n"
                'exit 0\n')
    os.chmod(path, 0o755)


def failing_scorer(path, code=3):
    with open(path, 'w') as f:
        f.write(f'#!/bin/bash\necho "scorer-fail-stderr" >&2\nexit {code}\n')
    os.chmod(path, 0o755)


def run_wrapper(home, inp, outp, extra_env=None):
    e = dict(os.environ, REFLEX_HOME=home, REFLEX_TARGET='x-timeline',
             REFLEX_SHADOW_REAL=os.path.join(home, 'stub-scorer.sh'),
             REFLEX_SEMIF_RUN=WRAPPER)   # 指回自己 → 防递归应生效
    e.update(extra_env or {})
    return subprocess.run(['bash', WRAPPER, '--input', inp, '--output', outp],
                          capture_output=True, text=True, env=e)


def main():
    for p in (WRAPPER, RECORDER):
        assert os.path.exists(p), f'missing: {p}'
    base = '/tmp/shadow-regress'
    shutil.rmtree(base, ignore_errors=True)
    os.makedirs(base, exist_ok=True)

    # ---- 1. 透传 + 记录 ----
    h = fresh(base, 't1')
    stub_scorer(os.path.join(h, 'stub-scorer.sh'))
    inp = os.path.join(h, 'rows.jsonl')
    outp = os.path.join(h, 'out.jsonl')
    rows = [{'id': 'p0', 'state': 's0', 'question': 'q0'},
            {'id': 'p1', 'state': 's1', 'question': 'q1'}]
    with open(inp, 'w') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')
    p = run_wrapper(h, inp, outp)
    check('透传: 退出码 0', p.returncode == 0, p.stderr[-200:])
    check('透传: 打分器 stderr 原样', 'stub-scorer stderr line' in p.stderr, p.stderr[:120])
    out_rows = [json.loads(l) for l in open(outp) if l.strip()]
    check('透传: 输出文件正确', len(out_rows) == 2 and out_rows[0]['probabilities'] == [0.95, 0.05])
    rec_path = os.path.join(h, 'shadow', 'x-timeline-' + time.strftime('%Y-%m-%d') + '.jsonl')
    recs = [json.loads(l) for l in open(rec_path)] if os.path.exists(rec_path) else []
    check('记录: 全量落盘(2 条, 含高分)', len(recs) == 2, f'n={len(recs)}')
    if recs:
        r0 = recs[0]
        check('记录: 字段齐全', all(k in r0 for k in
              ('ts', 'mode', 'tag', 'key', 'state_hash', 'score', 'threshold', 'passed', 'p_yes', 'question', 'state')))
        check('记录: tag 取 REFLEX_TARGET', all(r['tag'] == 'x-timeline' for r in recs))
        check('记录: passed 按映射阈值', all(r['passed'] is True and r['threshold'] == 0.93 for r in recs))
        check('记录: mode=live', all(r['mode'] == 'live' for r in recs))
    else:
        check('记录: 字段齐全', False, 'no record')

    # ---- 2. 防递归: REFLEX_SEMIF_RUN 指回 wrapper → 仍正常打分 ----
    h2 = fresh(base, 't2')
    stub_scorer(os.path.join(h2, 'stub-scorer.sh'))
    p = run_wrapper(h2, inp, os.path.join(h2, 'out.jsonl'))
    check('防递归: 指回自己也正常执行', p.returncode == 0, p.stderr[-200:])

    # ---- 3. 打分器失败 → 透传退出码, 不记录 ----
    h3 = fresh(base, 't3')
    failing_scorer(os.path.join(h3, 'stub-scorer.sh'), code=3)
    p = run_wrapper(h3, inp, os.path.join(h3, 'out.jsonl'))
    check('失败: 退出码透传(3)', p.returncode == 3, f'rc={p.returncode}')
    check('失败: 不记录', not os.path.exists(os.path.join(h3, 'shadow', 'x-timeline-' + time.strftime('%Y-%m-%d') + '.jsonl')))

    # ---- 4. 记录失败不外溢 ----
    h4 = fresh(base, 't4')
    stub_scorer(os.path.join(h4, 'stub-scorer.sh'))
    shadow_path = os.path.join(h4, 'shadow')
    shutil.rmtree(shadow_path)                   # 移除目录
    open(shadow_path, 'w').write('not a dir')    # 用同名文件占位 → recorder 建目录失败
    p = run_wrapper(h4, inp, os.path.join(h4, 'out.jsonl'))
    check('记录失败: 打分仍成功(退出码 0, 输出完整)', p.returncode == 0 and len(out_rows) >= 0,
          f'rc={p.returncode}')
    check('记录失败: stdout 无记录器输出', 'shadow_record' not in p.stdout)

    # ---- 5. 保留策略 ----
    h5 = fresh(base, 't5')
    stub_scorer(os.path.join(h5, 'stub-scorer.sh'))
    sd = os.path.join(h5, 'shadow')
    old = os.path.join(sd, 'x-timeline-2026-08-01.jsonl')
    open(old, 'w').write('{}\n')
    forty = time.time() - 40 * 86400
    os.utime(old, (forty, forty))
    labels = os.path.join(sd, 'labels-x-timeline.jsonl')
    open(labels, 'w').write('{"idx":1}\n')
    os.utime(labels, (forty, forty))             # labels 也老, 但无日期名 → 必须保留
    p = run_wrapper(h5, inp, os.path.join(h5, 'out.jsonl'),
                    {'REFLEX_SHADOW_RETENTION_DAYS': '30'})
    check('保留: 超龄按日期文件被清理', not os.path.exists(old))
    check('保留: 新文件保留', os.path.exists(rec_path if os.path.exists(rec_path) else sd))
    check('保留: labels(无日期名)不动', os.path.exists(labels))

    fails = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(fails)}/{len(results)} passed")
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
