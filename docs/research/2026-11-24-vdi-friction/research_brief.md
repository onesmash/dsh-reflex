# 研究简报：本次 add-source 运行暴露了 verifying-design-invariants 的哪些摩擦

- **模式**：Validate（审计既有结论/既有流程，不产出新的外部事实）
- **画像**：technical-detail
- **交付**：仓库文档（本目录）+ 聊天结论
- **对象**：`~/.agents/skills/verifying-design-invariants`（技能文本、模板、检查器）+ 本次「新增数据源」运行的产物（`docs/verification/create-source/`、`docs/property-register-sources.md`、提交 `2f49ffd`）
- **问题树**
  1. 流程站（S0–S5）里，哪些出口判据**当场不可执行**或需要临场补规则？
  2. 工具/脚本层（`check-register.mjs`、`check-paths.mjs`、`check.sh`）暴露了哪些失效面？
  3. 假绿（false green）类摩擦：哪些是技能本该防住、却没防住的？
  4. 收据/模板与门禁之间有没有对不上的地方（时序、词汇、字段）？
  5. 文档自身的一致性（自引用、改名残留）由谁守？
  6. 本次交付物本身有没有被这些缺口放过（即：审计能不能改出交付物的错）？

- **不在范围内**：add-source 功能是否好用；技能整体的质量评分；外部先例（那是上一轮 `2026-11-23-add-source-ui` 的题目）。
- **claim_level**：`L1_primary_local_artifacts` —— 一手文件逐行读 + 机器复跑（不做二手转述，不依赖检索摘要）。
- **终止状态**：`completed`（21 条关键陈述全部可回到文件行号或机器输出；0 条 unsupported/inconclusive；2 条设计判断按 normative 降级在正文里陈述）。
