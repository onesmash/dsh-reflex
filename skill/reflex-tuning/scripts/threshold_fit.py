#!/usr/bin/env python3
"""阈值拟合器: 用 shadow 数据 + 人工标注, 把"拍出来的阈值"换成"算出来的阈值"。

方法 (对应 shadow mode + value threshold)
  1. 影子策略记录了每个决策点的 p(yes), 包括当时被阈值挡掉的条目。
  2. 人工/ oracle 给抽样条目打标签 y ∈ {0,1}: 这条是否值得打断用户。
  3. 对候选阈值 τ, 期望效用
        ΔU(τ) = Σ_{s_i ≥ τ} [ y_i·R − 1 ],   R = (真阳价值 + 漏报代价) / 误报代价
     其中误报代价归一为 1; R 越大越怕漏报。τ* = argmax ΔU。
     注意: τ* 只依赖比值 R, 不依赖三个代价的绝对值。
  4. bootstrap 重采样给 τ* 的区间; 报告"当前阈值 vs 拟合阈值"的效用差。

只读 shadow/ 与标签文件, 不改任何配置。改阈值仍需人工执行 (见报告里的 apply 提示)。

用法
  # 1) 看分布
  python3 tools/threshold_fit.py --tag x-timeline
  # 2) 导出待标注样本 (分层: 边界带优先)
  python3 tools/threshold_fit.py --tag x-timeline --export-sample 120
  # 3) 有标签后拟合 (标签支持 idx 或 key)
  python3 tools/threshold_fit.py --tag x-timeline --ratios 2,4,8,16
"""
import argparse
import glob
import json
import os
import random
import statistics
import sys

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")


def load_shadow(home, tag, mode):
    files = sorted(glob.glob(os.path.join(home, "shadow", f"{tag}-*.jsonl")))
    by_key = {}
    for f in files:
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if mode != "both" and r.get("mode") != mode:
                        continue
                    if r.get("tag") != tag:
                        continue
                    if r.get("score") is None:
                        continue
                    # 同 key 保留最后一次 (回放重复跑以最新为准)
                    by_key[r["key"]] = r
        except FileNotFoundError:
            continue
    return list(by_key.values())


def load_labels(home, tag, path, idx_map=None):
    """标签文件: 每行 {"key": "...", "label": 0|1} 或 {"idx": N, "label": 0|1}
    或 {"id": "<原始id>", "score": ..., "label": 0|1}（item 级，2026-11-13 加）。

    item 级标签的来源是 wake_ledger.py --export-item-labels：它已把
    12 位 hash 反查回原始 id 并 join 上 shadow 分数。这里只要认识 "id" 字段。
    为什么要单独一条通道：批级标签的 key 是「整批 id 拼接后的 hash」，
    item 级标签的 key 是「单条 id 的 hash」，形式完全不同，不能混在一个 dict 里。
    """
    labs = {}
    item_labs = {}
    if not path:
        path = os.path.join(home, "shadow", f"labels-{tag}.jsonl")
    elif not os.path.isabs(path) and not os.path.exists(path):
        # 相对路径按 shadow 目录解析（2026-11-14：原来按 cwd，跑一次就静默「没有标签」）
        cand = os.path.join(home, "shadow", path)
        if os.path.exists(cand):
            path = cand
    if not os.path.exists(path):
        return labs
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            lab = o.get("label")
            if lab in (0, 1, "0", "1", True, False):
                lab = int(lab)
            else:
                continue
            # ⚠️ 顺序要紧（2026-11-13 踩过）：item 级标签的导出文件若同时带 idx，
            #    会先命中 idx_map（那是分层抽样 sample-<tag>.json 的序号表），
            #    把 item 标签错配到完全无关的 shadow key 上 —— 实测 46 条里
            #    45 条被错配成 batch 分支。所以 item 级必须最先判断。
            if o.get("item_id") or (o.get("scope") == "item" and o.get("id")):
                item_labs[str(o.get("item_id") or o["id"])] = lab
            elif "idx" in o and idx_map and int(o["idx"]) in idx_map:
                labs[idx_map[int(o["idx"])]] = lab
            elif o.get("id"):
                item_labs[str(o["id"])] = lab        # 无 idx 冲突时按 id 对齐
            elif o.get("key"):
                labs[o["key"]] = lab
    # 两套字典合并：批级用 key，item 级用 id。键空间不会撞
    # （shadow 的 key 是 16 位 hex，id 是 19 位数字）。
    labs.update(item_labs)
    return labs


def load_item_shadow(home, tag, mode="live"):
    """读 shadow 并把 id 作为主键（item 级标签只能靠 id 对齐，不能用 key）。
    返回 {id: {"id","score","state"}}，同 id 保留最后一次分数。
    """
    files = sorted(glob.glob(os.path.join(home, "shadow", f"{tag}-*.jsonl")))
    by_id = {}
    for f in files:
        base = os.path.basename(f)
        if base.startswith(("labels-", "sample-", "wake-", "ab-")):
            continue
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if mode != "both" and r.get("mode") != mode:
                        continue
                    tid = r.get("id")
                    if not tid or r.get("score") is None:
                        continue
                    by_id[str(tid)] = {"id": str(tid), "score": float(r["score"]),
                                       "state": r.get("state", "")}
        except FileNotFoundError:
            continue
    return by_id


def thresholds_of(scores, labels, ratios, weights=None, n_boot=400, seed=7):
    """对每个 R 拟合 τ*, 并给 bootstrap 区间 (权重用于还原分层抽样的总体)。"""
    pts = sorted(((s, y, (weights[i] if weights else 1.0)) for i, (s, y) in enumerate(zip(scores, labels))),
                 key=lambda t: t[0])
    cands = sorted({s for s, _, _ in pts})
    if not cands:
        return {}

    out = {}
    rng = random.Random(seed)
    n = len(pts)
    for R in ratios:
        def utility(tau, data):
            u = 0.0
            for s, y, w in data:
                if s >= tau:
                    u += w * ((R if y == 1 else 0.0) - 1.0)
            return u

        def fit(data):
            best_t, best_u = cands[0], None
            for tau in cands:
                u = utility(tau, data)
                if best_u is None or u > best_u:
                    best_t, best_u = tau, u
            return best_t, best_u

        tau, u = fit(pts)
        boots = []
        for _ in range(n_boot):
            sample = [pts[rng.randrange(n)] for _ in range(n)]
            t, _u = fit(sample)
            boots.append(t)
        boots.sort()
        lo = boots[int(0.05 * len(boots))] if boots else tau
        hi = boots[int(0.95 * len(boots)) - 1] if boots else tau
        out[R] = {"tau": tau, "ci90": [lo, hi], "utility": u}
    return out


def metrics_at(scores, labels, tau, weights=None):
    tp = fp = fn = tn = 0.0
    for i, (s, y) in enumerate(zip(scores, labels)):
        w = weights[i] if weights else 1.0
        wake = s >= tau
        if wake and y == 1:
            tp += w
        elif wake and y == 0:
            fp += w
        elif not wake and y == 1:
            fn += w
        else:
            tn += w
    prec = tp / (tp + fp) if tp + fp else None
    rec = tp / (tp + fn) if tp + fn else None
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": prec, "recall": rec}


def utility_at(scores, labels, tau, R, weights=None):
    u = 0.0
    for i, (s, y) in enumerate(zip(scores, labels)):
        if s >= tau:
            w = weights[i] if weights else 1.0
            u += w * ((R if y == 1 else 0.0) - 1.0)
    return u


def compact_state(state, limit=240):
    """去掉常量画像前缀, 压成一行, 便于人工标注时快速扫。"""
    body = state.split("\n\n", 1)[-1] if "\n\n" in state else state
    body = " | ".join(x.strip() for x in body.splitlines() if x.strip())
    return body[:limit]


def export_sample(home, tag, items, n, band=(0.5, 0.96), seed=11):
    rng = random.Random(seed)
    picked = []                                   # [(record, 权重)]
    if n >= len(items):
        picked = [(r, 1.0) for r in items]
    else:
        band_items = [r for r in items if band[0] <= r["score"] <= band[1]]
        rest = [r for r in items if not (band[0] <= r["score"] <= band[1])]
        k_band = min(len(band_items), int(n * 0.75))
        k_rest = min(len(rest), n - k_band)
        # 分层抽样: 入选概率不同, 权重 = 1/入选概率, 才能还原总体
        if k_band:
            wb = len(band_items) / k_band
            picked += [(r, wb) for r in rng.sample(band_items, k_band)]
        if k_rest:
            wr = len(rest) / k_rest
            picked += [(r, wr) for r in rng.sample(rest, k_rest)]
    picked.sort(key=lambda t: t[0]["score"])
    rng.shuffle(picked)                           # 打乱顺序, 避免按分数锚定
    rng.shuffle(picked)                       # 打乱顺序, 避免按分数锚定
    out_txt = os.path.join(home, "shadow", f"sample-{tag}.tsv")
    out_map = os.path.join(home, "shadow", f"sample-{tag}.json")
    manifest = []
    with open(out_txt, "w", encoding="utf-8") as fh:
        fh.write("idx\tscore\tstate\n")
        for i, (r, w) in enumerate(picked, 1):
            manifest.append({"idx": i, "key": r["key"], "w": round(w, 6)})
            fh.write(f"{i}\t{r['score']:.4f}\t{compact_state(r['state'])}\n")
    json.dump({"items": manifest}, open(out_map, "w"), ensure_ascii=False)
    print(f"导出 {len(picked)} 条 → {out_txt} (idx→key 映射: {out_map})")
    print("标注结果写成 shadow/labels-%s.jsonl: 每行 {\"idx\": N, \"label\": 0|1}" % tag)
    return out_txt


def fmt_pct(x):
    return "-" if x is None else f"{x*100:.1f}%"


def cp_lower_safe(k, n, alpha=0.05):
    """CP 单侧下界; cp_lower 不可用时返回 None。

    返回 None 必须显式判, 不能当成「通过」—— 否则又是静默兜底。
    """
    if not n or k is None:
        return None
    try:
        from risk_certificate import cp_lower
        return cp_lower(k, n, alpha)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="x-timeline")
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--mode", default="replay", choices=["replay", "live", "both"])
    ap.add_argument("--labels", default="")
    ap.add_argument("--ratios", default="2,4,8,16")
    ap.add_argument("--current-threshold", type=float, default=None)
    ap.add_argument("--export-sample", type=int, default=0)
    ap.add_argument("--report", default="")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--need-pos", type=int, default=20,
                    help="下结论所需最少正例数；不足则报告标注『临时值』并退出码 2")
    ap.add_argument("--allow-small", action="store_true",
                    help="正例不足也当结论用（会写进报告，供审计）")
    ap.add_argument("--target-precision", type=float, default=0.80,
                    help="证书门禁: 当前阈值处 precision 的 CP 单侧 95% 下界低于此值 → 退出码 3"
                         "（默认 0.80，即开启；报告先落盘再返回）")
    ap.add_argument("--allow-uncertified", action="store_true",
                    help="证书门禁不通过也放行（会写进报告与 json，供审计；不要用它绕开真实不达标）")
    a = ap.parse_args()

    items = load_shadow(a.home, a.tag, a.mode)
    if not items:
        print(f"shadow 里没有 {a.tag} 的 {a.mode} 数据", file=sys.stderr)
        return 2
    items.sort(key=lambda r: r["ts"])
    scores_all = [r["score"] for r in items]

    cfg_threshold = None
    try:
        cfg = json.load(open(os.path.join(a.home, "tools", "shadow_targets.json"), encoding="utf-8"))
        cfg_threshold = (cfg.get(a.tag) or {}).get("threshold")
    except Exception:
        pass
    cur = a.current_threshold if a.current_threshold is not None else cfg_threshold

    if a.export_sample:
        export_sample(a.home, a.tag, items, a.export_sample)
        return 0

    # 分布
    qs = statistics.quantiles(scores_all, n=10) if len(scores_all) >= 10 else []
    dist = {
        "n": len(items),
        "min": round(min(scores_all), 4),
        "max": round(max(scores_all), 4),
        "median": round(statistics.median(scores_all), 4),
        "deciles": [round(x, 4) for x in qs] if qs else None,
        "at_or_above_current": (sum(1 for s in scores_all if s >= cur) if cur is not None else None),
        "current_threshold": cur,
        "score_hist": {f"{lo:.2f}-{lo+0.1:.2f}": sum(1 for s in scores_all if lo <= s < lo + 0.1)
                       for lo in [i / 10 for i in range(10)]},
    }

    idx_map = {}
    weights = {}
    sample_map = os.path.join(a.home, "shadow", f"sample-{a.tag}.json")
    if os.path.exists(sample_map):
        try:
            raw = json.load(open(sample_map))
            if isinstance(raw, dict) and "items" in raw:      # 新格式: 带抽样权重
                for it in raw["items"]:
                    idx_map[int(it["idx"])] = it["key"]
                    weights[it["key"]] = float(it.get("w") or 1.0)
            else:                                             # 旧格式: idx -> key
                idx_map = {int(k): v for k, v in raw.items()}
        except Exception:
            pass

    labels = load_labels(a.home, a.tag, a.labels, idx_map)
    # 标签对齐支持两种粒度（2026-11-13）：
    #   ① 批级（历史默认）：labels 的键是「整批 id 拼接后 sha1」，对 shadow 的 key。
    #   ② item 级：labels 的键是原始 id，对 shadow 的 id。
    # 两种都要认，否则加了 item 级标签之后旧标签会突然全部失效。
    def _label_of(r):
        if r["key"] in labels:
            return labels[r["key"]], "batch"
        tid = r.get("id")
        if tid is not None and str(tid) in labels:
            return labels[str(tid)], "item"
        return None, None

    labeled = []
    _scopes = {"batch": 0, "item": 0}
    for r in items:
        lab, scope = _label_of(r)
        if lab is None:
            continue
        _scopes[scope] = _scopes.get(scope, 0) + 1
        labeled.append((r, lab))
    lab_scores = [r["score"] for r, _ in labeled]
    lab_labels = [lab for _, lab in labeled]
    lab_w = [weights.get(r["key"], 1.0) for r, _ in labeled]

    summary = {"tag": a.tag, "mode": a.mode, "dist": dist, "labeled": len(labeled),
               "label_scopes": dict(_scopes)}
    report = []
    report.append(f"# 阈值拟合报告 · {a.tag} ({a.mode})\n")
    report.append(f"- 样本: **{dist['n']}** 条打分; 分数中位数 {dist['median']}, 范围 {dist['min']}–{dist['max']}")
    if cur is not None:
        report.append(f"- 当前阈值 **{cur}**: 通过 {dist['at_or_above_current']} 条 "
                      f"({fmt_pct(dist['at_or_above_current']/dist['n'])})")
    report.append("")
    report.append("## 分数分布 (每 0.1 分桶)\n")
    report.append("| 区间 | 条数 |\n|---|---|")
    for k, v in dist["score_hist"].items():
        report.append(f"| {k} | {v} |")
    report.append("")

    if labeled:
        base = sum(lab_labels) / len(lab_labels)
        report.append(f"## 标注样本 (n={len(labeled)}, 正例率 {fmt_pct(base)})\n")
        if _scopes.get("item"):
            report.append(f"> 标签粒度: item 级 {_scopes.get('item', 0)} 条 / 批级 {_scopes.get('batch', 0)} 条。"
                          f"**item 级标签才反映单条价值；批级标签的键是整批哈希，"
                          f"正例会连带批内所有条目。**\n")
        if any(w != 1.0 for w in lab_w):
            report.append("> 分层抽样标注, 指标与效用已按 1/入选概率 加权, 可近似还原总体。\n")
        cur_m = metrics_at(lab_scores, lab_labels, cur, lab_w) if cur is not None else None
        if cur_m:
            report.append(f"**当前阈值 {cur}**: Precision {fmt_pct(cur_m['precision'])} / "
                          f"Recall {fmt_pct(cur_m['recall'])} "
                          f"(TP {cur_m['tp']} FP {cur_m['fp']} FN {cur_m['fn']} TN {cur_m['tn']})\n")
        ratios = [float(x) for x in a.ratios.split(",") if x.strip()]
        fits = thresholds_of(lab_scores, lab_labels, ratios, lab_w)
        report.append("## 拟合结果 (R = (真阳价值+漏报代价)/误报代价)\n")
        report.append("| R | 拟合阈值 | 90% CI | 该阈值 Precision | Recall | 当前阈值效用 | 拟合效用 |")
        report.append("|---|---|---|---|---|---|---|")
        for R in ratios:
            f = fits[R]
            m = metrics_at(lab_scores, lab_labels, f["tau"], lab_w)
            u_cur = utility_at(lab_scores, lab_labels, cur, R, lab_w) if cur is not None else None
            report.append(
                f"| {R:g} | **{f['tau']:.3f}** | {f['ci90'][0]:.3f}–{f['ci90'][1]:.3f} | "
                f"{fmt_pct(m['precision'])} | {fmt_pct(m['recall'])} | "
                f"{'%.1f' % u_cur if u_cur is not None else '-'} | {f['utility']:.1f} |"
            )
        # 候选阈值的全量通过量 (不依赖标注) + 标注样本上的加权 P/R, 方便选工作点
        report.append("")
        report.append("## 工作点对比 (通过量按全量样本, P/R 按加权标注)\n")
        report.append("| 阈值 | 通过条数 | 占全量 | Precision | Recall | CP 下界(未加权) |")
        report.append("|---|---|---|---|---|---|")
        shown = sorted({round(f["tau"], 6) for f in fits.values()} | ({round(cur, 6)} if cur is not None else set()))
        for tau in shown:
            n_pass = sum(1 for r in items if r["score"] >= tau)
            m = metrics_at(lab_scores, lab_labels, tau, lab_w)
            mark = " **(当前)**" if cur is not None and abs(tau - cur) < 1e-9 else ""
            k_i = sum(1 for sc, ll in zip(lab_scores, lab_labels) if sc >= tau and ll == 1)
            n_i = sum(1 for sc in lab_scores if sc >= tau)
            lb_i = cp_lower_safe(k_i, n_i)
            report.append(f"| {tau:.3f}{mark} | {n_pass} | {fmt_pct(n_pass/dist['n'])} | "
                          f"{fmt_pct(m['precision'])} | {fmt_pct(m['recall'])} | {fmt_pct(lb_i)} |")
        # 固定基线 (路由评测教训: 必须给出 always-wake / always-suppress / 同量随机对照,
        # 否则"模型比阈值好"可能只是选层构成差异)
        if cur is not None:
            k_cur = sum(1 for s in lab_scores if s >= cur)
            base = sum(lab_labels) / len(lab_labels)
            m_cur = metrics_at(lab_scores, lab_labels, cur)
            report.append("## 基线对照 (未加权, 标注样本)\n")
            report.append("| 策略 | 唤醒数 | Precision | Recall |")
            report.append("|---|---|---|---|")
            report.append(f"| 全唤醒 always-wake | {len(lab_labels)} | {fmt_pct(base)} | 100.0% |")
            report.append("| 全压制 always-suppress | 0 | - | 0.0% |")
            report.append(f"| 同量随机 (期望) | {k_cur} | {fmt_pct(base)} | {fmt_pct(k_cur/len(lab_labels))} |")
            report.append(f"| 当前阈值 {cur:g} | {k_cur} | {fmt_pct(m_cur['precision'])} | {fmt_pct(m_cur['recall'])} |")
            report.append("")
        report.append("")
        summary["fits"] = {f"{k:g}": v for k, v in fits.items()}
        if cur is not None:
            summary["current_metrics"] = cur_m
    else:
        report.append("## 还没有标签\n")
        report.append("先用 `--export-sample 120` 导出样本, 标完写进 "
                      f"`shadow/labels-{a.tag}.jsonl` 再跑一次。\n")

    # ---------- 样本量门禁（O9, 2026-11-14）----------
    # 为什么：45 条样本 8 个正例就定阈值的教训。skill 写着「小样本不下结论」，
    # 但工具不拦就等于没写。这里直接算出「按当前样本能声称的下界」并给退出码。
    if labeled:
        n_pos = sum(lab_labels)
        cur_tau = cur if cur is not None else None
        tp = sum(1 for sc, lb in zip(lab_scores, lab_labels) if cur_tau is not None and sc >= cur_tau and lb == 1)
        fp = sum(1 for sc, lb in zip(lab_scores, lab_labels) if cur_tau is not None and sc >= cur_tau and lb == 0)
        lb = None
        try:
            from risk_certificate import cp_lower
            if tp + fp:
                lb = cp_lower(tp, tp + fp, 0.05)
        except Exception:
            lb = None
        report.append("\n## 样本量门禁 (O9)\n")
        report.append(f"- 标注样本 {len(labeled)} 条 · 正例 **{n_pos}** 条"
                      + (f" · 当前阈值 {cur_tau:g} 处 TP {tp} / FP {fp}" if cur_tau is not None else ""))
        if lb is not None:
            report.append(f"- 精确率单侧 95% 下界: **{fmt_pct(lb)}**（Clopper-Pearson，"
                          f"只对抽样分布成立）")
        need = a.need_pos
        if n_pos < need:
            report.append(f"- ⛔ **正例 {n_pos} < {need}**：本报告的阈值只能当【临时值】，"
                          f"不得作为「校准结论」引用")
            if not a.allow_small:
                summary["sample_gate"] = {"positives": n_pos, "need": need, "passed": False}
            else:
                report.append("- ⚠️ 已用 --allow-small 强制放行（结论需在审计里注明样本不足）")
                summary["sample_gate"] = {"positives": n_pos, "need": need, "passed": False,
                                          "forced": True}
        else:
            report.append(f"- ✓ 正例 {n_pos} ≥ {need}：可给一个工作点，但分档（kind/dup/offtopic）仍需更多")
            summary["sample_gate"] = {"positives": n_pos, "need": need, "passed": True}
        # 证书门禁 (2026-11-17): 把 CP 下界从「打印给人看」变成「可以拒绝的验收位」。
        # 只在显式给 --target-precision 时生效; 判据是下界, 不是点估计 ——
        # 用点估计选点会让每个误报都被 100% 的漂亮数字盖住。
        if a.target_precision is not None:
            g_ok = lb is not None and lb >= a.target_precision
            summary["certificate_gate"] = {
                "tau": cur_tau, "target": a.target_precision,
                "tp": tp, "wakes": tp + fp, "precision_lb": lb, "passed": g_ok,
            }
            if g_ok:
                report.append(f"- ✓ 证书门禁: 下界 {fmt_pct(lb)} ≥ 目标 {a.target_precision:.0%}")
            elif a.allow_uncertified:
                summary["certificate_gate"]["forced"] = True
                report.append(f"- ⚠️ **证书门禁未通过但已放行**（--allow-uncertified）："
                              f"下界 {fmt_pct(lb)} < 目标 {a.target_precision:.0%}"
                              f"（{tp}/{tp + fp}）→ 该工作点仍不可引用")
            else:
                report.append(f"- ⛔ **证书门禁**: 下界 {fmt_pct(lb)} < 目标 "
                              f"{a.target_precision:.0%}（{tp}/{tp + fp}）→ 该工作点不可引用")
        report.append("")

    report.append("\n## 怎么落地\n")
    report.append("- 改阈值: 优先改 `targets/<tag>.sh` 里的 `THRESHOLD=` 默认值 (热生效); "
                  "不要写 `targets/<tag>.env.json` (插件启动时读取, 要重启 DSH)")
    report.append("- 改完用同名 target 再回放一次 shadow 数据, 对比新旧阈值的通过条数")
    out = a.report or os.path.join(a.home, "shadow", f"report-{a.tag}.md")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf-8").write("\n".join(report) + "\n")
    summary["report"] = out
    if a.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print("\n".join(report))
        print(f"\n报告已写入 {out}")
    g = summary.get("sample_gate") or {}
    if g and not g.get("passed") and not a.allow_small:
        print("\n⛔ 样本量门禁未通过：阈值不可作为校准结论引用（加 --allow-small 可放行）",
              file=sys.stderr)
        return 2
    cg = summary.get("certificate_gate") or {}
    if labeled and a.target_precision is not None and not cg:
        print("\n⛔ 证书门禁无法判定（没有当前阈值）：报告已落盘，该工作点不可引用",
              file=sys.stderr)
        return 3
    if cg and not cg.get("passed"):
        if a.allow_uncertified:
            print(f"\n⚠️ 证书门禁未通过但已放行（--allow-uncertified）：τ={cg.get('tau')} 处下界 "
                  f"{fmt_pct(cg.get('precision_lb'))} < 目标 {cg.get('target'):.0%}"
                  f"（{cg.get('tp')}/{cg.get('wakes')}）；此结论不可引用",
                  file=sys.stderr)
            return 0
        print(f"\n⛔ 证书门禁未通过：τ={cg.get('tau')} 处 CP 单侧下界 "
              f"{fmt_pct(cg.get('precision_lb'))} < 目标 {cg.get('target'):.0%}"
              f"（{cg.get('tp')}/{cg.get('wakes')}）；报告已落盘，该阈值不可引用",
              file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
