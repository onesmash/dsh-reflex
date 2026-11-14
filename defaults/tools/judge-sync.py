#!/usr/bin/env python3
"""judge-sync — 判据单一源（judge/<tag>.json）的生成、校验与哈希。

为什么要它（O7）
  2026-11-14 之前，同一套判据有 3 份副本：target 脚本里的内联常量、校准脚本里的
  cal_rows、报告里抄的措辞。改一处忘两处，症状是「数字变好」而不是报错。
  pc_inject 又只认 `OPTIONS = [` 写法，jev-friction 的 SHADOW_YES/NO 风格直接
  静默落到通用判据，指纹因此得出过假阴性。

单一源的定义
  `$REFLEX_HOME/judge/<tag>.json`：
    {"question": "...", "options": [{"id":"yes","description":"..."},{"id":"no",...}]}
  - target 读取它（读不到才回退内联常量）；
  - pc_inject / threshold_fit 等工具读它生成的 `shadow/options-<tag>.json`；
  - 所有产物的 optionsHash = 本文件的**规范化 JSON 哈希**（见 canonical_hash）。

用法
  python3 tools/judge-sync.py --tag jev-friction            # 从 target 抽取 → 写 judge/ + shadow/options-
  python3 tools/judge-sync.py --tag all --check             # 只校验：judge 与 target 是否一致（漂移即退出码 3）
  python3 tools/judge-sync.py --tag jev-friction --hash     # 打印九位哈希（供 registry 登记）
"""
import argparse
import ast
import hashlib
import json
import os
import re
import sys

DEFAULT_HOME = os.path.expanduser("~/.dsh/dsh-reflex")


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def extract_from_target(target_path):
    """返回 (question, options) 或 (None, None)。支持两种书写风格。"""
    s = read(target_path)
    if s is None:
        return None, None

    def const(name):
        m = re.search(name + r'\s*=\s*"((?:[^"\\]|\\.)*)"', s)
        if not m:
            return None
        try:
            return json.loads('"' + m.group(1) + '"')
        except Exception:
            return m.group(1)

    q = const("QUESTION")
    m = re.search(r"^OPTIONS\s*=\s*(\[.*?\n\])", s, re.M | re.S)
    if m:
        raw = m.group(1)
        # 2026-11-14：OPTIONS 段是 Python 字面量，不是 JSON ——
        # x-timeline 用隐式字符串拼接（"a" "b"）和括号折行，json.loads 必失败。
        # 之前 pc_inject 就是在这里静默回退 DEFAULT_OPTIONS 的。
        for parse in (ast.literal_eval, json.loads):
            try:
                return q, parse(re.sub(r",(\s*[\]}])", r"\1", raw))
            except Exception:
                continue
        return None, None

    ys, ns = const("SHADOW_YES"), const("SHADOW_NO")
    if ys and ns:
        return q, [{"id": "yes", "description": ys}, {"id": "no", "description": ns}]
    return None, None


def canonical_hash(question, options):
    """所有工具与产物共用的判据指纹。

    只保留会改变判定语义的字段（id + description + question），
    字段顺序归一，空格不影响——这样「改措辞」一定变，「重排格式」不变。
    """
    canon = {
        "question": question or "",
        "options": [{"id": str(o.get("id")), "description": o.get("description") or ""} for o in options],
    }
    blob = json.dumps(canon, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def paths(home, tag):
    return (os.path.join(home, "judge", f"{tag}.json"),
            os.path.join(home, "shadow", f"options-{tag}.json"),
            os.path.join(home, "targets", f"{tag}.sh"))


def sync(tag, home):
    judge_p, opt_p, tgt_p = paths(home, tag)
    q, opts = extract_from_target(tgt_p)
    if not opts:
        return None, f"无法从 {tgt_p} 提取判据（两种写法都不匹配）"
    h = canonical_hash(q, opts)
    doc = {"tag": tag, "question": q, "options": opts,
           "rubricHash": h, "extractedFrom": os.path.basename(tgt_p)}
    os.makedirs(os.path.dirname(judge_p), exist_ok=True)
    os.makedirs(os.path.dirname(opt_p), exist_ok=True)
    for p, obj in ((judge_p, doc), (opt_p, opts)):
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
    return h, None


def check(tag, home):
    """judge 文件与 target 是否仍然一致；返回 (ok, msg, hash)。"""
    judge_p, _, tgt_p = paths(home, tag)
    s = read(judge_p)
    if s is None:
        return False, f"缺 {os.path.basename(judge_p)}（先跑 --tag {tag} 生成）", None
    try:
        doc = json.loads(s)
    except Exception as e:
        return False, f"{os.path.basename(judge_p)} 不是合法 JSON: {e}", None
    q, opts = extract_from_target(tgt_p)
    if not opts:
        return False, f"target 判据不可提取（{os.path.basename(tgt_p)}）", None
    file_h = canonical_hash(doc.get("question"), doc.get("options") or [])
    tgt_h = canonical_hash(q, opts)
    if doc.get("rubricHash") and doc["rubricHash"] != file_h:
        return False, f"judge 文件自称 {doc['rubricHash']} 但内容哈希是 {file_h}（文件被手改过）", file_h
    if file_h != tgt_h:
        return False, f"judge({file_h}) ≠ target({tgt_h})——两份判据已分叉，必须收敛", file_h
    return True, f"一致 {file_h}", file_h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="all")
    ap.add_argument("--home", default=DEFAULT_HOME)
    ap.add_argument("--check", action="store_true", help="只校验，不写文件")
    ap.add_argument("--hash", action="store_true", help="打印规范化哈希后退出")
    a = ap.parse_args()

    home = os.path.expanduser(a.home)
    reg_p = os.path.join(home, "tools", "shadow_targets.json")
    s = read(reg_p)
    reg = json.loads(s) if s else {}
    tags = ([t for t in reg if not t.endswith("-replay") and not t.endswith("-replay2")]
            if a.tag == "all" else [a.tag])

    worst = 0
    for tag in tags:
        if a.hash:
            judge_p, _, _ = paths(home, tag)
            s2 = read(judge_p)
            if s2:
                print(tag, json.loads(s2).get("rubricHash"))
            else:
                q, opts = extract_from_target(paths(home, tag)[2])
                print(tag, canonical_hash(q, opts) if opts else "N/A")
            continue
        if a.check:
            ok, msg, _ = check(tag, home)
            print(f"{'✓' if ok else '✗'} {tag}: {msg}")
            if not ok:
                worst = 3
        else:
            h, err = sync(tag, home)
            if err:
                print(f"✗ {tag}: {err}")
                worst = 3
            else:
                print(f"✓ {tag}: judge/{tag}.json + shadow/options-{tag}.json · rubricHash={h}")
    return worst


if __name__ == "__main__":
    sys.exit(main())
