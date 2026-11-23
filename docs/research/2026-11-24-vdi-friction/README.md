# 2026-11-24 · 审计：add-source 运行暴露的 verifying-design-invariants 摩擦

**题目**：本次「Trigger 页添加数据源」的运行，暴露了 `verifying-design-invariants` 流程的哪些摩擦。
**结论**：10 条（P1×2 / P2×5 / P3×3），另抓到交付物本身一处实错（`chart-fixed.mmd` 两个状态标签说错话）。
**终止状态**：`completed` ｜ **claim_level**：`L1_primary_local_artifacts`（一手文件逐行 + 机器复跑）

正文：[friction-report.md](friction-report.md)

## 文件

| 文件 | 是什么 |
|---|---|
| `friction-report.md` | 结论正文：10 条摩擦、守住的部分、观察、修法顺序 |
| `evidence/rerun.sh` / `rerun.txt` | 八条机器核对的脚本与本次输出；`bash evidence/rerun.sh` 可重跑（exit 0 / 1 / 2） |
| `claim_evidence_map.json` | 21 条陈述 → 来源与定位 |
| `citation_support_matrix.json` | 15 条引用逐条核对（11 条原文引用、4 条机器复现） |
| `statement_support_matrix.json` | 陈述级审计（19 supported / 2 partially_supported / 0 unsupported） |
| `unsupported_statement_register.json` | 0 条（刻意的；理由写在文件里） |
| `source_matrix.json` | 12 个来源，3 个类别（技能文本 / 运行产物 / 机器复跑） |
| `preflight_report.json` | 工具可得性、读了哪些源、做了什么复跑、未判定项 |
| `research_mission_pack_v1.json` / `research_completion_audit_v1.json` / `continuation_plan.json` | 运行收据（任务包 / 完成审计 / 续跑计划） |
| `local-evidence/local_evidence_bundle.json` | Local Evidence Overlay 产物（26 份文件；collector 只吃文本类扩展名，`.tla`/`.mmd`/`.mjs` 靠直接引用，不靠它） |

## 怎么重跑

```sh
# 八条机器观测（截断、假证据、未跑命令、悬空小标题、运行残留、非 ASCII 记录）
bash evidence/rerun.sh

# 陈述级审计（研究二进制的校验器）
python3 <skill>/scripts/research_nex_validate_statement_audit.py \
  --out-dir <本目录> --schema-dir <skill>/schemas
```

本次输出（原样）：

```
== E1 全表：rows=19 verdict=OK rc=0
== E2 表内空行：rows=9（应读 9）verdict=OK rc=0 errors 为空=1
== E3 假证据路径（文档命令）：verdict=OK rc=0 不存在告警数=1
== E4 假证据路径 + --strict：rc=1
== E5 没跑过的命令 + 退出码 0：verdict=OK rc=0
== E6 悬空小标题：旧称出现 3 次，标题叫「四项要求」的 0 个，check-paths rc=0
== E7 2f49ffd 里的运行残留：states/*.st 26 个，TTrace 4 个
== E8 非 ASCII 标签的记录：0 份 md 提到
== 结论：八条观测与预期一致
```

```
PASS statement_support_matrix.json
PASS unsupported_statement_register.json
FACT citation_accuracy=0.9048 effective_citations=10 network_unavailable=True
exit=0
```

`network_unavailable=True` 是本轮已知的硬编码常量（上一轮已作为 research-nex 摩擦上报）；本运行完全没用网络，它在这里不构成降级理由。

## 与上一轮的关系

`2026-11-23-add-source-ui/` 审的是**产品交互**（三段式有没有行业先例）；
本目录审的是**流程本身**（那套验证方法在本次运行里哪里假绿、哪里没有收据）。两者互不替代。
