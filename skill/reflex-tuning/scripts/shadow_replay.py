#!/usr/bin/env python3
"""影子回放: 把历史事实按生产节奏重放进 target, 生成 shadow 数据。

为什么不用等实时数据
  facts 已经在盘上 (facts/<source>/<YYYY-MM-DD>.jsonl)。重放一遍就能立刻拿到
  "如果当时用当前 target 口径打分, 每条会得多少分", 不用攒一整天的线上数据。

等价性说明
  target 的判定是逐条独立的 (state 只由该条 fact 自身内容拼成), 所以把事实按
  生产批次大小(默认 12, 与 target 的 MAXN 一致)切块重放, 分数与线上逐条打分一致;
  差别仅在时间戳/批次合并, 不影响 p(yes)。

副作用
  - 只写 $REFLEX_HOME/shadow/<tag>-<今天>.jsonl (mode=replay), 不动 facts / cursor
  - target 会写 <target>.last-run 标记, 本程序跑完自动还原

用法
  python3 tools/shadow_replay.py --target x-timeline --days 2026-10-16,2026-10-17
  python3 tools/shadow_replay.py --target x-timeline --days all --chunk 12
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

DEFAULT_HOME = os.environ.get("REFLEX_HOME") or os.path.expanduser("~/.dsh/dsh-reflex")
# 用户画像由环境变量 REFLEX_PROFILE 提供(插件运行时注入); 不内置任何个人信息。
DEFAULT_PROFILE = os.environ.get("REFLEX_PROFILE", "")


def load_facts(home, source, days):
    d = os.path.join(home, "facts", source)
    if not os.path.isdir(d):
        return []
    files = sorted(f for f in os.listdir(d) if f.endswith(".jsonl"))
    if days and days != "all":
        want = set(days)
        files = [f for f in files if f[:-6] in want]
    rows = []
    for f in files:
        try:
            with open(os.path.join(d, f), encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rows.append(json.loads(line))
                    except Exception:
                        continue
        except FileNotFoundError:
            continue
    rows.sort(key=lambda r: (r.get("ts") or 0, r.get("seq") or 0))
    # 同一事实重复回放时去重 (id 唯一)
    seen, uniq = set(), []
    for r in rows:
        rid = r.get("id")
        if rid and rid in seen:
            continue
        if rid:
            seen.add(rid)
        uniq.append(r)
    return uniq


def shadow_file(home, tag):
    return os.path.join(home, "shadow", f"{tag}-{time.strftime('%Y-%m-%d')}.jsonl")


def count_lines(path):
    try:
        with open(path, "rb") as fh:
            return sum(1 for _ in fh)
    except FileNotFoundError:
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="x-timeline", help="tag 名 (写入 shadow/<tag>-*.jsonl)")
    ap.add_argument("--script", default="", help="要执行的 target 脚本路径 (默认 <home>/targets/<target>.sh)")
    ap.add_argument("--source", default="", help="读哪个源的事实目录 (默认 = target 名)")
    ap.add_argument("--days", default="all", help="逗号分隔的日期, 或 all")
    ap.add_argument("--chunk", type=int, default=12, help="每批事实数, 默认与生产一致")
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--profile", default=DEFAULT_PROFILE)
    ap.add_argument("--limit", type=int, default=0, help="只回放前 N 条 (调试用)")
    ap.add_argument("--timeout", type=float, default=300.0)
    a = ap.parse_args()

    days = None if a.days in ("", "all") else [x.strip() for x in a.days.split(",") if x.strip()]
    source = a.source or a.target
    facts = load_facts(a.home, source, days)
    if a.limit:
        facts = facts[: a.limit]
    if not facts:
        print("shadow_replay: 没有可回放的事实", file=sys.stderr)
        return 2

    target_sh = a.script or os.path.join(a.home, "targets", f"{a.target}.sh")
    if not os.path.exists(target_sh):
        print(f"shadow_replay: target 不存在: {target_sh}", file=sys.stderr)
        return 2

    last_run = os.path.join(a.home, f".{a.target}-target.last-run")
    backup = None
    if os.path.exists(last_run):
        backup = last_run + ".replay-bak"
        shutil.copy2(last_run, backup)

    # 继承调用方的 REFLEX_* (例如 REFLEX_X_MAX_CANDIDATES), 再覆盖回放必需项
    env = {k: v for k, v in os.environ.items() if k.startswith("REFLEX_")}
    env.update({
        "HOME": os.environ.get("HOME", ""),
        "PATH": os.environ.get("PATH", "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"),
        "REFLEX_HOME": a.home,
        "REFLEX_TARGET": a.target,
        "REFLEX_PROFILE": a.profile,
        "REFLEX_SHADOW_MODE": "replay",
        "REFLEX_PLUGIN_INVOKED": "1",
    })

    sfile = shadow_file(a.home, a.target)
    before = count_lines(sfile)

    chunks = [facts[i : i + a.chunk] for i in range(0, len(facts), a.chunk)]
    ok = fail = 0
    t0 = time.time()
    for idx, chunk in enumerate(chunks, 1):
        inp = "\n".join(json.dumps(f, ensure_ascii=False) for f in chunk) + "\n"
        try:
            p = subprocess.run(
                ["bash", target_sh],
                input=inp,
                capture_output=True,
                text=True,
                env=env,
                timeout=a.timeout,
            )
            if p.returncode == 0:
                ok += 1
            else:
                fail += 1
                if fail <= 5:
                    err = (p.stderr or "").strip().splitlines()[-1:] or ["(无 stderr)"]
                    print(f"[{idx}/{len(chunks)}] target 退出 {p.returncode}: {err[0]}", file=sys.stderr)
        except subprocess.TimeoutExpired:
            fail += 1
            print(f"[{idx}/{len(chunks)}] 超时 (>{a.timeout}s)", file=sys.stderr)
        if idx % 10 == 0 or idx == len(chunks):
            print(f"[{idx}/{len(chunks)}] 批次完成, 成功 {ok} / 失败 {fail}", file=sys.stderr)

    if backup and os.path.exists(backup):
        shutil.copy2(backup, last_run)
        os.unlink(backup)

    added = count_lines(sfile) - before
    summary = {
        "target": a.target,
        "facts": len(facts),
        "chunks": len(chunks),
        "chunk_ok": ok,
        "chunk_fail": fail,
        "shadow_file": sfile,
        "shadow_records_added": added,
        "elapsed_s": round(time.time() - t0, 1),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
