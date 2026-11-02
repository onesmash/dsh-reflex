#!/usr/bin/env python3
"""常驻 SemIf 打分器 · 接入面回归 (2026-11-02 新增).

覆盖三件事:
  t1 shadow wrapper 的常驻优先/回退语义 (defaults/semif-resident/call.sh 的契约)
  t2 插件注入面: REFLEX_SEMIF_RESIDENT 开关 + defaults/semif-resident 同步到运行目录
  t3 仓库静态一致性: 脚本可编译、接入点存在、包发布清单包含 defaults/

用法: python3 tests/reflex-semif-resident-regress.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..'))
IX = os.path.join(REPO, 'index.js')
PKG = os.path.join(REPO, 'package.json')
WRAPPER = os.path.join(REPO, 'skill/reflex-tuning/scripts/shadow-semif.sh')
RESIDENT = os.path.join(REPO, 'defaults/semif-resident')

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:240]))


def write_exec(path, body):
    with open(path, 'w') as f:
        f.write(body)
    os.chmod(path, 0o755)
    return path


def stub_resident_call(home, exit_code):
    """假的常驻 call.sh: 退出码可控; 成功时按输入行数产出打分文件."""
    d = os.path.join(home, 'runtime', 'semif-resident')
    os.makedirs(d, exist_ok=True)
    body = """#!/bin/bash
IN=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) IN="$2"; shift 2;;
    --output) OUT="$2"; shift 2;;
    *) shift;;
  esac
done
if [ "%d" -ne 0 ]; then exit %d; fi
python3 - "$IN" "$OUT" <<'PYEOF'
import sys, json
inp, out = sys.argv[1], sys.argv[2]
with open(inp, encoding='utf-8') as f, open(out, 'w', encoding='utf-8') as g:
    for line in f:
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        g.write(json.dumps({'id': row.get('id'), 'option_ids': ['yes', 'no'],
                            'probabilities': [0.9, 0.1], 'total_seconds': 0.5}) + chr(10))
PYEOF
exit 0
""" % (exit_code, exit_code)
    return write_exec(os.path.join(d, 'call.sh'), body)


def stub_real_scorer(tmp):
    """直调路径的假 run_score.sh: 产出同理的打分文件, 并留一个标记文件."""
    marker = os.path.join(tmp, 'real-called.marker')
    body = """#!/bin/bash
IN=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) IN="$2"; shift 2;;
    --output) OUT="$2"; shift 2;;
    *) shift;;
  esac
done
echo called > %s
python3 - "$IN" "$OUT" <<'PYEOF'
import sys, json
inp, out = sys.argv[1], sys.argv[2]
with open(inp, encoding='utf-8') as f, open(out, 'w', encoding='utf-8') as g:
    for line in f:
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        g.write(json.dumps({'id': row.get('id'), 'option_ids': ['yes', 'no'],
                            'probabilities': [0.1, 0.9], 'total_seconds': 0.4}) + chr(10))
PYEOF
exit 0
""" % marker
    return write_exec(os.path.join(tmp, 'stub-real-score.sh'), body), marker


def run_wrapper(home, real, tmp, extra_env=None, resident_on='1'):
    inp = os.path.join(tmp, 'in.jsonl')
    out = os.path.join(tmp, 'out-%s.jsonl' % resident_on)
    for f in (out, out + '.summary.md'):
        try:
            os.unlink(f)
        except FileNotFoundError:
            pass
    with open(inp, 'w') as f:
        f.write(json.dumps({'id': 'l1', 'state': 'x', 'question': 'q',
                            'options': [{'id': 'yes'}, {'id': 'no'}]}) + '\n')
    env = dict(os.environ)
    env.update({'REFLEX_HOME': home, 'REFLEX_SHADOW_REAL': real,
                'REFLEX_TARGET': 'regress', 'REFLEX_SEMIF_RESIDENT': resident_on})
    env.update(extra_env or {})
    p = subprocess.run(['bash', WRAPPER, '--input', inp, '--output', out, '--offline'],
                       capture_output=True, text=True, env=env, timeout=120)
    probs = None
    if os.path.exists(out):
        try:
            probs = json.loads(open(out).readline()).get('probabilities')
        except Exception:
            probs = None
    return p, probs


def t1():
    tmp = tempfile.mkdtemp(prefix='semif-resident-t1-')
    real, marker = stub_real_scorer(tmp)

    # 1) 常驻命中: 用 0.9 的假分, 直调脚本不应被调用
    home = os.path.join(tmp, 'home-ok')
    stub_resident_call(home, 0)
    p, probs = run_wrapper(home, real, tmp)
    check('t1a 常驻命中 → 用常驻分, 不跑直调',
          p.returncode == 0 and probs == [0.9, 0.1] and not os.path.exists(marker),
          'rc=%s probs=%s real_called=%s err=%s' % (p.returncode, probs, os.path.exists(marker), p.stderr[-160:]))
    check('t1a-2 stdout 保持为空 (契约: 不污染调用方)', p.stdout.strip() == '', repr(p.stdout[:120]))

    # 2) 常驻不可用(退出 3) → 回退直调, 用直调分
    home = os.path.join(tmp, 'home-fb')
    stub_resident_call(home, 3)
    try:
        os.unlink(marker)
    except FileNotFoundError:
        pass
    p, probs = run_wrapper(home, real, tmp)
    check('t1b 常驻不可用 → 回退直调', p.returncode == 0 and probs == [0.1, 0.9] and os.path.exists(marker),
          'rc=%s probs=%s real_called=%s' % (p.returncode, probs, os.path.exists(marker)))

    # 3) 显式关闭常驻 → 直接直调
    home = os.path.join(tmp, 'home-off')
    stub_resident_call(home, 0)
    try:
        os.unlink(marker)
    except FileNotFoundError:
        pass
    p, probs = run_wrapper(home, real, tmp, resident_on='0')
    check('t1c REFLEX_SEMIF_RESIDENT=0 → 完全直调', p.returncode == 0 and probs == [0.1, 0.9] and os.path.exists(marker),
          'rc=%s probs=%s real_called=%s' % (p.returncode, probs, os.path.exists(marker)))

    # 4) 运行目录里没有常驻组件 (旧版本/未同步) → 静默回退, 不报错
    home = os.path.join(tmp, 'home-nodir')
    os.makedirs(home, exist_ok=True)
    try:
        os.unlink(marker)
    except FileNotFoundError:
        pass
    p, probs = run_wrapper(home, real, tmp)
    check('t1d 常驻组件缺失 → 静默回退直调', p.returncode == 0 and probs == [0.1, 0.9] and os.path.exists(marker),
          'rc=%s probs=%s' % (p.returncode, probs))


def harness(tmp, config_json, home):
    h = os.path.join(tmp, 'h.mjs')
    with open(h, 'w') as f:
        f.write(
            "const repo = " + json.dumps(IX) + ";\n"
            "const noop = (...a) => { if (a.length && typeof a[0] === 'function') {"
            " try { const r = a[0](); return (r && typeof r === 'object') ? r : undefined;"
            " } catch { return undefined; } } return undefined; };\n"
            "const ctx = new Proxy({}, { get: (t, k) =>"
            " (k === 'log' || k === 'logger') ? (() => {}) : noop });\n"
            "const mod = await import(repo);\n"
            "const api = mod.apply(ctx, " + config_json + ");\n"
            "const env = await api.scriptEnv({});\n"
            "console.log(JSON.stringify({resident: env.REFLEX_SEMIF_RESIDENT, home: env.REFLEX_HOME}));\n")
    e = dict(os.environ)
    e['REFLEX_HOME'] = home
    p = subprocess.run(['node', h], capture_output=True, text=True, env=e, timeout=60)
    try:
        return json.loads(p.stdout.strip().splitlines()[-1]), p
    except Exception:
        return None, p


def t2():
    tmp = tempfile.mkdtemp(prefix='semif-resident-t2-')
    home = os.path.join(tmp, 'home')
    d1, p1 = harness(tmp, '{}', home)
    check('t2a 默认注入 REFLEX_SEMIF_RESIDENT=1', bool(d1) and d1.get('resident') == '1',
          (d1, p1.stderr[-200:]))
    synced = [f for f in ('serve.sh', 'serve.py', 'request.py', 'call.sh')
              if os.path.exists(os.path.join(home, 'runtime', 'semif-resident', f))]
    check('t2b defaults/semif-resident 同步到 $REFLEX_HOME/runtime', len(synced) == 4, synced)

    d2, p2 = harness(tmp, '{"l1":{"semifResident":false}}', os.path.join(tmp, 'home2'))
    check('t2c l1.semifResident=false → 注入 0', bool(d2) and d2.get('resident') == '0',
          (d2, p2.stderr[-200:]))


def t3():
    for f in ('serve.sh', 'serve.py', 'request.py', 'call.sh'):
        p = os.path.join(RESIDENT, f)
        check('t3 文件存在: defaults/semif-resident/%s' % f, os.path.isfile(p), p)
    py = subprocess.run([sys.executable, '-m', 'py_compile',
                         os.path.join(RESIDENT, 'serve.py'), os.path.join(RESIDENT, 'request.py')],
                        capture_output=True, text=True)
    check('t3b serve.py / request.py 可编译', py.returncode == 0, py.stderr[-200:])
    sh = subprocess.run(['bash', '-n', os.path.join(RESIDENT, 'serve.sh')], capture_output=True, text=True)
    sh2 = subprocess.run(['bash', '-n', os.path.join(RESIDENT, 'call.sh')], capture_output=True, text=True)
    check('t3c serve.sh / call.sh 语法正确', sh.returncode == 0 and sh2.returncode == 0, sh.stderr + sh2.stderr)
    wrap = open(WRAPPER).read()
    check('t3d shadow wrapper 接入常驻且保留直调回退',
          'runtime/semif-resident/call.sh' in wrap and 'bash "$REAL" "$@"' in wrap
          and 'shadow_record.py' in wrap, 'wrapper 缺少常驻/回退/影子记录之一')
    pkg = json.load(open(PKG))
    files = pkg.get('files') or []
    check('t3e package.json files 含 defaults/', any(f.rstrip('/') == 'defaults' for f in files), files)
    src = open(IX).read()
    check('t3f index.js 同步常驻组件 + 注入开关',
          "defaults', 'semif-resident'" in src and 'REFLEX_SEMIF_RESIDENT' in src
          and "'runtime', 'semif-resident'" in src, 'index.js 缺少同步或注入')


t1()
t2()
t3()

fails = [r for r in results if not r[1]]
print('\n== %d/%d passed ==' % (len(results) - len(fails), len(results)))
sys.exit(1 if fails else 0)
