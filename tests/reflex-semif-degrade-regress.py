#!/usr/bin/env python3
"""SemIf 注入路径 + target 降级语义回归 (2026-10-24 ai-policy/edu-policy 判定层瘫痪事故).

事故链: 0.3.5 的 REFLEX_SEMIF_RUN 把已含 /scripts 的 tuning.skillDir 又拼了一层
'scripts' → 路径不存在。直接使用注入值的 5 个 target 中, 带硬守卫的
(ai-policy/edu-policy/arxiv-watch) 每次 exit 1; ai-policy 的守卫排在必报直通
之前 → SemIf 一坏必报也死, 静默 10 小时 (health 速率阈值盲区, 见 health 套件的
连续窗口升级用例)。

用法: python3 tests/reflex-semif-degrade-regress.py
t1 测 repo 的 index.js (插件注入面, sandbox ctx 不执行任何副作用);
t2 测 ai-policy target (个人源, 只存在于运行目录)。
"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..'))
REAL = os.path.expanduser('~/.dsh/dsh-reflex')
IX = os.path.join(REPO, 'index.js')
_AIP_CAND = [
    os.path.join(REPO, 'defaults/ai-policy/targets/ai-policy.sh'),
    os.path.join(REAL, 'targets/ai-policy.sh'),
]
AIP = next((p for p in _AIP_CAND if os.path.exists(p)), _AIP_CAND[-1])

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  <- ' + str(detail)[:220]))


def must_fact():
    # 人社部(AUTH) + 实施方案/促就业行动(TOPIC) + 人社部(GEO_KEEP) → 三层全过, 必报直通
    return json.dumps({'metric': 'policy', 'raw': {
        'title': '人社部关于印发高质量就业促就业行动实施方案的通知',
        'source': '人社部官网', 'link': 'https://example.com/m1',
        'published': '2026-10-24', 'keywords': ['人社部', '实施方案']}}, ensure_ascii=False)


def cand_fact():
    # 无 AUTH/无 TOPIC 词/无 GEO 标记 → SemIf 候选
    return json.dumps({'metric': 'policy', 'raw': {
        'title': 'AI编码助手发布新版本支持多文件编辑',
        'source': '科技媒体', 'link': 'https://example.com/c1',
        'published': '2026-10-24', 'keywords': ['AI']}}, ensure_ascii=False)


def run_aip(facts, extra_env=None):
    e = dict(os.environ)
    e.update(extra_env or {})
    p = subprocess.run(['bash', AIP], input='\n'.join(facts) + '\n',
                       capture_output=True, text=True, env=e, timeout=90)
    out = p.stdout.strip()
    try:
        j = json.loads(out) if out else None
    except Exception:
        j = None
    return p.returncode, j, p.stderr


def stub_scorer(tmp, prob='0.90'):
    """合法打分器 stub: 接口同 run_score.sh (--input X --output Y --offline),
    对每条候选输出 option_ids=[yes,no], probabilities=[prob,1-prob]."""
    p = os.path.join(tmp, 'stub-score.sh')
    with open(p, 'w') as f:
        f.write("""#!/bin/bash
IN=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) IN="$2"; shift 2;;
    --output) OUT="$2"; shift 2;;
    *) shift;;
  esac
done
python3 - "$IN" "$OUT" %s <<'PYEOF'
import sys, json
inp, out, prob = sys.argv[1], sys.argv[2], float(sys.argv[3])
with open(inp, encoding='utf-8') as f, open(out, 'w', encoding='utf-8') as g:
    for line in f:
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        g.write(json.dumps({'id': r['id'], 'option_ids': ['yes', 'no'],
                            'probabilities': [prob, 1.0 - prob]}) + chr(10))
PYEOF
""" % prob)
    os.chmod(p, 0o755)
    return p


# ---------- t1: 插件注入面 (repo index.js, sandbox mock ctx) ----------
def t1():
    name = 't1 scriptEnv 注入面'
    d = os.path.dirname(tempfile.mktemp(prefix='semif-regress-'))
    os.makedirs(d, exist_ok=True)
    harness = os.path.join(d, 'h.mjs')
    with open(harness, 'w') as f:
        f.write(
            "const repo = " + json.dumps(IX) + ";\n"
            "const noop = (...a) => { if (a.length && typeof a[0] === 'function') {"
            " try { const r = a[0](); return (r && typeof r === 'object') ? r : undefined;"
            " } catch { return undefined; } } return undefined; };\n"
            "const ctx = new Proxy({}, { get: (t, k) =>"
            " (k === 'log' || k === 'logger') ? (() => {}) : noop });\n"
            "const mod = await import(repo);\n"
            "const api = mod.apply(ctx, {});\n"
            "const env = await (typeof api.scriptEnv === 'function' ? api.scriptEnv({}) : api.scriptEnv);\n"
            "console.log(JSON.stringify({ sem: env.REFLEX_SEMIF_RUN,"
            " real: env.REFLEX_SHADOW_REAL, tun: env.REFLEX_TUNING_DIR }));\n"
            "process.exit(0);\n")
    try:
        p = subprocess.run(['node', harness], capture_output=True, text=True, timeout=45)
        d1 = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception as ex:
        check(name, False, 'harness 异常: %r %s %s' % (ex, p.stdout[:120] if 'p' in dir() else '', p.stderr[:200] if 'p' in dir() else ''))
        return
    sem, tun, real = d1.get('sem'), d1.get('tun'), d1.get('real')
    check('t1a REFLEX_SEMIF_RUN == <TUNING_DIR>/shadow-semif.sh (无双重 scripts)',
          sem == os.path.join(tun or '', 'shadow-semif.sh'), sem)
    check('t1b REFLEX_SEMIF_RUN 指向的文件存在', bool(sem) and os.path.exists(sem), sem)
    check('t1c REFLEX_SHADOW_REAL 指向的文件存在', bool(real) and os.path.exists(real), real)


# ---------- t2: ai-policy 降级语义 ----------
def t2a():
    rc, j, err = run_aip([must_fact(), cand_fact()],
                         {'REFLEX_SEMIF_RUN': '/nonexistent/score.sh'})
    items = (j or {}).get('items', [])
    check('t2a SemIf 不可用 → 必报直通仍存活 (exit 0 + wake 含必报)',
          rc == 0 and (j or {}).get('wake') and '必报' in ((j or {}).get('reason') or '')
          and any('必报' in it.get('title', '') for it in items),
          'rc=%s err=%s' % (rc, err.strip()[:150]))
    check('t2a-2 不可判分的候选不冒充结果 (wake 只含必报 1 条)',
          len(items) == 1, str(len(items)))


def t2b():
    rc, j, err = run_aip([cand_fact()],
                         {'REFLEX_SEMIF_RUN': '/nonexistent/score.sh'})
    check('t2b 无必报且 SemIf 不可用 → exit 1 (health 可见), 不静默成功',
          rc != 0 and '打分脚本' in err, 'rc=%s err=%s' % (rc, err.strip()[:120]))


def t2c():
    tmp = tempfile.mkdtemp(prefix='semif-stub-')
    stub = stub_scorer(tmp)
    rc, j, err = run_aip([must_fact(), cand_fact()], {'REFLEX_SEMIF_RUN': stub})
    items = (j or {}).get('items', [])
    reason = (j or {}).get('reason') or ''
    check('t2c 健康路径不回归: 必报 + stub 0.90 落地信号同 wake',
          rc == 0 and (j or {}).get('wake') and len(items) == 2
          and '必报' in reason and '落地信号' in reason,
          'rc=%s reason=%s err=%s' % (rc, reason, err.strip()[:120]))


t1()
t2a()
t2b()
t2c()

fails = [r for r in results if not r[1]]
print('\n== %d/%d passed ==' % (len(results) - len(fails), len(results)))
sys.exit(1 if fails else 0)
