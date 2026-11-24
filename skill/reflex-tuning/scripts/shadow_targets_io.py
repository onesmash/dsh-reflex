#!/usr/bin/env python3
"""shadow_targets 读写层：计数是唯一真值源，派生指标一律现算。

为什么存在：登记表里同时有计数（certificate.tp/fp/fn）与派生副本
（precisionPoint / recallPoint / precisionLB / recallLB）。副本靠人手抄写，
一次抄错就与计数永久分叉，而且**没有任何工具读得出来**——2026-11-24 实测
x-timeline 的 recallPoint 存 0.856，而 132/(132+12)=0.9167。

本模块是 T1 的「单一真值源」实现，也是 T2/T3/T4/T5 的唯一入口：
  - 派生指标只由 counts_of() 现算，value() 不读副本（读不到计数就报错，不静默回落）
  - 标签文件缺 state_hash 一律拒读，豁免必须走 allow_legacy 并回报行数
  - 阈值变更必须有存在的 whyNotBatch artifact
  - citable 由 pc / positives / calibration 派生，手写值不采信
  - fitTruncated 不许当 fit 读

命令行（给人用的读取路径，不必手抄数字）：
  python3 shadow_targets_io.py --show x-timeline
  python3 shadow_targets_io.py --check        # exit 0 无漂移 / 1 有漂移 / 2 登记表读不到
"""
import argparse
import importlib.util
import json
import os
import sys

DEFAULT_HOME = os.environ.get('REFLEX_HOME') or os.path.expanduser('~/.dsh/dsh-reflex')
DERIVED_FIELDS = ('precisionPoint', 'recallPoint', 'precisionLB', 'recallLB')
# pc 噪声不变性门槛：pc.accepted_risk 写明「near 带 ≥85% 才可撤销该限制」
NOISE_INVARIANCE_GATE = 0.85
MIN_POSITIVES = 20


class ReadLayerError(Exception):
    """读层拒绝：宁可报错，不静默回落成旧副本。"""


class LabelsMissingStateHash(ReadLayerError):
    def __init__(self, path, missing, total):
        self.path, self.missing, self.total = path, missing, total
        super().__init__('标签文件缺 state_hash：%s（%d/%d 行）' % (path, missing, total))


class WriteRefused(ReadLayerError):
    pass


class TruncatedFitMisuse(ReadLayerError):
    pass


class CountsInconsistent(ReadLayerError):
    pass


def _load_risk_certificate():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'risk_certificate.py')
    spec = importlib.util.spec_from_file_location('risk_certificate_for_io', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_CP = None


def cp_lower(k, n, alpha=0.05):
    """Clopper-Pearson 单侧下界。复用 risk_certificate.py 的唯一实现，不另写一份。"""
    global _CP
    if _CP is None:
        _CP = _load_risk_certificate()
    return _CP.cp_lower(k, n, alpha)


def load_register(home=None, path=None):
    p = path or os.path.join(home or DEFAULT_HOME, 'tools', 'shadow_targets.json')
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def counts_of(obj):
    """取计数。返回 {tp,fp,fn,n_labeled,n_wake} 或 None（无计数即无法现算）。"""
    if not isinstance(obj, dict):
        return None
    src = None
    for cand in (obj.get('certificate'), obj.get('counts'), obj):
        if isinstance(cand, dict) and all(isinstance(cand.get(k), int) for k in ('tp', 'fp', 'fn')):
            src = cand
            break
    if src is None:
        return None
    tp, fp, fn = src['tp'], src['fp'], src['fn']
    n_wake = src.get('n_wake', tp + fp)
    n_labeled = src.get('n_labeled', tp + fn)
    if tp + fp != n_wake:
        raise CountsInconsistent('tp+fp=%d ≠ n_wake=%d' % (tp + fp, n_wake))
    # n_labeled 是「标注总数」，tp+fn 是其中的正例数（含未触发的漏报），只能是它的子集
    if tp + fn > n_labeled:
        raise CountsInconsistent('tp+fn=%d（正例）超过了 n_labeled=%d（标注总数）' % (tp + fn, n_labeled))
    if tp + fp > n_labeled:
        raise CountsInconsistent('触发的 tp+fp=%d 超过了标注总数 n_labeled=%d' % (tp + fp, n_labeled))
    return {'tp': tp, 'fp': fp, 'fn': fn, 'n_wake': n_wake,
            'n_labeled': n_labeled, 'positives': tp + fn}


def derived_of(obj):
    """由计数现算派生指标。没有计数就报错——不许回落成副本。"""
    c = counts_of(obj)
    if not c:
        raise ReadLayerError('没有可复算计数，派生值无法现算（不许读副本）')
    tp, fp, fn = c['tp'], c['fp'], c['fn']
    return {
        'precisionPoint': tp / float(tp + fp) if tp + fp else None,
        'recallPoint': tp / float(tp + fn) if tp + fn else None,
        'precisionLB': cp_lower(tp, tp + fp) if tp + fp else None,
        'recallLB': cp_lower(tp, tp + fn) if tp + fn else None,
    }


def value(obj, field):
    """读派生值的唯一入口。"""
    if field not in DERIVED_FIELDS:
        raise ReadLayerError('不是派生字段：%s' % field)
    return derived_of(obj)[field]


def drift_of(obj, tol=5e-4):
    """副本与现算值的偏离。只报副本已存在且非空的字段。"""
    d = derived_of(obj)
    out = []
    for f in DERIVED_FIELDS:
        stored = obj.get(f)
        if stored is None:
            continue
        if abs(float(stored) - d[f]) > tol:
            out.append((f, stored, d[f]))
    return out


def with_counts(obj, counts):
    """写计数的动作：换掉计数并清掉派生副本（单一真值源下不再另存）。

    n_labeled 是标注总数（join 集），不是 tp+fn；只有 n_wake 会随 tp/fp 变。
    """
    out = dict(obj)
    cert = dict(obj.get('certificate') or {})
    n_wake = counts['tp'] + counts['fp']
    n_labeled = cert.get('n_labeled')
    if not isinstance(n_labeled, int):
        n_labeled = max(counts['tp'] + counts['fn'], n_wake)
    if n_wake > n_labeled:
        raise CountsInconsistent('新的 tp+fp=%d 超过了标注总数 n_labeled=%d' % (n_wake, n_labeled))
    cert.update({'tp': counts['tp'], 'fp': counts['fp'], 'fn': counts['fn'],
                 'n_wake': n_wake, 'n_labeled': n_labeled})
    out['certificate'] = cert
    for f in DERIVED_FIELDS:
        out.pop(f, None)
    return out


def derive_citable(obj):
    """citable = (噪声不变性达标) ∧ (正例足够) ∧ (校准可用)。返回 (bool, 理由含数值)。"""
    pc = obj.get('pc') or {}
    near = pc.get('noiseAppendNear')
    inv = pc.get('noiseAppendInvariance')
    inv_v = near if near is not None else inv
    pos = obj.get('positives')
    if not isinstance(pos, int):
        c = None
        try:
            c = counts_of(obj)
        except ReadLayerError:
            c = None
        pos = c['tp'] if c else None
    cal = obj.get('calibration') or {}
    ece = cal.get('eceIsotonicCV')
    if ece is None:
        ece = cal.get('ecePlattCV')

    parts = []
    ok_inv = isinstance(inv_v, (int, float)) and inv_v >= NOISE_INVARIANCE_GATE
    parts.append('噪声不变性=%s %s %.2f' % (inv_v if inv_v is not None else '缺',
                                            '≥' if ok_inv else '<', NOISE_INVARIANCE_GATE))
    ok_pos = isinstance(pos, int) and pos >= MIN_POSITIVES
    parts.append('正例=%s %s %d' % (pos if pos is not None else '缺',
                                    '≥' if ok_pos else '<', MIN_POSITIVES))
    ok_cal = isinstance(ece, (int, float))
    parts.append('校准=%s' % (('CV ECE %.3f' % ece) if ok_cal else '缺'))
    # 噪声不变性缺字段时不得判 true：缺证据按不达标处理
    return (bool(ok_inv and ok_pos and ok_cal)), '；'.join(parts)


def get_fit(obj, R):
    """取 R 对应的拟合阈值。fitTruncated 里的值不许当 fit 用。"""
    te = obj.get('thresholdExtended') or {}
    key = 'R%d' % int(R)
    fit = te.get('fit') or {}
    trunc = te.get('fitTruncated') or {}
    if key in trunc:
        raise TruncatedFitMisuse('%s 在 fitTruncated 里（标注下界截断，不是最优点）：%.3f'
                                 % (key, trunc[key]))
    if key not in fit:
        raise ReadLayerError('%s 既不在 fit 也不在 fitTruncated' % key)
    return fit[key]


def check_why_not_batch(new_obj, old_obj=None, home=None):
    """阈值变更必须给出存在的 artifact 引用；一句话不算。"""
    home = home or DEFAULT_HOME
    if not isinstance(new_obj, dict) or 'threshold' not in new_obj:
        return
    old_thr = (old_obj or {}).get('threshold')
    new_thr = new_obj.get('threshold')
    changed = old_thr is None or abs(float(new_thr) - float(old_thr)) > 1e-9
    if not changed:
        return
    ref = (new_obj.get('whyNotBatch') or '').strip()
    if not ref:
        raise WriteRefused('阈值 %.3f→%.3f 变更缺少 whyNotBatch' % (float(old_thr or 0), float(new_thr)))
    if ('/' not in ref) and ('.' not in ref):
        raise WriteRefused('whyNotBatch 必须是可机检引用（路径或 id），收到一句话：%r' % ref[:60])
    p = ref if os.path.isabs(ref) else os.path.join(home, ref)
    if not os.path.exists(p):
        raise WriteRefused('whyNotBatch 指向的 artifact 不存在：%s' % p)


def load_labels(path, require_state_hash=True, allow_legacy=False):
    """标签读取层：缺 state_hash 拒读；豁免必须计数并回报。

    返回 (labels:dict, report:dict)
    """
    total = 0
    missing = 0
    labels = {}
    with open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            total += 1
            try:
                o = json.loads(line)
            except Exception:                   # noqa: BLE001
                continue
            if not (o.get('state_hash') or '').strip():
                missing += 1
            lab = o.get('label')
            if lab not in (0, 1, '0', '1', True, False):
                continue
            if o.get('key'):
                labels[str(o['key'])] = int(lab)
            elif o.get('id') is not None:
                labels[str(o['id'])] = int(lab)
            elif o.get('idx') is not None:
                labels[str(o['idx'])] = int(lab)
    if missing:
        if require_state_hash and not allow_legacy:
            raise LabelsMissingStateHash(path, missing, total)
        report = {'mode': 'legacy-exempt', 'legacy_nohash': missing, 'total': total}
        print('LEGACY-NOHASH  %s：%d/%d 行缺 state_hash（已显式豁免，须在报告里记一笔）'
              % (os.path.basename(path), missing, total), file=sys.stderr)
        return labels, report
    return labels, {'mode': 'strict', 'legacy_nohash': 0, 'total': total}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--home', default=DEFAULT_HOME)
    ap.add_argument('--register', default='')
    ap.add_argument('--show', default='')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    try:
        reg = load_register(a.home, a.register or None)
    except Exception as e:                      # noqa: BLE001
        print('登记表读不到：%s' % e, file=sys.stderr)
        return 2
    if a.show:
        obj = reg.get(a.show)
        if not isinstance(obj, dict):
            print('没有这个 tag：%s' % a.show, file=sys.stderr)
            return 2
        d = derived_of(obj)
        c = counts_of(obj)
        print('%s  计数 tp=%d fp=%d fn=%d' % (a.show, c['tp'], c['fp'], c['fn']))
        for k in DERIVED_FIELDS:
            stored = obj.get(k)
            print('  %-14s 现算 %.4f   副本 %s' % (k, d[k], '未存' if stored is None else stored))
        ok, why = derive_citable(obj)
        print('  citable=%s  (%s)' % (ok, why))
        return 0
    if a.check:
        bad = 0
        n = 0
        for tag, obj in reg.items():
            if not isinstance(obj, dict):
                continue
            try:
                dr = drift_of(obj)
            except ReadLayerError:
                continue
            n += 1
            for f, stored, recomputed in dr:
                bad += 1
                print('DRIFT  %s.%s 存 %s ≠ 算 %.4f' % (tag, f, stored, recomputed))
        print('可复算 tag：%d；漂移字段：%d' % (n, bad))
        return 1 if bad else 0
    ap.print_help()
    return 2


if __name__ == '__main__':
    sys.exit(main())
