#!/usr/bin/env python3
"""tune-preflight — 把 reflex 调优的纪律变成机器可检的前置检查。

为什么要它（2026-11-14 复盘）
  当天的 3 处硬违规（判据措辞没搬进实现 / state 截断 160 vs 1200 / 阈值没登记）
  和 7 步工具链缺失，全靠人记 + 被用户追问才发现。纪律写在 SKILL.md 里不起作用，
  必须让「不合规」在执行前直接报错。

做法
  每条 target 的判据文本、state 构造、阈值、标签、指纹结论都取指纹（sha256 前 16 位），
  与 `tools/shadow_targets.json` 里【上次验证时】登记的值比对：
    - 判据变了却没重拟合     → 阈值与结论失效（skill 坑 #1）
    - 标签变了却沿用旧数字   → 证书失效（2026-11-12 事故）
    - 指纹结论没绑定判据版本 → 结论不可引用（2026-11-14 发现）

用法
  python3 tools/tune-preflight.py --tag jev-friction
  python3 tools/tune-preflight.py --tag all
  python3 tools/tune-preflight.py --tag jev-friction --stamp   # 登记当前状态（改完并验证后跑）

退出码
  0 = 全通过；2 = 只有告警；3 = 有硬失败（结论不可引用）

判据两种书写风格都支持
  A  `OPTIONS = [` 段（x-timeline / arxiv）
  B  `QUESTION = / SHADOW_YES = / SHADOW_NO =`（jev-friction）
  旧 stamp-targets.py 只认 A，对 B 静默返回 None —— 这正是 11-14 那条漏检的成因。
"""
import argparse
import hashlib
import json
import os
import re
import sys

HOME = os.path.expanduser(os.environ.get("REFLEX_HOME", "~/.dsh/dsh-reflex"))
TF = os.path.join(HOME, "tools", "shadow_targets.json")

OK, WARN, FAIL = "PASS", "WARN", "FAIL"


def sha16(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def extract_rubric(target_path):
    """返回 (style, rubric_text, 说明)。取不到则返回 (None, None, 原因)。"""
    s = read(target_path)
    if s is None:
        return None, None, "target 文件不存在"

    m = re.search(r"^OPTIONS\s*=\s*\[", s, re.M)
    if m:
        i = m.start()
        j = s.find("\n]", i)
        seg = s[i:j + 2] if j > 0 else s[i:]
        return "options", seg, "OPTIONS 段"

    ys = re.search(r'^SHADOW_YES\s*=\s*"([^"]*)"', s, re.M)
    ns = re.search(r'^SHADOW_NO\s*=\s*"([^"]*)"', s, re.M)
    qs = re.search(r'^QUESTION\s*=\s*"([^"]*)"', s, re.M)
    if ys and ns:
        seg = "\x00".join([qs.group(1) if qs else "", ys.group(1), ns.group(1)])
        return "shadow", seg, "QUESTION/SHADOW_YES/SHADOW_NO"

    return None, None, "既无 OPTIONS 段也无 SHADOW_YES/NO 常量"


def extract_threshold(target_path):
    s = read(target_path) or ""
    for pat in (r'THRESHOLD:-([0-9.]+)', r'SEM_TH="\$\{[^:}]+:-([0-9.]+)\}"'):
        m = re.search(pat, s)
        if m:
            return float(m.group(1))
    return None


def extract_truncation(collector_path):
    """只认 snippet/state 赋值处的截断。

    2026-11-14 教训：早一版用任意 `[:N]` 匹配，把 x-timeline 采集器里
    `str(payload)[:200]` 这句错误日志当成了 state 截断 —— 与 state 无关却登记成事实。
    宁可报「找不到」，也不要猜。
    """
    s = read(collector_path)
    if not s:
        return None
    for pat in (r"snippet\s*=\s*[^\n]*?\[:(\d{2,5})\]",
                r"state\s*=\s*[^\n]*?\[:(\d{2,5})\]"):
        m = re.search(pat, s)
        if m:
            return int(m.group(1))
    return None


def count_positives(labels_path):
    n = pos = 0
    bad = 0
    for line in (read(labels_path) or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            d = json.loads(line)
        except Exception:
            bad += 1
            continue
        if "label" not in d:
            bad += 1
            continue
        n += 1
        pos += 1 if d["label"] == 1 else 0
    return n, pos, bad


def load_registry():
    s = read(TF)
    return json.loads(s) if s else {}


def save_registry(d):
    tmp = TF + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, TF)


def check_tag(tag, reg, args):
    """返回 [(level, check, message)]。"""
    out = []
    base = tag.replace("-replay2", "").replace("-replay", "")
    target = os.path.join(HOME, "targets", f"{base}.sh")
    collector = os.path.join(HOME, "collectors", f"{base}.sh")
    meta = reg.get(tag) or {}

    style, rubric, why = extract_rubric(target)
    if style is None:
        out.append((FAIL, "判据可提取", f"{why}（{target}）"))
        return out
    rh = sha16(rubric)
    out.append((OK, "判据可提取", f"{why} · hash={rh}"))

    thr = extract_threshold(target)
    reg_thr = meta.get("threshold")
    if thr is None:
        out.append((WARN, "阈值可提取", "target 里没找到阈值默认值"))
    elif reg_thr is None:
        out.append((FAIL, "阈值已登记", "registry 无 threshold"))
    elif abs(float(thr) - float(reg_thr)) > 1e-9:
        out.append((FAIL, "阈值与登记一致",
                    f"target={thr} ≠ registry={reg_thr}（登记的是上次验证值）"))
    else:
        out.append((OK, "阈值与登记一致", f"{thr}"))

    reg_oh = meta.get("optionsHash")
    if not reg_oh:
        out.append((FAIL, "判据已登记", "registry 无 optionsHash —— 结论无法判断对应哪版判据"))
    elif reg_oh != rh:
        out.append((FAIL, "判据未漂移", f"判据 hash 变了：登记 {reg_oh} → 现在 {rh}；必须重拟合阈值并重做证书"))
    else:
        out.append((OK, "判据未漂移", rh))

    trunc = extract_truncation(collector)
    if trunc is None:
        out.append((WARN, "state 截断可提取", "采集器里没找到 [:N] 截断"))
    else:
        reg_tr = meta.get("stateTruncation")
        if reg_tr is None:
            out.append((FAIL, "state 截断已登记", f"采集器 {trunc} 字未登记（校准与生产必须同域）"))
        elif int(reg_tr) != trunc:
            out.append((FAIL, "state 截断未变", f"登记 {reg_tr} → 现在 {trunc}；判据语义已变，须重拟合"))
        else:
            out.append((OK, "state 截断未变", f"{trunc} 字"))

    labels_file = os.path.join(HOME, meta.get("labelsFile") or f"shadow/labels-{base}.jsonl")
    n, pos, bad = count_positives(labels_file)
    if n == 0:
        out.append((WARN, "标签可用", f"{labels_file} 不存在或为空（纯规则 target 可不标）"))
    else:
        reg_lh = meta.get("labelsHash")
        lh = sha16(open(labels_file, "rb").read().decode("utf-8", "replace"))
        if reg_lh and reg_lh != lh:
            out.append((FAIL, "标签未变", f"labelsHash 变了：登记 {reg_lh} → 现在 {lh}；证书与阈值须重算"))
        elif not reg_lh:
            out.append((FAIL, "标签已登记", "registry 无 labelsHash"))
        else:
            out.append((OK, "标签未变", f"n={n} pos={pos}"))
        if pos < args.need_pos:
            out.append((FAIL, "正例数够下结论",
                        f"pos={pos} < {args.need_pos}；按 Clopper-Pearson 不足以下结论（skill：小样本不下结论）"))
        else:
            out.append((OK, "正例数够下结论", f"pos={pos} ≥ {args.need_pos}"))

    # 指纹结论必须与当前判据版本绑定
    # 纯规则 target（没有拟合阈值/证书、也没有标签）不做判据审计，直接标 N/A
    tune_claimed = bool(meta.get("operating") or meta.get("certificate") or n > 0)
    pc = meta.get("pc") or {}
    if not tune_claimed:
        out.append((OK, "指纹绑定当前判据", "N/A：纯规则 target 未声称拟合结论"))
    elif not pc.get("verdict"):
        out.append((FAIL, "指纹结论已登记", "registry 无 pc.verdict（判据敏感度未审计）"))
    elif pc.get("optionsHash") and pc["optionsHash"] != rh:
        out.append((FAIL, "指纹绑定当前判据",
                    f"指纹结论基于 {pc['optionsHash']}，当前判据 {rh}；结论不可引用，须重跑 pc_inject"))
    elif not pc.get("optionsHash"):
        out.append((FAIL, "指纹绑定当前判据", "pc 结论没记 optionsHash，无法判断版本"))
    elif pc["verdict"] == "fail" and not pc.get("accepted_risk"):
        out.append((FAIL, "指纹通过或已记录风险",
                    "指纹未通过且没有 accepted_risk 说明——已知限制必须写明才能引用阈值"))
    else:
        out.append((OK, "指纹绑定当前判据", f"verdict={pc['verdict']}@{pc['optionsHash']}"))

    return out


def stamp(tag, reg):
    base = tag.replace("-replay2", "").replace("-replay", "")
    target = os.path.join(HOME, "targets", f"{base}.sh")
    collector = os.path.join(HOME, "collectors", f"{base}.sh")
    style, rubric, _ = extract_rubric(target)
    meta = reg.setdefault(tag, {})
    if rubric:
        meta["optionsHash"] = sha16(rubric)
        meta["rubricStyle"] = style
    thr = extract_threshold(target)
    if thr is not None:
        meta["thresholdDefault"] = thr
    trunc = extract_truncation(collector)
    if trunc is not None:
        meta["stateTruncation"] = trunc
    lf = os.path.join(HOME, meta.get("labelsFile") or f"shadow/labels-{base}.jsonl")
    if os.path.exists(lf):
        meta["labelsHash"] = sha16(open(lf, "rb").read().decode("utf-8", "replace"))
    return meta


def main():
    global HOME
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="all", help="target 名，或 all")
    ap.add_argument("--home", default=HOME)
    ap.add_argument("--stamp", action="store_true", help="把当前状态登记进 shadow_targets.json")
    ap.add_argument("--need-pos", type=int, default=20,
                    help="下结论所需最少正例数（默认 20：够拟合一个工作点）")
    args = ap.parse_args()

    HOME = os.path.expanduser(args.home)
    reg = load_registry()
    tags = [t for t in reg if not t.endswith("-replay") and not t.endswith("-replay2")] \
        if args.tag == "all" else [args.tag]

    if args.stamp:
        for t in tags:
            m = stamp(t, reg)
            print(f"[stamp] {t}: options={m.get('optionsHash')} thr={m.get('thresholdDefault')} "
                  f"trunc={m.get('stateTruncation')} labels={m.get('labelsHash')}")
        save_registry(reg)
        return 0

    worst = 0
    for t in tags:
        rows = check_tag(t, reg, args)
        fails = sum(1 for lv, _, _ in rows if lv == FAIL)
        warns = sum(1 for lv, _, _ in rows if lv == WARN)
        head = "FAIL" if fails else ("WARN" if warns else "PASS")
        print(f"\n=== {t} — {head}（{fails} 硬失败 / {warns} 告警）")
        for lv, name, msg in rows:
            mark = {"PASS": "✓", "WARN": "!", "FAIL": "✗"}[lv]
            print(f"  {mark} {name:18} {msg}")
        if fails:
            worst = max(worst, 3)
        elif warns:
            worst = max(worst, 2)
    print(f"\n退出码 {worst}（0=全通过 2=仅告警 3=有硬失败：结论不可引用）")
    return worst


if __name__ == "__main__":
    sys.exit(main())
