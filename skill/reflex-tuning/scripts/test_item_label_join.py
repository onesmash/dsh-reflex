#!/usr/bin/env python3
"""item 标签 ↔ shadow 分数的 join 契约。

背景（2026-11-16 实测）：jev-friction 有 102 条 item 级标签，但
`wake_ledger.py --export-item-labels --tag jev-friction` 报 matched 0。
原因是同一个 seq 在不同层用了不同前缀：

    影子记录  jev-friction-shadow-55178     （targets/jev-friction.sh 写进 shadow）
    群里 item jev-friction-sem-55178        （target 推给 L2 的 item id）

两者指向同一条群消息，字符串却不相等；而 join 原先只认
「id 完全相等」与「sha1(id)[:12] 等于 item_key」两条路，于是全部落空。
落空的后果是静默的：拟合继续用 11-14 那批旧标签，新标签等于没标。

本测试钉住三条契约：
  1. 前缀不同但数字后缀相同 → 必须命中（且分数取自 shadow）
  2. 后缀在 shadow 里不唯一时 → 不许猜，计 ambiguous 并跳过
  3. 老的两条路径（id 相等 / sha1 前 12 位）不许回归
"""
import json
import os
import sys
import tempfile
import hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import wake_ledger  # noqa: E402


def write(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def make_home(shadow_rows, label_rows):
    home = tempfile.mkdtemp(prefix="wake-ledger-join-")
    write(os.path.join(home, "shadow", "jev-friction-2026-11-16.jsonl"), shadow_rows)
    write(os.path.join(home, "shadow", "wake-labels.jsonl"), label_rows)
    return home


def item_label(key, label):
    return {"wake_key": f"jev-friction:i:{key}", "item_key": key, "label": label,
            "scope": "item", "target": "jev-friction"}


def test_prefix_difference_joins_by_suffix():
    home = make_home(
        [{"id": "jev-friction-shadow-55178", "score": 0.61, "tag": "jev-friction"},
         {"id": "jev-friction-shadow-55179", "score": 0.12, "tag": "jev-friction"}],
        [item_label("jev-friction-sem-55178", 0), item_label("jev-friction-p2-55179", 1)],
    )
    rows, stats = wake_ledger.export_item_labels(home, "jev-friction")
    assert stats["matched"] == 2, stats
    got = {r["id"]: (r["score"], r["label"]) for r in rows}
    assert got["jev-friction-shadow-55178"] == (0.61, 0), got
    assert got["jev-friction-shadow-55179"] == (0.12, 1), got
    assert stats["by_reason"]["suffix"] == 2, stats


def test_ambiguous_suffix_is_not_guessed():
    home = make_home(
        [{"id": "jev-friction-shadow-700", "score": 0.5},
         # 人为造第二条同后缀 id：不同前缀、同一个数字
         {"id": "jev-friction-f1-700", "score": 0.9}],
        [item_label("jev-friction-sem-700", 1)],
    )
    rows, stats = wake_ledger.export_item_labels(home, "jev-friction")
    assert stats["matched"] == 0, stats
    assert stats["by_reason"]["ambiguous_suffix"] == 1, stats


def test_exact_and_sha1_paths_still_work():
    tid_hash = "x-timeline-1234"
    home = make_home(
        [{"id": tid_hash, "score": 0.7},
         {"id": "jev-friction-shadow-800", "score": 0.3}],
        [item_label(tid_hash, 1),
         item_label(hashlib.sha1(b"jev-friction-shadow-800").hexdigest()[:12], 0)],
    )
    rows, stats = wake_ledger.export_item_labels(home, "jev-friction")
    got = {r["id"]: r["label"] for r in rows}
    assert got.get(tid_hash) == 1, stats
    assert got.get("jev-friction-shadow-800") == 0, stats
    assert stats["by_reason"]["exact"] == 1 and stats["by_reason"]["sha1"] == 1, stats


def test_colon_inside_item_key_survives_labeling():
    """item_key 自身带冒号时, 标签必须仍能 join 回条目。

    2026-11-27 实测: reflex-health 的 item_key 是 `decision-failure:disk`,
    而 wake_key 是 `reflex-health:i:decision-failure:disk` —— 记录构造时
    `key.split(':')[2]` 只留下 `decision-failure`, 于是这条标签永远命中不了
    shadow 里 id 为 `decision-failure:disk` 的那条。落空是静默的:
    标注命令回「已标注」, 拟合那边少一条样本, 没人看得出。
    """
    import subprocess
    home = tempfile.mkdtemp(prefix="wake-ledger-colon-")
    write(os.path.join(home, "shadow", "reflex-health-2026-11-27.jsonl"),
          [{"id": "decision-failure:disk", "score": 0.83, "tag": "reflex-health"}])
    p = subprocess.run([sys.executable, os.path.join(HERE, "wake_ledger.py"),
                        "--home", home, "--label", "reflex-health:i:decision-failure:disk", "0"],
                       capture_output=True, text=True)
    assert p.returncode == 0, (p.returncode, p.stdout, p.stderr)
    recs = [json.loads(l) for l in
            open(os.path.join(home, "shadow", "wake-labels.jsonl"), encoding="utf-8") if l.strip()]
    assert recs and recs[0].get("item_key") == "decision-failure:disk", recs
    rows, stats = wake_ledger.export_item_labels(home, "reflex-health")
    assert stats["matched"] == 1, stats
    assert rows[0]["id"] == "decision-failure:disk" and rows[0]["label"] == 0, rows


if __name__ == "__main__":
    test_prefix_difference_joins_by_suffix()
    test_ambiguous_suffix_is_not_guessed()
    test_exact_and_sha1_paths_still_work()
    test_colon_inside_item_key_survives_labeling()
    print("item 标签 join 契约: 4/4 通过")
