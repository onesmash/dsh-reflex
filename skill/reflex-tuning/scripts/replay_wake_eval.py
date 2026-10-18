#!/usr/bin/env python3
"""唤醒级评估: 把回放里"会通过阈值"的条目聚成假设唤醒, 支持导出标注 / 计算唤醒级指标。

为什么要它
  live 唤醒一天只有几条, 攒到 30-40 条要一周。回放能把历史事实"重演"成假设唤醒:
  同一判据下 score>=阈值的条目按发布时间聚类 (间隔 > cluster-min 视为另一次唤醒),
  每个簇就是"如果当时用这个判据, L1 会叫醒 L2 的一次事件"。

唤醒级判定口径 (与 wake_ledger 一致)
  一次唤醒 label=1 iff 簇里至少有一条值得打断用户; 这是 W 级 OR 语义 ——
  单条 precision 低不代表这次唤醒来得不值 (一条好新闻夹两条噪音, 仍然值得叫)。

用法
  # 导出待标唤醒
  python3 tools/replay_wake_eval.py --tag xtl-v2b --export /tmp/replay-wakes.jsonl
  # 标注文件每行 {"wake_id": "replay:2026-10-17T03:05", "label": 0|1, "note": "..."}
  python3 tools/replay_wake_eval.py --tag xtl-v2b --labels /tmp/replay-wake-labels.jsonl --report
"""
import argparse
import glob
import json
import os
import sys
import time

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")


def iso_to_ms(ts):
    import calendar
    try:
        base = calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
        frac = ts[20:23] if len(ts) > 20 and ts[19] == "." else "0"
        return base + int((frac or "0").ljust(3, "0"))
    except Exception:
        return None


def posted_ms(state):
    import re
    m = re.search(r"发布时间: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)", str(state or ""))
    if not m:
        return None
    return iso_to_ms(m.group(1))


def item_brief(state, n=160):
    body = str(state or "").split("\n\n", 1)[-1] if "\n\n" in str(state or "") else str(state or "")
    body = " | ".join(x.strip() for x in body.splitlines() if x.strip())
    return body[:n]


def load_cfg(home, tag):
    try:
        cfg = json.load(open(os.path.join(home, "tools", "shadow_targets.json"), encoding="utf-8"))
        e = cfg.get(tag) or {}
        return e
    except Exception:
        return {}


def load_passed(home, tag, thr):
    rows = {}
    for f in glob.glob(os.path.join(home, "shadow", f"{tag}-*.jsonl")):
        b = os.path.basename(f)
        if b.startswith(("labels-", "sample-", "wake-", "ab-")):
            continue
        for line in open(f, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("tag") != tag or r.get("mode") != "replay":
                continue
            if r.get("score") is None or r["score"] < thr:
                continue
            pm = posted_ms(r.get("state"))
            if pm is None:
                continue
            rows[(r.get("key") or r.get("id"))] = {"score": r["score"], "posted_ms": pm,
                                                   "text": item_brief(r.get("state")), "id": r.get("id")}
    return [v for v in rows.values() if v]


def cluster(items, gap_min):
    items.sort(key=lambda x: x["posted_ms"])
    out, cur = [], []
    for it in items:
        if cur and it["posted_ms"] - cur[-1]["posted_ms"] > gap_min * 60_000:
            out.append(cur)
            cur = []
        cur.append(it)
    if cur:
        out.append(cur)
    return out


def wake_id(group):
    t = time.strftime("%Y-%m-%dT%H:%M", time.localtime(group[0]["posted_ms"] / 1000))
    return f"replay:{t}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="xtl-v2b")
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--cluster-min", type=float, default=30.0)
    ap.add_argument("--export", default="")
    ap.add_argument("--labels", default="")
    ap.add_argument("--report", default="")
    a = ap.parse_args()

    cfg = load_cfg(a.home, a.tag)
    thr = cfg.get("threshold")
    if thr is None:
        print("shadow_targets.json 里没有该 tag 的 threshold", file=sys.stderr)
        return 2
    items = load_passed(a.home, a.tag, float(thr))
    if not items:
        print("没有回放通过条目", file=sys.stderr)
        return 2
    groups = cluster(items, a.cluster_min)
    wakes = [{"wake_id": wake_id(g), "n": len(g), "ts": g[0]["posted_ms"],
              "items": [{"id": it["id"], "score": it["score"], "text": it["text"]} for it in g]}
             for g in groups]
    print(f"回放通过条目 {len(items)} 条 -> 假设唤醒 {len(wakes)} 个 (阈值 {thr}, 聚类间隔 {a.cluster_min:g} 分钟)")

    if a.export:
        with open(a.export, "w", encoding="utf-8") as fh:
            for w in wakes:
                fh.write(json.dumps(w, ensure_ascii=False) + "\n")
        print(f"已导出 {a.export}")
        return 0

    labels = {}
    if a.labels and os.path.exists(a.labels):
        for line in open(a.labels, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            lab = o.get("label")
            if lab in (0, 1, "0", "1", True, False):
                labels[o.get("wake_id")] = int(lab)
    labeled = [w for w in wakes if w["wake_id"] in labels]
    if not labeled:
        print("没有匹配的唤醒级标签 (先 --export 再写 labels)", file=sys.stderr)
        return 2
    pos = sum(1 for w in labeled if labels[w["wake_id"]] == 1)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import risk_certificate as rc
    lo = rc.cp_lower(pos, len(labeled), 0.05)
    hi = rc.cp_upper(pos, len(labeled), 0.05)
    rep = [f"# 回放构造唤醒评估 · {a.tag} @ τ={thr}\n",
           f"- 假设唤醒 {len(wakes)} 个 · 已标注 {len(labeled)} 个 · 正例 {pos} 个（{pos/len(labeled)*100:.1f}%）",
           f"- 唤醒级 precision 95% 单侧区间 [{lo*100:.1f}%, {hi*100:.1f}%]",
           "", "## 逐次唤醒\n", "| wake_id | 条目数 | 标签 | 最高分条目标题 |", "|---|---|---|---|"]
    for w in labeled:
        top = max(w["items"], key=lambda it: it["score"])
        rep.append(f"| {w['wake_id']} | {w['n']} | {labels[w['wake_id']]} | {top['text'][:70]} |")
    rep += ["", "> 回放构造的唤醒不是线上自然抽样：它是「同一判据 + 历史事实」的重演，",
            "> 标签仍是 L2 代理判断；用于在 live 样本攒够前看方向，不替代 live 证书。"]
    out = a.report or os.path.join(a.home, "shadow", f"replay-wakes-{a.tag}.md")
    open(out, "w", encoding="utf-8").write("\n".join(rep) + "\n")
    print("\n".join(rep))
    print(f"\n报告已写入 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
