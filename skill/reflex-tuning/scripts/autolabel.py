#!/usr/bin/env python3
"""自动给 shadow 样本打标签，替代人工标注。

信号来源：DSH 会话记录的原始 transcript（`~/.dsh/sessions/<cwd>/<session>/session.v4.jsonl.zstd`）。
**不用 chat-index.sqlite**：它只到昨天（索引延迟），今天的告警查不到。

两路信号（按强度递减）：
  1. **用户回复** — 告警发出后窗口内出现 user/message。最强正例：
     用户被真正打断并动手了。
  2. **L2 实质处理** — 窗口内 assistant/message 出现核实/结论类措辞，且长度足够。
     说明 bot 判断后认为值得处理。
  其余为负例。

为什么不人工标：threshold_fit 要的是"该不该打断我"，而"我有没有真的被它打断并处理"
是这个问题的行为代理。它不等于主观偏好，但可自动累积，且不是模型自评（无循环论证）。
"""
import json
import os
import re
import subprocess
import sys

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")
SESSIONS_ROOT = os.environ.get("REFLEX_SESSIONS_ROOT") or os.path.expanduser("~/.dsh/sessions")

# 这些不是"用户被打断后的反应"，是系统回灌/转发，必须排除后再判用户回复：
#   [分层智能体·L1·…]  告警本体被写回会话
#   [Group post from …]  别的群的转发
#   Time sampled while preparing turn …  上下文注入
#   [Message from …] / [Reply from …]  其它 Bot 的消息
NOT_A_USER_REPLY = re.compile(
    r"^\[分层智能体|^\[Group post|^\[Message from|^\[Reply from|"
    r"^Time sampled|^\[Checkpoint|^\[Handoff"
)

# 「L2 实质处理」的判据。要点：只认【真的去查了/改了】的动作，
# 不认分析性措辞。原版含 结论|判断|说明|这条|建议|命中|告警 —— 这些词在
# 任何一篇分析里都会出现，导致"bot 写了一段分析"被当成"这个告警有值"，
# 从而把大量噪音标成正例（且这些正例的来源正是 bot 自己的产出，构成自证）。
HANDLED_PATTERN = re.compile(
    r"核实了|核对过|查证过|已经修复|已修复|已修好|"
    r"没有找到.{0,12}(?:证据|来源|出处)|未能核实|对不上|"
    r"已确认|已复现|已部署|已提交|已合并|"
    r"原文如此|与官方一致|官方原文|一手来源"
)
# 150 字下限保留：短回复更可能是礼节性回应而非实质处理。
MIN_HANDLED_CHARS = 150


def load_shadow(home, tag):
    path_dir = os.path.join(home, "shadow")
    rows = {}
    if not os.path.isdir(path_dir):
        return []
    for name in sorted(os.listdir(path_dir)):
        if not (name.startswith(f"{tag}-") and name.endswith(".jsonl")):
            continue
        with open(os.path.join(path_dir, name), encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("score") is None:
                    continue
                rows[rec["key"]] = rec
    return sorted(rows.values(), key=lambda r: r["ts"])


def iter_transcripts(root):
    """产出 (session_id, mtime, path)，只取最近的几个会话。"""
    found = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith(".jsonl.zstd"):
                continue
            path = os.path.join(dirpath, name)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            found.append((os.path.basename(dirpath), mtime, path))
    found.sort(key=lambda item: item[1], reverse=True)
    return found


def read_messages(path):
    """解压 transcript，返回 [(ts_ms, role, text)]，只保留 user/assistant 文本。"""
    try:
        raw = subprocess.run(
            ["zstd", "-dc", path], capture_output=True, text=True, timeout=60
        ).stdout
    except Exception:
        return []
    out = []
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = rec.get("type")
        if kind not in ("user/message", "assistant/message"):
            continue
        ts = rec.get("time")
        if not isinstance(ts, (int, float)):
            continue
        text = extract_text(rec.get("data") or {})
        if text:
            out.append((float(ts), "user" if kind == "user/message" else "assistant", text))
    return out


def extract_text(data):
    """从消息 data 抽纯文本。

    实测结构（DSH session v4）—— **user 与 assistant 不同层**：
      user/message      : data.content        = [{"type":"text","text":...}, ...]
      assistant/message : data.message.content = [{"type":"text","text":...}, ...]
                          （外层还有 data.turn / data.step / data.stream）

    2026-11-12 修：原先只查 data["content"]，assistant 消息一律解析为空，
    「L2 实质处理」这条信号因此**从未触发过**（实测 1278 条 assistant/message → 0 条）。
    打标器实际上只用到了「用户是否回应」一路信号。
    """
    parts = []
    msg = data.get("message")
    content = data.get("content")
    if content is None and isinstance(msg, dict):
        content = msg.get("content")           # assistant/message 形态
    if isinstance(content, list):
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
    elif isinstance(content, str):
        parts.append(content)
    # 兼容其它形态（不同版本可能平铺）
    for key in ("text", "message"):
        value = data.get(key)
        if isinstance(value, str) and value:
            parts.append(value)
    return "\n".join(parts)


def group_batches(rows, gap_ms=90_000):
    """按写入时刻聚类成批。shadow 同一次批量打分的 ts 相同（或相差毫秒级）。

    为什么必须分批：shadow 的 ts 是【写入时刻】，不是推文发布时刻，也不等于告警时刻。
    只有"这一批里有人越过阈值"才会真的告警；没越过的批是干净的负例，
    不能拿"用户后来刚好在说话"当正例（实测 30 分钟窗口下 91% 被误标为正）。
    """
    batches = []
    current = []
    last = None
    for row in rows:
        if last is None or row["ts"] - last <= gap_ms:
            current.append(row)
        else:
            batches.append(current)
            current = [row]
        last = row["ts"]
    if current:
        batches.append(current)
    return batches


def classify(messages, ts_ms, window_ms, threshold):
    """窗口内用户是否回话 / L2 是否实质处理。"""
    lo, hi = ts_ms, ts_ms + window_ms
    user_replied = False
    bot_handled = False
    for ts, role, text in messages:
        if ts < lo or ts > hi:
            continue
        if role == "user":
            if NOT_A_USER_REPLY.search(text.strip()):
                continue                     # 告警回灌/转发，不算用户回复
            user_replied = True
            break
        if len(text) >= MIN_HANDLED_CHARS and HANDLED_PATTERN.search(text):
            bot_handled = True
    if user_replied:
        return "user-reply"
    if bot_handled:
        return "bot-handled"
    return "no-response"


def main():
    if len(sys.argv) < 2:
        print("usage: autolabel.py <tag>   # tag 必填，如 x-timeline", file=sys.stderr)
        return 2
    tag = sys.argv[1]
    home = os.environ.get("REFLEX_HOME") or DEFAULT_HOME
    window_ms = float(os.environ.get("REFLEX_LABEL_WINDOW_MIN", "30")) * 60_000

    shadow = load_shadow(home, tag)
    if not shadow:
        print(f"shadow 里没有 {tag} 的样本", file=sys.stderr)
        return 2

    transcripts = iter_transcripts(SESSIONS_ROOT)
    messages = []
    used = []
    for session_id, _mtime, path in transcripts[:6]:      # 只读最近 6 个会话
        got = read_messages(path)
        if got:
            messages.extend(got)
            used.append((session_id, len(got)))
            print(f"  读入 {session_id[:20]}… {len(got)} 条消息", file=sys.stderr)
    if not messages:
        print("警告: 读不到任何会话记录，全部按无响应处理", file=sys.stderr)
    messages.sort(key=lambda m: m[0])

    # ⚠️ 2026-11-12 改：不再覆写 labels-<tag>.jsonl（那是人工标签的口径）。
    # 原因：实测用 2258 条弱标签覆盖掉 217 条人工标签，靠 /tmp 备份才捡回来。
    # 弱标签 = 代理标签，与人工标签是两种口径，不能混存。
    import time as _t
    out_path = os.path.join(home, "shadow",
                            f"labels-{tag}-weak-{_t.strftime('%Y%m%d-%H%M%S')}.jsonl")
    threshold = float(os.environ.get("REFLEX_LABEL_THRESHOLD", "0.7"))
    stats = {"user-reply": 0, "bot-handled": 0, "no-response": 0, "batch-negative": 0}
    lines = []
    batches = group_batches(shadow)
    for batch in batches:
        first_ts = batch[0]["ts"]
        # 这一批是否有命中 → 决定它是否真的触发过告警
        hit = any(r["score"] >= threshold for r in batch)
        if not hit:
            # 整批未达阈值 = 干净的负例，不需要看会话
            for rec in batch:
                lines.append(json.dumps({
                    "key": rec["key"], "label": 0, "source": "batch-negative",
                    "score": rec["score"],
                }, ensure_ascii=False))
                stats["batch-negative"] += 1
            continue
        source = classify(messages, first_ts, window_ms, threshold)
        label = 0 if source == "no-response" else 1
        for rec in batch:
            lines.append(json.dumps({
                "key": rec["key"], "label": label, "source": source,
                "score": rec["score"],
            }, ensure_ascii=False))
            stats[source] += 1

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    total = len(shadow)
    positives = stats["user-reply"] + stats["bot-handled"]
    print(f"\n标注 {total} 条 → {out_path}  （{len(batches)} 批，阈值 {threshold}）")
    print(f"  用户回复:      {stats['user-reply']}")
    print(f"  L2 已处理:     {stats['bot-handled']}")
    print(f"  触发但无响应:  {stats['no-response']}")
    print(f"  整批未达阈值:  {stats['batch-negative']}")
    print(f"  正例合计:      {positives} ({positives / total * 100:.1f}%)")
    if positives < 8:
        print("  提示: 正例 <8，拟合区间会很宽；继续累积后更可信")
    return 0


if __name__ == "__main__":
    sys.exit(main())
