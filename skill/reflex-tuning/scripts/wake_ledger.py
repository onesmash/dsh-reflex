#!/usr/bin/env python3
"""唤醒台账 + 结果标签: 把"叫了 L2 之后到底有没有用"变成可核对的数据。

为什么要这个
  shadow 记录的是"L1 给每条打了多少分、过没过阈值", 但过阈值之后呢？
  —— 插件可能投递失败、可能被安静时段攒着、可能 L2 看完没动作、也可能用户马上回了话。
  没有这层数据, 阈值拟合只能拿"我标的代理标签"当结果, 永远到不了论文里的 task-level 评估。

它做什么
  1. 从 dsh-reflex.log 解析每次唤醒/投递失败 (目标、时间、触发判据)
  2. 从 DSH 会话正文 (session.v4.jsonl.zstd) 里找投递确认、L2 的动作、以及**真实用户消息**
     (source.kind == "user") —— 用户是否在唤醒后 N 分钟内说话, 是唯一不需要我自评的结果信号
  3. 关联 shadow 记录, 带上当时命中的条目 (id/分数/正文摘要)
  4. 写出 shadow/wake-ledger.jsonl; 支持人工补标 (shadow/wake-labels.jsonl)

用法
  python3 tools/wake_ledger.py                  # 重建台账 + 打印统计
  python3 tools/wake_ledger.py --pending 10     # 最近未标注唤醒 (带条目与自动信号)
  python3 tools/wake_ledger.py --label "<wake_key>" 1 "note"
  python3 tools/wake_ledger.py --json           # 机器可读统计

信号口径 (弱信号, 只当参考, 不当真值)
  user_engaged_60m : 唤醒后 60 分钟内出现过真实用户消息
  l2_tool_calls_10m: 唤醒后 10 分钟内 L2 的工具调用数 (0 = 大概率没处理)
  delivery_confirmed: 会话正文里找到对应时间的唤醒注入消息
"""
import argparse
import calendar
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")
SESSIONS_ROOT = os.environ.get("DSH_SESSIONS_DIR") or os.path.expanduser("~/.dsh/sessions")
LOG_LINE = re.compile(r"^\[(?P<ts>[^\]]+)\]\s+(?P<rest>.*)$")
L1_LINE = re.compile(r"^L1\[(?P<target>[^\]]+)\]:\s*(?P<label>.*)$")
WAKE_LINE = re.compile(r'^L2: woken "(?P<bot>[^"]+)" \((?P<session>session-[0-9a-f-]+)\) via (?P<via>\S+)')


def iso_to_ms(ts):
    # 2026-10-18T04:24:04.261Z -> epoch ms (日志是 UTC)
    try:
        base = calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
        return base + int((ts[20:23] or "0").ljust(3, "0"))
    except Exception:
        return None


def parse_log(home):
    """返回 [(target, ts_ms, kind, label, session, bot, via)]，kind in wake/failed。"""
    path = os.path.join(home, "dsh-reflex.log")
    events = []
    last = {"target": None, "ts": None, "label": None}
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return events
    with fh:
        for line in fh:
            m = LOG_LINE.match(line.rstrip("\n"))
            if not m:
                continue
            ts = iso_to_ms(m.group("ts"))
            rest = m.group("rest")
            lm = L1_LINE.match(rest)
            if lm:
                last = {"target": lm.group("target"), "ts": ts, "label": lm.group("label")}
                if "投递失败" in lm.group("label"):
                    events.append({"target": lm.group("target"), "ts": ts, "kind": "failed",
                                   "label": lm.group("label"), "session": None, "bot": "Chief", "via": "sessionController"})
                continue
            wm = WAKE_LINE.match(rest)
            if wm:
                # 归属: 最近 120s 内的 L1 目标；没有就记 unknown
                tgt = last["target"] if last["target"] and last["ts"] and ts - last["ts"] <= 120_000 else "unknown"
                label = last["label"] if last["target"] == tgt else ""
                events.append({"target": tgt, "ts": ts, "kind": "wake", "label": label or "",
                               "session": wm.group("session"), "bot": wm.group("bot"), "via": wm.group("via")})
    # 同一秒内重复的 wake 行去重 (pending 合并会连发多条)
    dedup, out = set(), []
    for e in events:
        k = (e["target"], e["ts"] // 1000, e["kind"], e["label"])
        if k in dedup:
            continue
        dedup.add(k)
        out.append(e)
    out.sort(key=lambda e: e["ts"] or 0)
    return out


def session_file(session_id):
    pats = [
        os.path.join(SESSIONS_ROOT, "*", session_id, "session.v4.jsonl.zstd"),
        os.path.join(SESSIONS_ROOT, session_id, "session.v4.jsonl.zstd"),
        os.path.join(SESSIONS_ROOT, "*", session_id, "session.v4.jsonl"),
    ]
    for p in pats:
        hits = glob.glob(p)
        if hits:
            return hits[0]
    return None


def open_session(path):
    """流式读取会话 JSONL；.zstd 走 zstd -dc，测试可用未压缩 .jsonl。"""
    if path.endswith(".zstd"):
        p = subprocess.Popen(["zstd", "-dc", path], stdout=subprocess.PIPE, text=True,
                             encoding="utf-8", errors="replace")
        return p.stdout, p
    return open(path, encoding="utf-8", errors="replace"), None


def parse_transcript(path):
    """返回 {wake_injections:[(ms,text)], user_msgs:[ms], tool_calls:[ms]}。"""
    res = {"wake_injections": [], "user_msgs": [], "tool_calls": []}
    if not path:
        return res
    stream, proc = open_session(path)
    try:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            t = e.get("type")
            ms = e.get("time") or 0
            if t == "user/message":
                d = e.get("data") or {}
                txt = json.dumps(d.get("content") or [], ensure_ascii=False)
                if "分层智能体·L1·" in txt:
                    res["wake_injections"].append((ms, txt))
                src = (d.get("source") or {}).get("kind")
                if src == "user":
                    res["user_msgs"].append(ms)
            elif t == "agent/inbox/spliced":
                # 唤醒真正落进会话的形态: inbox 注入。会话忙时会晚一步变成 user/message,
                # 所以两种都要认 (2026-10-18: turn 进行中的唤醒晚了 21 分钟才冒出来)。
                d = e.get("data") or {}
                txt = json.dumps(d, ensure_ascii=False)
                if "分层智能体·L1·" in txt:
                    res["wake_injections"].append((ms, txt))
            elif t == "tool/call":
                res["tool_calls"].append(ms)
    finally:
        try:
            stream.close()
        except Exception:
            pass
        if proc:
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
    return res


def load_shadow_passed(home, tag):
    """tag 的全部"通过阈值"记录 (live 模式优先, 回放/校验数据排除)。"""
    rows = []
    for f in glob.glob(os.path.join(home, "shadow", f"{tag}-*.jsonl")):
        base = os.path.basename(f)
        if base.startswith(("labels-", "sample-", "wake-")):
            continue
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("tag") != tag or r.get("mode") not in ("live", "deploy-verify"):
                    continue
                if not r.get("passed"):
                    continue
                rows.append(r)
    rows.sort(key=lambda r: r.get("ts") or 0)
    return rows


POSTED_RE = re.compile(r"发布时间: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)")


def posted_ms(state):
    m = POSTED_RE.search(str(state or ""))
    if not m:
        return None
    try:
        return iso_to_ms(m.group(1))
    except Exception:
        return None


def shadow_cfg(home):
    try:
        return json.load(open(os.path.join(home, "tools", "shadow_targets.json"), encoding="utf-8"))
    except Exception:
        return {}


def load_replay_passed(home, tag):
    """回放记录 (同一判据), 按当前部署阈值过滤。用于没有 live shadow 的历史唤醒。"""
    cfg = shadow_cfg(home)
    entry = cfg.get(tag) or {}
    replay_tag = entry.get("replay_tag")
    thr = entry.get("threshold")
    if not replay_tag or thr is None:
        return [], thr
    out = []
    for f in glob.glob(os.path.join(home, "shadow", f"{replay_tag}-*.jsonl")):
        base = os.path.basename(f)
        if base.startswith(("labels-", "sample-", "wake-", "ab-")):
            continue
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("tag") != replay_tag or r.get("mode") != "replay":
                    continue
                if r.get("score") is None or r["score"] < thr:
                    continue
                out.append(r)
    out.sort(key=lambda r: r.get("ts") or 0)
    return out, thr


def item_brief(state, n=90):
    body = state.split("\n\n", 1)[-1] if "\n\n" in state else state
    body = " | ".join(x.strip() for x in body.splitlines() if x.strip())
    return body[:n]


def join_items(passed, ts, label, replay=None, threshold=None):
    """把唤醒和 shadow 里"通过的条目"对齐。安静时段合并的唤醒要往前找很久。"""
    if not passed and replay:
        # 历史唤醒没有 live shadow (影子是 2026-10-18 才上线的): 用同一判据的回放记录,
        # 按推文发布时间对齐 —— 回放记录的 ts 是回放时刻, 没有意义。
        wide = any(k in (label or "") for k in ("暂存", "合并", "安静时段"))
        span = (12 * 3600_000) if wide else (20 * 60_000)
        hits = []
        for r in replay:
            pm = posted_ms(r.get("state"))
            if pm is None:
                continue
            if ts - span <= pm <= ts + 120_000:
                hits.append(r)
        if hits:
            newest = max(posted_ms(r.get("state")) or 0 for r in hits)
            hits = [r for r in hits if (posted_ms(r.get("state")) or 0) >= newest - 60_000]
        return [{"id": r.get("id"), "score": r.get("score"), "key": r.get("key"),
                 "text": item_brief(str(r.get("state") or ""))} for r in hits]
    if not passed:
        return []
    wide = any(k in (label or "") for k in ("暂存", "合并", "安静时段"))
    lo = ts - (12 * 3600_000 if wide else 20 * 60_000)
    hi = ts + 120_000
    hits = [r for r in passed if lo <= (r.get("ts") or 0) <= hi]
    if wide and hits:
        # 只保留最后一次打分那一批 (时间最接近唤醒)
        newest = max(r.get("ts") or 0 for r in hits)
        hits = [r for r in hits if (r.get("ts") or 0) >= newest - 60_000]
    return [{"id": r.get("id"), "score": r.get("score"), "key": r.get("key"),
             "text": item_brief(str(r.get("state") or ""))} for r in hits]


def wake_key(e):
    return f"{e['target']}:{e['ts']}"


def load_labels(home):
    path = os.path.join(home, "shadow", "wake-labels.jsonl")
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("wake_key"):
                out[o["wake_key"]] = o
    return out


def rebuild(home):
    events = parse_log(home)
    # 会话正文按 session 解析一次
    transcripts = {}
    ledger = []
    shadow_cache = {}
    for e in events:
        if not e["ts"]:
            continue
        sid = e.get("session")
        if sid and sid not in transcripts:
            transcripts[sid] = parse_transcript(session_file(sid))
        tr = transcripts.get(sid) or {"wake_injections": [], "user_msgs": [], "tool_calls": []}
        ts = e["ts"]
        # 投递确认: ±180s 内存在唤醒注入
        inj = [x for x in tr["wake_injections"] if abs(x[0] - ts) <= 180_000]
        delivery_ts = min(inj, key=lambda x: abs(x[0] - ts))[0] if inj else None
        base = delivery_ts or ts
        tool_calls = [x for x in tr["tool_calls"] if base <= x <= base + 10 * 60_000]
        user_msgs_60 = [x for x in tr["user_msgs"] if base <= x <= base + 60 * 60_000]
        user_msgs_10 = [x for x in tr["user_msgs"] if base <= x <= base + 10 * 60_000]
        if e["target"] not in shadow_cache:
            shadow_cache[e["target"]] = load_shadow_passed(home, e["target"])
        replay_rows, thr = shadow_cache.get(("replay", e["target"]), (None, None))
        if replay_rows is None:
            replay_rows, thr = load_replay_passed(home, e["target"])
            shadow_cache[("replay", e["target"])] = (replay_rows, thr)
        rec = {
            "wake_key": wake_key(e),
            "ts": ts,
            "target": e["target"],
            "status": e["kind"],
            "trigger": e.get("label") or "",
            "session": sid,
            "delivery_confirmed": bool(inj),
            "delivery_ts": delivery_ts,
            "l2_tool_calls_10m": len(tool_calls),
            "user_engaged_60m": bool(user_msgs_60),
            "user_msg_10m": bool(user_msgs_10),
            "items": join_items(shadow_cache[e["target"]], ts, e.get("label") or "",
                                replay=replay_rows, threshold=thr),
        }
        ledger.append(rec)
    out = os.path.join(home, "shadow", "wake-ledger.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        for r in ledger:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    return ledger, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--pending", type=int, default=0)
    ap.add_argument("--pending-target", default="", help="只看某个 target 的待标唤醒")
    ap.add_argument("--pending-with-items", action="store_true", help="只看带条目明细的待标唤醒")
    ap.add_argument("--export-pending", default="", help="把未标注的唤醒导出成 JSONL, 交给标注")
    ap.add_argument("--label-batch", default="", help="导入 JSONL 标注文件 (每行 {wake_key,label,note?})")
    ap.add_argument("--report", default="", help="写出唤醒级标注报告 (markdown)")
    ap.add_argument("--label", nargs=2, metavar=("WAKE_KEY", "LABEL"), default=None)
    ap.add_argument("--note", default="")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    if a.label_batch:
        path = os.path.join(a.home, "shadow", "wake-labels.jsonl")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        n = 0
        with open(a.label_batch, encoding="utf-8") as fh, open(path, "a", encoding="utf-8") as out:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if not o.get("wake_key") or o.get("label") not in (0, 1, "0", "1", True, False):
                    continue
                out.write(json.dumps({"wake_key": o["wake_key"], "label": int(o["label"]),
                                      "note": o.get("note", ""), "labeled_by": o.get("labeled_by", "L2"),
                                      "at": int(time.time() * 1000)}, ensure_ascii=False) + "\n")
                n += 1
        print(f"导入 {n} 条标注 -> {path}")
        return 0

    if a.label:
        key, lab = a.label
        try:
            lab = int(lab)
        except ValueError:
            print("label 只能是 0 或 1", file=sys.stderr)
            return 2
        path = os.path.join(a.home, "shadow", "wake-labels.jsonl")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"wake_key": key, "label": lab, "note": a.note,
                                 "labeled_by": "L2", "at": int(time.time() * 1000)}, ensure_ascii=False) + "\n")
        print(f"已标注 {key} -> {lab}")
        return 0

    ledger, out = rebuild(a.home)
    labels = load_labels(a.home)
    for r in ledger:
        if r["wake_key"] in labels:
            r["label"] = labels[r["wake_key"]]["label"]

    if a.export_pending:
        pend = [r for r in ledger if "label" not in r]
        if a.pending_target:
            pend = [r for r in pend if r["target"] == a.pending_target]
        if a.pending_with_items:
            pend = [r for r in pend if r["items"]]
        pend.sort(key=lambda r: r["ts"] or 0, reverse=True)
        with open(a.export_pending, "w", encoding="utf-8") as fh:
            for r in pend:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"导出 {len(pend)} 条待标唤醒 -> {a.export_pending}")
        return 0

    if a.report:
        labeled = [r for r in ledger if "label" in r]
        pos = [r for r in labeled if r["label"] == 1]
        rep = [f"# 唤醒级结果标签报告\n",
               f"- 台账 {len(ledger)} 条 · 已标注 {len(labeled)} 条 · 正例 {len(pos)} 条"
               f"（正例率 {len(pos)/len(labeled)*100:.1f}%）" if labeled else "- 还没有标注",
               ""]
        if labeled:
            # 唤醒级 precision 的精确区间 (自然抽样, 不做分层加权)
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                import risk_certificate as rc
                lo = rc.cp_lower(len(pos), len(labeled), 0.05)
                hi = rc.cp_upper(len(pos), len(labeled), 0.05)
                rep.append(f"- 唤醒级 precision 点估计 {len(pos)/len(labeled)*100:.1f}%，"
                           f"95% 单侧区间 [{lo*100:.1f}%, {hi*100:.1f}%]")
                rep.append("")
            except Exception as e:
                rep.append(f"- （证书计算失败: {e}）")
            rep += ["## 分目标\n", "| target | 已标 | 正例 | 正例率 | 用户60m内回应率 | L2 10m动作率 |",
                    "|---|---|---|---|---|---|"]
            targets = sorted({r["target"] for r in labeled})
            for t in targets:
                rs = [r for r in labeled if r["target"] == t]
                p = sum(1 for r in rs if r["label"] == 1)
                eng = sum(1 for r in rs if r["user_engaged_60m"]) / len(rs)
                act = sum(1 for r in rs if r["l2_tool_calls_10m"] > 0) / len(rs)
                rep.append(f"| {t} | {len(rs)} | {p} | {p/len(rs)*100:.0f}% | {eng*100:.0f}% | {act*100:.0f}% |")
            rep += ["", "## 自动信号与人工标签的一致性\n", "| 信号 | label=1 | label=0 |", "|---|---|---|"]
            for name, fn in (("用户 60m 内有消息", lambda r: r["user_engaged_60m"]),
                             ("L2 10m 内有动作", lambda r: r["l2_tool_calls_10m"] > 0)):
                a1 = [r for r in labeled if r["label"] == 1 and fn(r)]
                a0 = [r for r in labeled if r["label"] == 0 and fn(r)]
                p1 = len(a1) / max(1, len([r for r in labeled if r["label"] == 1]))
                p0 = len(a0) / max(1, len([r for r in labeled if r["label"] == 0]))
                rep.append(f"| {name} | {p1*100:.0f}% | {p0*100:.0f}% |")
            rep += ["", "> 唤醒级是自然抽样（不是分层），所以上表区间可以对唤醒总体下结论；",
                    "> 但标签仍是 L2 代理判断，换标注人结论会变。"]
        out = a.report
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        open(out, "w", encoding="utf-8").write("\n".join(rep) + "\n")
        print("\n".join(rep))
        print(f"\n报告已写入 {out}")
        return 0

    if a.pending:
        pend = [r for r in ledger if "label" not in r]
        if a.pending_target:
            pend = [r for r in pend if r["target"] == a.pending_target]
        if a.pending_with_items:
            pend = [r for r in pend if r["items"]]
        pend.sort(key=lambda r: r["ts"] or 0, reverse=True)
        for r in pend[: a.pending]:
            items = r["items"] or [{}]
            print(f"[{time.strftime('%m-%d %H:%M', time.localtime((r['ts'] or 0) / 1000))}] "
                  f"{r['target']} · {r['status']} · 触发: {r['trigger'][:60]}")
            print(f"  key={r['wake_key']}  delivery={r['delivery_confirmed']} "
                  f"L2工具调用={r['l2_tool_calls_10m']} 用户60分钟内有消息={r['user_engaged_60m']}")
            for it in items[:3]:
                print(f"  - [{it.get('score')}] {it.get('text', '')[:100]}")
        if not pend:
            print("没有未标注的唤醒")
        return 0

    stats = {
        "total": len(ledger),
        "by_status": {},
        "by_target": {},
        "labeled": sum(1 for r in ledger if "label" in r),
        "delivery_confirmed": sum(1 for r in ledger if r["delivery_confirmed"]),
        "user_engaged": sum(1 for r in ledger if r["user_engaged_60m"]),
        "l2_acted_10m": sum(1 for r in ledger if r["l2_tool_calls_10m"] > 0),
        "ledger_file": out,
    }
    for r in ledger:
        stats["by_status"][r["status"]] = stats["by_status"].get(r["status"], 0) + 1
        t = r["target"]
        s = stats["by_target"].setdefault(t, {"n": 0, "delivered": 0, "engaged": 0, "acted": 0})
        s["n"] += 1
        s["delivered"] += 1 if r["delivery_confirmed"] else 0
        s["engaged"] += 1 if r["user_engaged_60m"] else 0
        s["acted"] += 1 if r["l2_tool_calls_10m"] > 0 else 0
    if a.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    elif not a.quiet:
        print(f"唤醒台账: {stats['total']} 条 ({stats['ledger_file']})")
        print(f"  投递确认 {stats['delivery_confirmed']} · 用户 60 分钟内说话 {stats['user_engaged']} · "
              f"L2 有动作(10m) {stats['l2_acted_10m']} · 已人工标注 {stats['labeled']}")
        for t, s in sorted(stats["by_target"].items(), key=lambda kv: -kv[1]["n"]):
            print(f"  - {t}: n={s['n']} 投递={s['delivered']} 用户回应={s['engaged']} L2动作={s['acted']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
