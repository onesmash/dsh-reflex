#!/usr/bin/env python3
"""多维标签归因分析。

回答的问题：**负例为什么是负例**。
单维 0/1 下，内容无价值 / 重复 / 规则漏拦 都是 0，混在一起只能整体调阈值；
按维度拆开之后，「该改判据」还是「该加去重」才分得清。
"""
import argparse
import collections
import json
import os
import statistics
import sys

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")


def load_item_labels(home):
    """读 item 级标签 + 维度。"""
    path = os.path.join(home, "shadow", "wake-labels.jsonl")
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("scope") != "item":
            continue
        ik = o.get("item_key")
        if not ik:
            continue
        # 同一 item_key 可能有多条（旧的无维度、新的有维度，或重标）。
        # 必须按 at 取最新，否则退回最早那条 —— 实测就这么把 46 条有维度的
        # 标签读成了 0 条（全被更早的无维度记录覆盖）。
        prev = out.get(ik)
        if prev is None or int(o.get("at") or 0) >= int(prev.get("at") or 0):
            out[ik] = o
    return out


def load_scores(home, tag):
    """id -> score，从 shadow 取。"""
    import glob
    import hashlib
    score_of = {}
    for f in sorted(glob.glob(os.path.join(home, "shadow", f"*{tag}*.jsonl"))):
        base = os.path.basename(f)
        if base.startswith(("labels-", "sample-", "wake-", "ab-")):
            continue
        try:
            for line in open(f, encoding="utf-8", errors="replace"):
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                tid, sc = r.get("id"), r.get("score")
                if tid and sc is not None:
                    score_of[str(tid)] = float(sc)
        except OSError:
            continue
    return score_of


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--tag", default="x-timeline")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    labels = load_item_labels(a.home)
    if not labels:
        print("没有 item 级标签。先打标：", file=sys.stderr)
        print("  wake_label <key> 1 --kind tech --action act --dup 0 --why '...'", file=sys.stderr)
        return 2

    # item_key 就是原始 id（index.js 2026-11-13 起不做哈希：哈希不可逆，
    # 归因时要暴力比对全部 id 才能反查）。兼容早期 hash 形式。
    import hashlib
    score_of = load_scores(a.home, a.tag)
    hash_to_id = {hashlib.sha1(t.encode()).hexdigest()[:12]: t for t in score_of}

    rows = []
    for ik, rec in labels.items():
        tid = ik if ik in score_of else hash_to_id.get(ik)
        if not tid:
            continue
        dims = rec.get("dims") or {}
        rows.append({
            "id": tid,
            "score": score_of[tid],
            "label": int(rec.get("label", 0)),
            "dup": dims.get("dup"),
            "kind": dims.get("kind"),
            "action": dims.get("action"),
            "shelf": dims.get("shelf"),
            "offtopic": dims.get("offtopic"),      # 2026-11-13：内容有实料但方向不搭
            "why": rec.get("why", ""),
        })

    if not rows:
        print("标签存在但与 shadow 分数对不上（id 反查失败）", file=sys.stderr)
        return 2

    print(f"item 级标签 {len(rows)} 条，有维度的 "
          f"{sum(1 for r in rows if r['kind'] or r['dup'] is not None)} 条\n")

    # ---- 归因：负例为什么是负例 ----
    neg = [r for r in rows if r["label"] == 0]
    if neg:
        print("=" * 60)
        print("负例归因（回答：该改判据、加去重、还是不加任何规则）")
        print("=" * 60)
        # 三种原因分开（2026-11-13）：
        #   重复   → dup=1，该加去重
        #   无关   → offtopic=1（内容有实料但方向不搭），不该据此改判据
        #   内容差 → 其余，该改判据
        # 混在一起的后果：把 offtopic 也算进「判据失灵」，会误判判据质量。
        dup_n = sum(1 for r in neg if r["dup"] == 1)
        offtopic = [r for r in neg if r.get("offtopic") == 1 and r["dup"] != 1]
        rest = [r for r in neg if r["dup"] != 1 and r.get("offtopic") != 1]
        tot = len(neg) or 1
        print(f"  重复导致       {dup_n:3d} 条  ({dup_n / tot * 100:3.0f}%)  → 该加去重")
        print(f"  方向不搭       {len(offtopic):3d} 条  ({len(offtopic) / tot * 100:3.0f}%)  → 无需改判据，改相关性筛选")
        print(f"  内容本身无价值 {len(rest):3d} 条  ({len(rest) / tot * 100:3.0f}%)  → 该改判据")
        if rest:
            kinds = collections.Counter(r["kind"] for r in rest if r["kind"])
            if kinds:
                print("\n  内容差的类型分布：")
                for k, v in kinds.most_common():
                    print(f"    {k:8} {v:3d}")
        if offtopic:
            print("\n  方向不搭的条目（这些不该算判据的错）：")
            for r in offtopic[:6]:
                print(f"    {r['score']:.2f} {r.get('why', '')[:52]}")
        print()

    # ---- 分层评估：不同类型分别算 P/R ----
    print("=" * 56)
    print("分层评估（不同 kind 的分数是否有区分力）")
    print("=" * 56)
    by_kind = collections.defaultdict(list)
    for r in rows:
        by_kind[r["kind"] or "(未标)"].append(r)

    for kind, rs in sorted(by_kind.items(), key=lambda x: -len(x[1])):
        pos = [r["score"] for r in rs if r["label"] == 1]
        negs = [r["score"] for r in rs if r["label"] == 0]
        if not pos and not negs:
            continue
        pm = statistics.mean(pos) if pos else float("nan")
        nm = statistics.mean(negs) if negs else float("nan")
        delta = pm - nm if pos and negs else float("nan")
        flag = ""
        if pos and negs:
            if delta > 0.05:
                flag = " ← 分数有效"
            elif delta < -0.02:
                flag = " ← 分数反向"
            else:
                flag = " ← 分数无效"
        print(f"  {kind:8} n={len(rs):3d}  正例均分 {pm:.3f}  负例均分 {nm:.3f}  差 {delta:+.3f}{flag}")

    print()

    # ---- 时效分层 ----
    shelf = collections.Counter(r["shelf"] for r in rows if r["shelf"])
    if shelf:
        print("=" * 56)
        print("时效分布（支持按 shelf 分档推送）")
        print("=" * 56)
        for k, v in shelf.most_common():
            now_ = sum(1 for r in rows if r["shelf"] == k and r["label"] == 1)
            print(f"  {k:6} {v:3d} 条，其中正例 {now_}")
        print()

    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
