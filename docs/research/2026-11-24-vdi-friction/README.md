# 2026-11-24 · 审计：add-source 运行暴露的 verifying-design-invariants 摩擦

**题目**：本次「Trigger 页添加数据源」的运行，暴露了 `verifying-design-invariants` 流程的哪些摩擦。
**结论**：10 条（P1×2 / P2×5 / P3×3），另抓到交付物本身一处实错（`chart-fixed.mmd` 两个状态标签说错话）；验证时又顺手抓到第 11 条同类问题。
**终止状态**：`completed` ｜ **claim_level**：`L1_primary_local_artifacts`（一手文件逐行 + 机器复跑）
**处置**：10 条已全部落地（N3 只加收据位、未强制），记录见正文「处置记录」。

正文：[friction-report.md](friction-report.md)

## 文件

| 文件 | 是什么 |
|---|---|
| `friction-report.md` | 结论正文：10 条摩擦、守住的部分、观察、修法顺序、处置记录 |
| `evidence/rerun.sh` + `rerun.txt` | **修复后**的十条观测；`bash evidence/rerun.sh` 可重跑（exit 0 / 1 / 2） |
| `evidence/rerun-before.txt` | 修复前的输出（审计当时的现场：19 行被读成 9 行仍 OK） |
| `evidence/register-negative.sh` + `.txt` | 登记表核对器的四个破坏变体（T0 绿、T1–T4 红） |
| `evidence/chart-check.txt` | 图对表：旧图红 / 新图绿 / 错顺序红 |
| `evidence/chart-fixed-before-fix.mmd` | 审计时的 `chart-fixed.mmd`（从 `64f6e75` 取出；现文件已重画） |
| `claim_evidence_map.json` | 21 条陈述 → 来源与定位 |
| `citation_support_matrix.json` | 15 条引用逐条核对（11 条原文引用、4 条机器复现） |
| `statement_support_matrix.json` | 陈述级审计（19 supported / 2 partially_supported / 0 unsupported） |
| `unsupported_statement_register.json` | 0 条（刻意的；理由写在文件里） |
| `source_matrix.json` | 12 个来源，3 个类别（技能文本 / 运行产物 / 机器复跑） |
| `preflight_report.json` | 工具可得性、读了哪些源、做了什么复跑、未判定项 |
| `research_mission_pack_v1.json` / `research_completion_audit_v1.json` / `continuation_plan.json` | 运行收据（任务包 / 完成审计 / 续跑计划，含处置状态） |
| `local-evidence/local_evidence_bundle.json` | Local Evidence Overlay 产物（26 份文件；collector 只吃文本类扩展名，`.tla`/`.mmd`/`.mjs` 靠直接引用） |

## 怎么重跑

```sh
bash evidence/rerun.sh              # 十条观测：检查器的分辨力 + 文档已改 + 残留已清
bash evidence/register-negative.sh  # 登记表的四个破坏变体
node <skill>/scripts/check-paths.mjs        <skill>
node <skill>/scripts/check-portability.mjs  <skill>

python3 <skill>/scripts/research_nex_validate_statement_audit.py \
  --out-dir <本目录> --schema-dir <skill>/schemas
```

修复后的输出（原样，本次）：

```
== E1 全表            verdict=OK rows=19 rc=0
== E2 表内空行        FAIL rc=1（报「表格在第 17 行之后中断」）
== E3 证据文件不存在   FAIL rc=1（硬告警）
== E4 加 --strict      rc=1
== E5 没跑过的命令     FAIL rc=1
== E6 旧称清零        refs=0，check-paths OK
== E7 运行残留        历史 26/4，现跟踪 0
== E8 ASCII 规则      1 份 md 记载
== E9 图对表          旧图 FAIL / 新图 OK
== E10 悬空指路       副本上 FAIL
== 结论：十条观测与预期一致
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
