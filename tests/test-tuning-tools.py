#!/usr/bin/env python3
"""reflex-tuning skill 回归测试（仓库侧，不依赖运行目录/网络/SemIf）。

覆盖：风险证书的数理正确性、校准映射、通用唤醒策略状态机、策略仿真。
跑法：python3 tests/test-tuning-tools.py
"""
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, '..', 'skill', 'reflex-tuning', 'scripts')

results = []


def load(name):
    path = os.path.join(SCRIPTS, name)
    spec = importlib.util.spec_from_file_location(name.replace('.py', ''), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check(label, cond, detail=''):
    results.append((label, bool(cond)))
    print(('PASS' if cond else 'FAIL') + f'  {label}' + (f'  [{detail}]' if detail and not cond else ''))


def main():
    check('skill 脚本目录存在', os.path.isdir(SCRIPTS), SCRIPTS)
    for name in ('shadow-semif.sh', 'shadow_record.py', 'shadow_replay.py', 'threshold_fit.py',
                 'shadow_ab.py', 'risk_certificate.py', 'calibration.py', 'wake_ledger.py',
                 'replay_wake_eval.py', 'wake_policy_sim.py', 'wake_policy.py'):
        check(f'脚本: {name}', os.path.exists(os.path.join(SCRIPTS, name)))

    # 1. Clopper-Pearson 数理
    rc = load('risk_certificate.py')
    check('CP: 10/10 下界 = 0.05^(1/10)', abs(rc.cp_lower(10, 10, 0.05) - 0.741134) < 1e-4)
    check('CP: 0/10 上界', abs(rc.cp_upper(0, 10, 0.05) - 0.258866) < 1e-4)
    check('CP: 对称性', abs(rc.cp_lower(5, 10, 0.05) + rc.cp_upper(5, 10, 0.05) - 1.0) < 1e-6)
    check('CP: 样本量规划(0 误报, ≤5% -> 59)', rc.sample_size_zero_fp(0.05, 0.05) == 59)

    # 2. 校准
    cal = load('calibration.py')
    rows = [(0.95, 1)] * 4 + [(0.95, 0)] * 4 + [(0.6, 0)] * 8
    ece_id = cal.ece([x for x, _ in rows], [y for _, y in rows])
    pa, pb = cal.fit_platt([x for x, _ in rows], [y for _, y in rows])
    ece_platt = cal.ece([cal.sigmoid(pa * x + pb) for x, _ in rows], [y for _, y in rows])
    check('校准: 原始分 ECE 明显偏高', ece_id > 0.3, f'{ece_id:.2f}')
    check('校准: Platt 显著降低 ECE', ece_platt < ece_id / 2, f'{ece_platt:.3f}')
    pts = cal.fit_isotonic([x for x, _ in rows], [y for _, y in rows])
    check('校准: isotonic 单调（0.95 组映射到 0.5）', abs(cal.predict_isotonic(pts, 0.95) - 0.5) < 1e-6)

    # 3. 通用唤醒策略
    wp = load('wake_policy.py')
    with tempfile.TemporaryDirectory() as td:
        state = os.path.join(td, 'deferred.json')
        now = 1_000_000
        # 单条低置信 -> 暂存
        d = wp.decide([{'id': 'a', 'score': 0.95}], state, now)
        check('策略: 单条低置信暂存', d['wake'] is False and d['deferred'] == 1, str(d))
        # 第二条到达 -> 合并
        d = wp.decide([{'id': 'b', 'score': 0.95}], state, now + 60_000)
        check('策略: 第二条合并唤醒', d['wake'] is True and len(d['items']) == 2, str(d))
        # 高置信单条 -> 立即发
        d = wp.decide([{'id': 'c', 'score': 0.99}], state, now + 120_000)
        check('策略: 高置信单条立即发', d['wake'] is True and len(d['items']) == 1, str(d))
        # 过期清理
        wp.decide([{'id': 'x', 'score': 0.94}], state, now)
        d = wp.decide([], state, now + 2 * 3600_000)
        check('策略: 超时暂存被丢弃', d['wake'] is False and json.load(open(state)) == [], str(d))

    # 4. 策略仿真
    sim = load('wake_policy_sim.py')
    items = [{'ms': 0, 'score': 0.99, 'label': 1}, {'ms': 10 * 60_000, 'score': 0.94, 'label': 0},
             {'ms': 35 * 60_000, 'score': 0.95, 'label': 0}, {'ms': 200 * 60_000, 'score': 0.99, 'label': 1}]
    groups = sim.group(items, 30)
    check('仿真: 30 分钟聚类=2 组', len(groups) == 2, f'got {len(groups)}')
    wait_kept = [g for g in sim.group(items, 60) if len(g) >= 2]
    st = sim.emit_stats(wait_kept, 4, 2, 5)
    check('仿真: wait60 只发多条目组', st['wakes'] == 1, str(st))
    thr_kept = [g if (len(g) >= 2 or max(i['score'] for i in g) >= 0.98) else [] for g in groups]
    st2 = sim.emit_stats(thr_kept, 4, 2, 5)
    check('仿真: 单条高阈值保留', st2['wakes'] == 2, str(st2))

    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)}/{len(results)} 通过')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
