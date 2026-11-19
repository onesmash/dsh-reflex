#!/usr/bin/env python3
"""labels_any — 标签方言的唯一读取实现（2026-11-19）。

为什么有这个文件
  生产端每天产出的是 **item 级**标签（`wake_label target:i:<id>` → wake-labels.jsonl），
  而分析工具历史上只吃 **idx 级**标签（分层抽样的 sample-<tag>.json 序号）。
  方言不统一会造成两种坏结果，2026-11-19 实测两种都发生了：
  ① tune-ab.py 的 loader 写着 `if "idx" in d`，把 item 标签逐行丢掉，
     486 条喂进去后报「可对齐样本只有 0 条，需要 ≥10」——**报错指向错误的原因**，
     读者会去补样本，而真相是方言不匹配。
  ② risk_certificate.py 读固定文件名，于是它读到另一份旧标签，
     **正常产出一份报告**，只把问题说成「正例不足」。这一条才是真正的静默。
  skill 坑 #10 就写着：任何「跑完了」的工具，都要问一句「它取输入失败时是报错还是回退？」

三种方言
  idx   {"idx": 12, "label": 1}                      分层抽样序号（要配 sample-<tag>.json）
  key   {"key": "<state_hash>", "label": 1}          直接对齐 shadow 记录
  item  {"id": "<tweet id>", "score": .., "label": 1} item 级（wake_ledger --export-item-labels）

契约
  load(path)            → Labels(labs, dialect, lines, usable, duplicates, conflicts)
  resolve(home, tag, …) → (labels_by_key, weights_by_key, dialect)
                         四个分析工具（tune-ab / shadow_ab / risk_certificate / calibration）
                         都走这一层，于是「能不能读这份输入」不再取决于用了哪个工具。
"""

from __future__ import annotations

import glob
import json
import os


class LabelsError(RuntimeError):
    """标签不可用。带可核计数的消息，便于贴进报告。"""


class Labels:
    __slots__ = ("labs", "dialect", "lines", "usable", "duplicates", "conflicts", "counts", "path")

    def __init__(self, labs, dialect, lines, usable, duplicates, conflicts, counts, path):
        self.labs = labs
        self.dialect = dialect          # 'idx' | 'key' | 'item' | 'empty'
        self.lines = lines              # 文件里的有效行数
        self.usable = usable            # 唯一键数（= len(labs)）
        self.duplicates = duplicates    # 同键重复出现的次数
        self.conflicts = conflicts      # 同键但标签不一致的键数
        self.counts = counts
        self.path = path

    def __repr__(self):
        return (f"Labels(dialect={self.dialect}, unique={self.usable}/{self.lines}, "
                f"dup={self.duplicates}, conflict={self.conflicts})")

    def describe(self):
        extra = f"，重复 {self.duplicates}" if self.duplicates else ""
        extra += f"，**冲突 {self.conflicts}**" if self.conflicts else ""
        return (f"{self.path}：读 {self.lines} 行 → 唯一 {self.usable} 条"
                f"（idx {self.counts['idx']} / key {self.counts['key']} / item {self.counts['item']}{extra}）")


def _lab(v):
    if v in (0, 1):
        return int(v)
    if v in ("0", "1"):
        return int(v)
    if v is True:
        return 1
    if v is False:
        return 0
    return None


def _dialect_of(o):
    """单行的方言判定。顺序要紧：item 必须最先判。"""
    if o.get("item_id") or (o.get("scope") == "item" and o.get("id")):
        return "item"
    if o.get("key"):
        return "key"
    if "idx" in o:
        return "idx"
    if o.get("id"):
        return "item"
    return None


def _key_of(o, dialect):
    if dialect == "item":
        return str(o.get("item_id") or o["id"])
    if dialect == "key":
        return str(o["key"])
    try:
        return int(o["idx"])
    except (TypeError, ValueError):
        return None


def load(path: str, *, require_usable: bool = True) -> Labels:
    """读任意方言的标签文件。不可用时抛 LabelsError（不静默返回空）。"""
    if not os.path.exists(path):
        raise LabelsError(f"标签文件不存在：{path}")

    buckets = {"idx": {}, "key": {}, "item": {}}
    counts = {"idx": 0, "key": 0, "item": 0}
    lines = 0
    duplicates = 0
    conflicts = 0

    for raw in open(path, encoding="utf-8", errors="replace"):
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        try:
            o = json.loads(raw)
        except Exception:
            continue
        lines += 1
        lab = _lab(o.get("label"))
        dialect = _dialect_of(o)
        if lab is None or dialect is None:
            continue
        k = _key_of(o, dialect)
        if k is None:
            continue
        bucket = buckets[dialect]
        if k in bucket:
            duplicates += 1
            if bucket[k] != lab:
                conflicts += 1
                # 冲突时保留**最后一次**（与 JSONL 覆盖语义一致），并把冲突数报给调用方
            bucket[k] = lab
        else:
            bucket[k] = lab
            counts[dialect] += 1

    # 方言：取唯一键最多的那一桶（同一文件不应混方言；混了就以多数为准并计入 counts）
    usable_by = {d: len(buckets[d]) for d in buckets}
    dialect = "empty" if max(usable_by.values(), default=0) == 0 else max(usable_by, key=lambda d: usable_by[d])
    labs = buckets[dialect] if dialect != "empty" else {}
    usable = len(labs)

    if lines > 0 and usable == 0 and require_usable:
        raise LabelsError(
            f"标签文件非空但一条可用都没有：{path}\n"
            f"  读 {lines} 行，其中 idx {counts['idx']} / key {counts['key']} / item {counts['item']}\n"
            f"  支持三种方言：{{\"idx\":N,\"label\":0|1}} / {{\"key\":\"<state_hash>\",\"label\":0|1}} / "
            f"{{\"id\":\"<id>\",\"label\":0|1}}\n"
            f"  这一条以前是**静默跳过**的（工具会拿着 0 条标签继续跑并产出完整报告），"
            f"现在改成硬失败。要跳过请显式传 require_usable=False。"
        )

    return Labels(labs, dialect, lines, usable, duplicates, conflicts, counts, path)


# ---------- 对齐层：任意方言 → key(state_hash) → label ----------

def load_id_key_map(home: str, tag: str) -> dict:
    """shadow 记录里的 id → key（state_hash），供 item 级标签对齐。"""
    out = {}
    pat = os.path.join(home, "shadow", f"{tag}-*.jsonl")
    for p in sorted(glob.glob(pat)):
        b = os.path.basename(p)
        if "dict-backup" in p or ".bak" in p or b.startswith(("labels-", "sample-", "wake-", "ab-")):
            continue
        for line in open(p, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            i, k = d.get("id"), d.get("key")
            if i and k:
                out[str(i)] = k
    return out


def load_sample(home: str, labels_tag: str):
    """idx → key 映射与分层抽样权重（只有 idx 方言需要）。"""
    p = os.path.join(home, "shadow", f"sample-{labels_tag}.json")
    idx_map, weights = {}, {}
    if not os.path.exists(p):
        return idx_map, weights
    raw = json.load(open(p, encoding="utf-8"))
    if isinstance(raw, dict) and "items" in raw:
        for it in raw["items"]:
            idx_map[int(it["idx"])] = it["key"]
            weights[it["key"]] = float(it.get("w") or 1.0)
    else:
        for k, v in raw.items():
            idx_map[int(k)] = v
    return idx_map, weights


def resolve(home: str, tag: str, path: str = "", labels_tag: str = "", *,
            require_usable: bool = True):
    """把一份标签对齐成 (key → label, key → weight, dialect)。

    - path 给定时读它；不给时读 shadow/labels-<labels_tag or tag>.jsonl
    - item 方言：id → key 用 shadow 记录反查，权重全 1（没有分层抽样语义）
    - idx 方言：用 sample-<labels_tag>.json 换成 key，并带回抽样权重
    - key 方言：直接用，权重全 1
    """
    labels_tag = labels_tag or tag
    p = path or os.path.join(home, "shadow", f"labels-{labels_tag}.jsonl")
    L = load(p, require_usable=require_usable)

    if L.dialect == "item":
        id2key = load_id_key_map(home, tag)
        labs, miss = {}, 0
        for iid, y in L.labs.items():
            k = id2key.get(str(iid))
            if k:
                labs[k] = y
            else:
                miss += 1
        if miss:
            print(f"[labels] item 方言：{L.usable} 条 → 对齐 {len(labs)} 条，未对齐 {miss} 条",
                  file=__import__("sys").stderr)
        return labs, {}, "item"

    if L.dialect == "key":
        return dict(L.labs), {}, "key"

    if L.dialect == "idx":
        idx_map, weights = load_sample(home, labels_tag)
        if not idx_map:
            raise LabelsError(
                f"标签是 idx 方言，但缺抽样映射 shadow/sample-{labels_tag}.json\n"
                f"  idx 必须配 sample 才能换成 state key（先 threshold_fit --export-sample）"
            )
        labs = {idx_map[i]: y for i, y in L.labs.items() if i in idx_map}
        return labs, weights, "idx"

    return {}, {}, "empty"
