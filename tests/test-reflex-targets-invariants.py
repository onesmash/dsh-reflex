#!/usr/bin/env python3
"""shadow_targets 登记表一致性：T1–T5 守门测试（verifying-design-invariants S2/S3）。

对应 docs/property-register-targets.md 的五行性质。T1 的模型反例（S1）是
`WriteCounts → Read`：计数已更、派生副本未跟，读者读到旧值。本文件把它映射成
真实可重放的用例（S2），并给其余四条不建模的性质各配一个纯函数守门（S3）。

跑法：
  python3 tests/test-reflex-targets-invariants.py                # 用 REFLEX_HOME 或 ~/.dsh/dsh-reflex
  python3 tests/test-reflex-targets-invariants.py --home DIR     # 指定运行时目录

退出码：0 全过 / 1 有失败 / 2 未判定（找不到登记表或读层，证据不足≠通过）

纪律：每条检查都先打印候选集大小。候选为 0 的检查不许算通过，单列为「未校验」。
"""
import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, '..', 'skill', 'reflex-tuning', 'scripts')

results = []   # (label, ok, detail)
skipped = []   # (label, why)


def check(label, cond, detail=''):
    ok = bool(cond)
    results.append((label, ok, detail))
    print(('PASS' if ok else 'FAIL') + '  ' + label + (('  [' + str(detail) + ']') if detail and not ok else ''))
    return ok


def unverified(label, why):
    skipped.append((label, why))
    print('UNVERIFIED  ' + label + '  [' + str(why) + ']')


def load_mod(name):
    path = os.path.join(SCRIPTS, name)
    spec = importlib.util.spec_from_file_location(name.replace('.py', ''), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--home', default=os.environ.get('REFLEX_HOME') or os.path.expanduser('~/.dsh/dsh-reflex'))
    ap.add_argument('--register', default='')
    a = ap.parse_args()
    reg_path = a.register or os.path.join(a.home, 'tools', 'shadow_targets.json')

    # ---- 0. 前置：读层与登记表 ----
    io = None
    io_err = ''
    try:
        io = load_mod('shadow_targets_io.py')
    except Exception as e:                      # noqa: BLE001 - 读层缺失就是本轮的红
        io_err = type(e).__name__ + ': ' + str(e)
    check('读层存在：skill/reflex-tuning/scripts/shadow_targets_io.py', io is not None, io_err)

    if not os.path.exists(reg_path):
        print('\n登记表不存在，未判定：' + reg_path)
        return 2

    raw = json.load(open(reg_path, encoding='utf-8'))
    n_tags = sum(1 for v in raw.values() if isinstance(v, dict))
    print('\n输入集：登记表 %d 个 tag（%s）\n' % (n_tags, reg_path))

    if io is None:
        print('\n读层不存在，其余检查全部未判定（这不是通过）。')
        print('结果：%d FAIL / %d UNVERIFIED' % (len(results), 1))
        return 1

    # ---- T1：派生值必须等于计数现算值 ----
    print('-- T1 派生指标 == 计数现算 --')
    cands = []
    for tag, obj in raw.items():
        if not isinstance(obj, dict):
            continue
        c = io.counts_of(obj)
        if c:
            cands.append(tag)
    print('   候选：%d/%d 个 tag 有可复算计数 -> %s' % (len(cands), n_tags, cands or '(无)'))
    if not cands:
        unverified('T1-a 真实登记表无漂移', '没有任何 tag 声明了可复算计数')
    else:
        bad = []
        for tag in cands:
            for field, stored, recomputed in io.drift_of(raw[tag]):
                bad.append('%s.%s 存 %s ≠ 算 %.4f' % (tag, field, stored, recomputed))
        check('T1-a 真实登记表无漂移（%d 个 tag 有计数）' % len(cands), not bad, '; '.join(bad))

    # T1-b 窗口回放：把 S1 的 WriteCounts → Read 逐步映射到真实文件
    tmp = tempfile.mkdtemp(prefix='reflex-t1-')
    try:
        work = os.path.join(tmp, 'shadow_targets.json')
        shutil.copy(reg_path, work)
        base = json.load(open(work, encoding='utf-8'))
        tag = cands[0] if cands else None
        if not tag:
            unverified('T1-b WriteCounts→Read 窗口回放', '没有可复算计数的 tag，回放无从谈起')
        else:
            before = io.value(base[tag], 'recallPoint')
            # 第 1 步 WriteCounts：只改计数（真实两段写的第一个动作）
            c = dict(io.counts_of(base[tag]))
            c['tp'] += 1
            c['fp'] -= 1
            base[tag] = io.with_counts(base[tag], c)
            json.dump(base, open(work, 'w', encoding='utf-8'), ensure_ascii=False)
            # 第 2 步 Read：读者必须看到跟计数走的新值
            after_obj = json.load(open(work, encoding='utf-8'))[tag]
            after = io.value(after_obj, 'recallPoint')
            expect = c['tp'] / float(c['tp'] + c['fn'])
            check('T1-b 计数变了，读者读到的 recallPoint 跟着变（%.4f -> %.4f，期望 %.4f）'
                  % (before, after, expect), abs(after - expect) < 5e-4,
                  '读者仍看到旧副本' if abs(after - expect) >= 5e-4 else '')

            # T1-c 破坏变体：同一个对象上，「取副本」的读法必须被判红，读层必须读对
            stale_obj = dict(after_obj)
            stale_obj['recallPoint'] = 0.856        # 两段写留下的旧副本
            copy_reader = type('CopyReader', (), {'value': staticmethod(lambda obj, f: obj.get(f))})
            stale = copy_reader.value(stale_obj, 'recallPoint')
            fresh = io.value(stale_obj, 'recallPoint')
            check('T1-c 破坏变体：取副本判红（%s）而读层读对（%.4f）' % (stale, fresh),
                  abs(stale - expect) >= 5e-4 and abs(fresh - expect) < 5e-4,
                  '要么副本也通过、要么读层也读错 -> 断言没有分辨力')

            # T1-d 空返回变体：读层返回空值时，断言不许静默通过
            empty_reader = type('EmptyReader', (), {'value': staticmethod(lambda obj, f: None)})
            blank = empty_reader.value(after_obj, 'recallPoint')
            check('T1-d 空返回变体：读层返回 None 时必须判红',
                  blank is None or abs(blank - expect) >= 5e-4, '空值被当成通过')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # ---- T2：标签文件缺 state_hash 必须拒读 ----
    print('\n-- T2 标签读取：state_hash 门禁 --')
    label_files = []
    for tag, obj in raw.items():
        if isinstance(obj, dict) and obj.get('labelsFile'):
            p = os.path.join(a.home, obj['labelsFile'])
            if os.path.exists(p):
                label_files.append((tag, p))
    print('   候选：%d 份标签文件 -> %s' % (len(label_files), [t for t, _ in label_files] or '(无)'))
    if not label_files:
        unverified('T2 缺 state_hash 的标签文件被拒读', '登记表指向的标签文件都不存在')
    else:
        tag, p = label_files[0]
        refused = None
        try:
            io.load_labels(p)
        except io.LabelsMissingStateHash as e:
            refused = e
        except Exception as e:                  # noqa: BLE001
            refused = None
            print('   非预期异常：' + type(e).__name__ + ': ' + str(e))
        ok = refused is not None and getattr(refused, 'missing', 0) > 0
        check('T2-a 缺 state_hash 必须拒读并报行数（%s）' % os.path.basename(p), ok,
              '没有拒绝，或者拒绝理由不含行数')

        # 显式豁免：标记 + 计数 + 报告，缺一不可
        labels, rep = io.load_labels(p, allow_legacy=True)
        ok2 = (len(labels) > 0 and rep.get('legacy_nohash', 0) > 0
               and rep.get('mode') == 'legacy-exempt')
        check('T2-b 显式豁免要带计数与报告（legacy_nohash=%s/%s）'
              % (rep.get('legacy_nohash'), rep.get('total')), ok2, json.dumps(rep, ensure_ascii=False))

        # 合成带 state_hash 的文件必须放行
        tmpf = os.path.join(tempfile.mkdtemp(prefix='reflex-t2-'), 'ok.jsonl')
        with open(tmpf, 'w', encoding='utf-8') as fh:
            for i in range(3):
                fh.write(json.dumps({'key': 'k%d' % i, 'label': i % 2,
                                     'state_hash': 'deadbeef%02d' % i}) + '\n')
        try:
            io.load_labels(tmpf)
            passed = True
        except Exception:                        # noqa: BLE001
            passed = False
        check('T2-c 带 state_hash 的标签文件正常读入', passed)

    # ---- T3：whyNotBatch 必须是可机检引用 ----
    print('\n-- T3 阈值变更必须有可机检 whyNotBatch --')
    tmpdir = tempfile.mkdtemp(prefix='reflex-t3-')
    real_rel = os.path.relpath(os.path.join(a.home, 'shadow', 'tuning-note-20261116.md'), a.home)
    try:
        old = {'threshold': 0.85}
        new_bad = {'threshold': 0.80, 'whyNotBatch': 'shadow/does-not-exist-xyz.md'}
        new_good = {'threshold': 0.80, 'whyNotBatch': real_rel}
        new_none = {'threshold': 0.80}

        def refused_with(obj):
            try:
                io.check_why_not_batch(obj, old, a.home)
                return None
            except io.WriteRefused as e:
                return str(e)
            except Exception as e:              # noqa: BLE001
                return '非预期异常 ' + type(e).__name__

        r_bad = refused_with(new_bad)
        r_none = refused_with(new_none)
        r_good = refused_with(new_good)
        check('T3-a 指向不存在的 artifact 必须拒写', r_bad is not None)
        check('T3-b 阈值变更但没写 whyNotBatch 必须拒写', r_none is not None)
        check('T3-c 指向真实 artifact 必须放行（%s）' % real_rel, r_good is None, r_good)
        check('T3-d 阈值没变时不要求 whyNotBatch', refused_with({'threshold': 0.85}) is None)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # ---- T4：citable 必须派生，不许手写 ----
    print('\n-- T4 citable 派生 --')
    stored = [(t, v.get('citable')) for t, v in raw.items() if isinstance(v, dict) and 'citable' in v]
    print('   候选：%d 个 tag 手写了 citable（应为 0）' % len(stored))
    check('T4-a 登记表里不许出现手写 citable', not stored, str(stored))
    if cands:
        val, why = io.derive_citable(raw[cands[0]])
        check('T4-b 派生值可由字段算出（%s -> %s）' % (cands[0], val), isinstance(val, bool) and bool(why), why)
        check('T4-c 派生理由必须带具体数值（noiseAppendNear=...）', bool(why) and any(ch.isdigit() for ch in why), why)
    else:
        unverified('T4-b 派生值可由字段算出', '没有可派生的 tag')

    # ---- T5：fitTruncated 不许被当 fit 读 ----
    print('\n-- T5 fitTruncated 不得当 fit 用 --')
    te = (raw.get('x-timeline') or {}).get('thresholdExtended') or {}
    print('   候选：fit=%s / fitTruncated=%s' % (list((te.get('fit') or {}).keys()), list((te.get('fitTruncated') or {}).keys())))
    raise_ok = None
    try:
        if te.get('fitTruncated'):
            r = list((te.get('fitTruncated') or {}).keys())[0].lstrip('R')
            io.get_fit(raw['x-timeline'], int(r))
            raise_ok = False
        else:
            raise_ok = None
    except io.TruncatedFitMisuse:
        raise_ok = True
    except Exception as e:                      # noqa: BLE001
        raise_ok = '非预期异常 ' + type(e).__name__
    if raise_ok is None:
        unverified('T5 截断值不得当 fit 读', '登记表里还没有 fitTruncated 字段（改名未做）')
    else:
        check('T5-a 读出截断值必须报错（指名 fitTruncated）', raise_ok is True, str(raise_ok))

    # ---- 汇总 ----
    fails = [r for r in results if not r[1]]
    print('\n结果：%d PASS / %d FAIL / %d UNVERIFIED' % (len(results) - len(fails), len(fails), len(skipped)))
    for label, why in skipped:
        print('  未校验：' + label + ' —— ' + str(why))
    if fails:
        print('  失败：')
        for label, _, detail in fails:
            print('   - ' + label + (('  [' + str(detail) + ']') if detail else ''))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
