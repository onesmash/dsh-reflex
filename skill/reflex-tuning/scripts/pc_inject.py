#!/usr/bin/env python3
"""Predictable-Change 注入器: 用"逻辑预期明确的扰动"检验 L1 判据的因果敏感度。

思路来自 CausalCoT (arXiv:2610.31639) 的 Predictable Change 指标:
阈值拟合只证明"分数分得开", 本工具证明"分数因为对的原因而移动"——
对真实 shadow 判定的 state 做四种有明确预期的变换, 原始/扰动各打一次分,
按算子聚合方向符合率与不变性符合率:

  strip_signal     删载荷留壳        期望 p(yes) 显著下降   (方向类)
  swap_irrelevant  正文换等长无关文本  期望 p(yes) 下降       (方向类)
  noise_append     追加无关噪声      期望 |Δp| ≈ 0          (不变类, 泄漏探测)
  shuffle_fields   字段重排          期望 |Δp| ≈ 0          (不变类)

不变类算子若显著移动分数 => 判定泄漏到无关内容 (判别式形态的 attention leakage)。

用法:
  python3 pc_inject.py --tag x-timeline --days 2026-10-24 --sample 100
  python3 pc_inject.py --tag ai-policy --days all --sample 50 --eps 0.03

副作用: 只写 --out 目录 (默认 $REFLEX_HOME/shadow/pc/), 不动 facts / cursor / seen。
打分走 run_score.sh (本地 SemIf), 零 API 成本。
"""
import argparse
import hashlib
import json
import os
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")
DEFAULT_SCORE = os.path.expanduser("~/.agents/skills/semif-decide/scripts/run_score.sh")
DEFAULT_OPTIONS = [
    {"id": "yes", "description": "值得立即打断用户关注。"},
    {"id": "no", "description": "不紧急, 不必打扰。"},
    {"id": "insufficient", "description": "信息不足, 无法判断。"},
]

IRRELEVANT_CORPUS = [
    "本市本周以多云天气为主，周末气温小幅回升，适合户外活动。",
    "地铁十号线工作日早高峰发车间隔缩短至三分钟。",
    "社区图书馆新增一批科普读物，开放时间延长至晚上八点。",
    "本地农贸市场周末供应新鲜蔬菜，价格与上周基本持平。",
    "城市公园的银杏进入观赏期，吸引不少市民拍照。",
    "公交线路优化调整后，沿线居民出行更加便利。",
]
NOISE_BLOCK = (
    "【无关背景】今日城市交通运行平稳，公共设施维护正常，"
    "社区活动照常进行，天气以多云为主，无特殊事件需要关注。"
)


# ---------- 算子 (确定性纯函数, 作用于 state 字符串) ----------
def _split_state(state):
    idx = state.find("正文: ")
    if idx < 0:
        return state, None
    cut = idx + len("正文: ")
    return state[:cut], state[cut:]


def strip_signal(state):
    head, body = _split_state(state)
    if body is None:
        return state
    return head + "（内容已移除）"


def swap_irrelevant(state):
    head, body = _split_state(state)
    if body is None:
        return state
    h = int(hashlib_sha1(body), 16)
    text = IRRELEVANT_CORPUS[h % len(IRRELEVANT_CORPUS)]
    rep = (text * (max(1, len(body) // len(text)) + 1))[: max(len(body), 8)]
    return head + rep


def noise_append(state):
    return state + "\n\n" + NOISE_BLOCK


def shuffle_fields(state):
    m = re.match(r"^(.*?\n\n)(推文作者: [^\n]*\n)(发布时间: [^\n]*\n)(正文: .*)$", state, re.S)
    if not m:
        return state
    return m.group(1) + m.group(4) + "\n" + m.group(2).rstrip("\n") + "\n" + m.group(3).rstrip("\n")


def hashlib_sha1(text):
    import hashlib
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


KIND = {"strip_signal": "direction", "swap_irrelevant": "direction",
        "noise_append": "invariance", "shuffle_fields": "invariance"}

OPERATORS = {
    "strip_signal": (strip_signal, "direction"),
    "swap_irrelevant": (swap_irrelevant, "direction"),
    "noise_append": (noise_append, "invariance"),
    "shuffle_fields": (shuffle_fields, "invariance"),
}


# ---------- 采样与载入 ----------
def band_of(score):
    try:
        sc = float(score or 0)
    except Exception:
        sc = 0.0
    return "high" if sc >= 0.97 else ("near" if sc >= 0.85 else ("mid" if sc >= 0.5 else "low"))


def judge_fingerprint(per_op_rows, threshold=0.93):
    """决策区间判定: 只看 near(0.85-0.97)/high(>=0.97) 两带, mid/low 仅诊断。

    方向类: near 符合率 >= 0.90 且 high >= 0.95
    不变类: near 符合率 >= 0.85 且 high >= 0.95
    翻转率受记录离阈值的距离影响(记录越贴近 0.93 越容易翻), 只作诊断不作门禁。
    某带无样本时只用存在的带; 全部 n/a 的算子不参与 overall。
    """
    rules = {"direction": (0.90, 0.95), "invariance": (0.85, 0.95)}
    out = {"per_band": {}, "verdict": {}, "overall": None, "reasons": []}
    gated = False
    for op, rows in per_op_rows.items():
        if not rows:
            out["verdict"][op] = "n/a"
            continue
        kind = rows[0].get("kind") or KIND.get(op, "invariance")
        bands = {}
        for b in ("near", "high", "mid", "low"):
            sub = [r for r in rows if band_of(r.get("p_orig") if r.get("p_orig") is not None
                                              else r.get("recorded_score")) == b]
            if not sub:
                continue
            bands[b] = {
                "n": len(sub),
                "rate": sum(1 for r in sub if r["ok"]) / len(sub),
                "mean_delta": statistics.mean(r["delta_p"] for r in sub),
                "flip_rate": sum(1 for r in sub
                                 if (r["p_orig"] >= threshold) != (r["p_pert"] >= threshold)) / len(sub),
            }
        out["per_band"][op] = bands
        nr, hr = rules[kind]
        checks = []
        if "near" in bands:
            checks.append(bands["near"]["rate"] >= nr)
        if "high" in bands:
            checks.append(bands["high"]["rate"] >= hr)
        if not checks:
            out["verdict"][op] = "n/a"
            continue
        gated = True
        ok = all(checks)
        out["verdict"][op] = "pass" if ok else "fail"
        if not ok:
            out["overall"] = False
            out["reasons"].append(
                f"{op}({kind}) near={bands.get('near', {}).get('rate', float('nan')):.2f} "
                f"high={bands.get('high', {}).get('rate', float('nan')):.2f}")
    if gated and out["overall"] is None:
        out["overall"] = True          # 至少一个算子进过判定且全部通过
    return out


def _blob_ops(state):
    """单段 state(如纯标题)的算子族: 无字段可打乱, shuffle 不适用。"""
    def strip_sig(s):
        return "（内容已移除）"

    def swap_irr(s):
        h = int(hashlib_sha1(s), 16)
        text = IRRELEVANT_CORPUS[h % len(IRRELEVANT_CORPUS)]
        return (text * (max(1, len(s) // len(text)) + 1))[: max(len(s), 8)]

    return {"strip_signal": strip_sig, "swap_irrelevant": swap_irr, "noise_append": noise_append}


def ops_for_state(state, template="auto"):
    """按 state 形状选算子族。auto: 含 '正文: ' → fielded, 否则 blob。"""
    if template == "blob" or (template == "auto" and "正文: " not in state):
        return _blob_ops(state)
    return {op: fn for op, (fn, _kind) in OPERATORS.items()}


def load_shadow(home, tag, days):
    d = os.path.join(home, "shadow")
    if days == "all":
        files = sorted(os.path.join(d, f) for f in os.listdir(d)
                       if f.startswith(tag + "-") and f.endswith(".jsonl"))
    else:
        files = [os.path.join(d, f"{tag}-{days}.jsonl")]
    rows = []
    for f in files:
        if not os.path.exists(f):
            continue
        for line in open(f, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("state") and r.get("question"):
                rows.append(r)
    return rows


def sample_records(records, n, seed=7):
    seen, uniq = set(), []
    for r in records:
        h = r.get("state_hash") or r.get("key")
        if h in seen:
            continue
        seen.add(h)
        uniq.append(r)
    # 分数带分层: 地板/中段/近线/高分 —— 聚合指标必须避免被地板效应主导
    def band(r):
        try:
            sc = float(r.get("score") if r.get("score") is not None else r.get("p_yes") or 0)
        except Exception:
            sc = 0.0
        if sc >= 0.97:
            return "high"
        if sc >= 0.85:
            return "near"
        if sc >= 0.5:
            return "mid"
        return "low"

    buckets = {"high": [], "near": [], "mid": [], "low": []}
    for r in uniq:
        buckets[band(r)].append(r)
    rnd = random.Random(seed)
    for b in buckets.values():
        rnd.shuffle(b)
    order = ["near", "high", "low", "mid"]      # 近线优先(翻转最敏感), 依次填充
    picked = []
    for b in order:
        quota = n // len(order) + (1 if b == "near" else 0)
        picked += buckets[b][:quota]
    if len(picked) < n:
        chosen = {id(r) for r in picked}
        picked += [r for r in uniq if id(r) not in chosen][: n - len(picked)]
    return picked[:n]


def extract_options(target_script):
    try:
        src = open(target_script, encoding="utf-8").read()
        m = re.search(r"OPTIONS = (\[.*?\n\])", src, re.S)
        if m:
            raw = re.sub(r",(\s*[\]}])", r"\1", m.group(1))   # 列表尾逗号不是合法 JSON
            return json.loads(raw)
    except Exception:
        pass
    return json.loads(json.dumps(DEFAULT_OPTIONS))


# ---------- 打分与配对 ----------
def run_scorer(score_cmd, in_path, out_path):
    rc = subprocess.run([score_cmd, "--input", in_path, "--output", out_path],
                        capture_output=True, text=True)
    if rc.returncode != 0:
        sys.stderr.write(rc.stderr[-500:])
        raise SystemExit(f"pc_inject: 打分器失败 rc={rc.returncode}")


def p_yes_of(row):
    if row.get("p_yes") is not None:
        return float(row["p_yes"])
    ids = row.get("option_ids") or []
    probs = row.get("probabilities") or []
    if "yes" in ids:
        return float(probs[ids.index("yes")])
    return float(probs[0]) if probs else 0.0


def main():
    ap = argparse.ArgumentParser(description="Predictable-Change 注入器")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--days", default="all")
    ap.add_argument("--sample", type=int, default=100)
    ap.add_argument("--eps", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--target", default=None, help="OPTIONS 提取来源, 默认同 --tag")
    ap.add_argument("--score-cmd", default=DEFAULT_SCORE)
    ap.add_argument("--options-json", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--template", default="auto", choices=["auto", "fielded", "blob"])
    ap.add_argument("--snapshot-out", default=None, help="把实际采样记录写入快照目录, 供可复现复跑")
    ap.add_argument("--from-snapshot", default=None, help="跳过采样, 直接用快照文件记录")
    args = ap.parse_args()

    home = DEFAULT_HOME
    out_dir = args.out or os.path.join(home, "shadow", "pc")
    os.makedirs(out_dir, exist_ok=True)

    if args.from_snapshot:
        picked = []
        for line in open(args.from_snapshot, encoding="utf-8"):
            line = line.strip()
            if line:
                picked.append(json.loads(line))
        if not picked:
            raise SystemExit(f"pc_inject: 快照为空 {args.from_snapshot}")
    else:
        records = load_shadow(home, args.tag, args.days)
        if not records:
            raise SystemExit(f"pc_inject: shadow 无记录 tag={args.tag} days={args.days}")
        picked = sample_records(records, args.sample, args.seed)

    _keys = sorted(str(r.get("state_hash") or r.get("key") or r.get("id") or "") for r in picked)
    sample_hash = hashlib.sha256("\n".join(_keys).encode("utf-8")).hexdigest()[:12]
    if args.snapshot_out:
        os.makedirs(args.snapshot_out, exist_ok=True)
        snap_path = os.path.join(args.snapshot_out,
                                 f"pc-snapshot-{args.tag}-{time.strftime('%Y%m%d-%H%M%S')}.jsonl")
        with open(snap_path, "w", encoding="utf-8") as f:
            for r in picked:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"[snapshot] {snap_path}")

    target = args.target or args.tag
    tscript = os.path.join(home, "targets", f"{target}.sh")
    options = (json.load(open(args.options_json, encoding="utf-8"))
               if args.options_json else extract_options(tscript))

    candidates = []
    keyed = []            # [(key, record)] —— shadow 的 id 可能重复(位置索引), 载体键用采样序号
    key_ops = {}
    tmpl_count = {"fielded": 0, "blob": 0}
    for i, r in enumerate(picked):
        key = f"s{i}"
        keyed.append((key, r))
        ops = ops_for_state(r["state"], args.template)
        key_ops[key] = ops
        tmpl_count["fielded" if "正文: " in r["state"] else "blob"] += 1
        for op_name, fn in ops.items():
            candidates.append({"id": f"{key}:{op_name}", "state": fn(r["state"]),
                               "question": r["question"], "options": options})
        candidates.append({"id": f"{key}:orig", "state": r["state"],
                           "question": r["question"], "options": options})
    used_ops = [op for op in ("strip_signal", "swap_irrelevant", "noise_append", "shuffle_fields")
                if any(op in key_ops[k] for k in key_ops)]

    tmp_in = os.path.join(out_dir, f"pc-in-{args.tag}-{args.days}.jsonl")
    tmp_out = os.path.join(out_dir, f"pc-scores-{args.tag}-{args.days}.jsonl")
    with open(tmp_in, "w", encoding="utf-8") as f:
        for c in candidates:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    for stale in (tmp_out, tmp_out + ".summary.md"):
        if os.path.exists(stale):
            os.remove(stale)        # SemIf 打分器是 create-only, 重跑前必须清旧输出+summary
    run_scorer(args.score_cmd, tmp_in, tmp_out)
    scores = {}
    for line in open(tmp_out, encoding="utf-8"):
        line = line.strip()
        if line:
            r = json.loads(line)
            scores[r["id"]] = p_yes_of(r)

    per_op = {op: [] for op in used_ops}
    orig_errs = []
    raw_rows = []
    for key, r in keyed:
        rid = key
        p0 = scores.get(f"{rid}:orig")
        if p0 is None:
            continue
        if r.get("score") is not None:
            orig_errs.append(abs(p0 - float(r["score"])))
        for op_name, _fn in key_ops[key].items():
            kind = KIND[op_name]
            pp = scores.get(f"{rid}:{op_name}")
            if pp is None:
                continue
            delta = pp - p0
            ok = (delta < 0) if kind == "direction" else (abs(delta) < args.eps)
            per_op[op_name].append({"delta_p": delta, "ok": ok, "p_orig": p0, "p_pert": pp,
                                    "recorded_score": r.get("score")})
            raw_rows.append({"id": rid, "op": op_name, "kind": kind, "p_orig": round(p0, 4),
                             "p_pert": round(pp, 4), "delta_p": round(delta, 4),
                             "ok": ok, "recorded_score": r.get("score"),
                             "state_hash": r.get("state_hash")})

    lines = [f"# Predictable-Change 报告 · {args.tag} · {args.days}",
             "",
             f"- 样本: {len(picked)} · sample_hash={sample_hash} · ε={args.eps}",
             f"- 模板: {args.template} (fielded {tmpl_count['fielded']} / blob {tmpl_count['blob']})",
             f"- 打分器: `{args.score_cmd}`",
             ""]
    if orig_errs:
        lines.append(f"- 原分复现 MAE: {statistics.mean(orig_errs):.4f} ( fresh 打分 vs shadow 记录, "
                     "越低说明评分过程确定性越好 )")
        lines.append("")
    lines.append("| 算子 | 类型 | 符合率 | 平均 Δp | 翻转率 | n |")
    lines.append("|---|---|---|---|---|---|")
    leak_deltas = []
    for op_name in used_ops:
        kind = KIND[op_name]
        rows = per_op[op_name]
        if not rows:
            lines.append(f"| {op_name} | {kind} | **n/a** | - | - | 0 |")
            continue
        rate = sum(1 for r in rows if r["ok"]) / len(rows)
        mean_d = statistics.mean(r["delta_p"] for r in rows)
        flip = sum(1 for r in rows if (r["p_orig"] >= 0.93) != (r["p_pert"] >= 0.93)) / len(rows)
        label = "方向符合率" if kind == "direction" else "不变性符合率"
        lines.append(f"| {op_name} | {kind} | {label} **{rate * 100:.1f}%** | {mean_d:+.4f} | {flip * 100:.1f}% | {len(rows)} |")
        if kind == "invariance":
            leak_deltas += [r["delta_p"] for r in rows]

    # 分数带拆表: 地板效应的诚实呈现
    lines.append("")
    lines.append("### 按基线分数带（<0.5 地板 / 0.5-0.85 中段 / 0.85-0.97 近线 / ≥0.97 高分）")
    lines.append("")
    lines.append("| 带 | 算子 | 符合率 | 平均 Δp | n |")
    lines.append("|---|---|---|---|---|")
    for b in ("near", "high", "mid", "low"):
        for op_name in used_ops:
            rows = [r for r in per_op[op_name] if band_of(r["p_orig"]) == b]
            if not rows:
                continue
            rate = sum(1 for r in rows if r["ok"]) / len(rows)
            mean_d = statistics.mean(r["delta_p"] for r in rows)
            lines.append(f"| {b} | {op_name} | **{rate * 100:.1f}%** | {mean_d:+.4f} | {len(rows)} |")
    if leak_deltas:
        leak = statistics.pstdev(leak_deltas) if len(leak_deltas) > 1 else 0.0
        lines.append("")
        lines.append(f"- **泄漏指数** (不变类 Δp 标准差): {leak:.4f} —— 越接近 0 越好; "
                     "偏高说明判定受无关内容影响 (判别式形态的 attention leakage)")
    jf = judge_fingerprint(per_op)
    parts = []
    for op_name in used_ops:
        v = jf["verdict"].get(op_name, "n/a")
        if v == "pass":
            parts.append(f"{op_name} ✓")
        elif v == "fail":
            near_r = jf["per_band"].get(op_name, {}).get("near", {}).get("rate")
            parts.append(f"{op_name} ✗" + (f"({near_r * 100:.0f}%)" if near_r is not None else ""))
        else:
            parts.append(f"{op_name} n/a")
    lines.append("")
    lines.append("- **判据指纹（决策区间判定: near/high 加权）**: " + ", ".join(parts))
    _ov = jf["overall"]
    lines.append("- **决策区间总判定**: " + ("通过" if _ov is True else ("不通过" if _ov is False else "无法判定（样本不含决策区间记录）")))
    if _ov is False:
        lines.append("  - 未过项: " + "; ".join(jf["reasons"]))
    lines.append("")
    lines.append("判读: 方向类 ✓ = 判据对信号敏感; 不变类 ✓ = 对无关内容钝感 (无泄漏). "
                 "mid/low 带仅诊断(地板效应); 翻转率取决于记录离阈值距离, 不作门禁.")

    raw_path = os.path.join(out_dir, f"pc-raw-{args.tag}-{args.days}.jsonl")
    with open(raw_path, "w", encoding="utf-8") as f:
        for r in raw_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    md_path = os.path.join(out_dir, f"pc-report-{args.tag}-{args.days}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\n[written] {md_path}")
    print(f"[written] {raw_path}")


if __name__ == "__main__":
    main()
