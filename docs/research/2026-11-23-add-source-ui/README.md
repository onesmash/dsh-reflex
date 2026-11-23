# 加数据源这个界面：交互与命名有没有先例（research-nex · Flash）

**terminal_state = `degraded_completed`**（claim_level `L2_manual_reconstruction`）

为什么要跑这一轮：`/research-nex` 在第一版实现时被跳过 —— 只做了几次 web_search 就开写，
既没出 brief / source_matrix / claim_evidence_map，也没按 skill 的 Fail-Closed 约定报告一个
terminal_state。这份目录是补的收据，不是补的故事。

## 读了什么

| 来源 | 类别 | 等级 |
|---|---|---|
| [Zapier: What is a Zap?](https://help.zapier.com/hc/en-us/articles/8496309697421-What-is-a-Zap) | 官方产品文档 | A |
| [IFTTT: How do I create Applets?](https://help.ifttt.com/hc/en-us/articles/37244134754459-How-do-I-create-Applets) | 官方产品文档 | A |
| [n8n Poll mode options](https://raw.githubusercontent.com/n8n-io/n8n-docs/be6702d26245396df6b2fcfeb6394576a7ce3326/_snippets/integrations/builtin/poll-modes.md) | 官方文档源文件 | A |
| [Home Assistant: Config flow](https://contributors.home-assistant.io/core/integrations/config-flow/) | 官方贡献者文档 | B（正文抓取被导航截断，关键句取检索摘要） |

## 结论（每条都能回到上面某个来源）

1. **TRIGGER 有先例**：Zapier（trigger + action）、IFTTT（Trigger + Action）。
2. **EVERY 有先例**：n8n 把轮询间隔直接命名为 `Every X` / `Every Hour` / `Every Day`。
3. **"创建前先试"有先例**：Zapier 的 Build → Test → Publish；Home Assistant 的 config flow
   在 config entry 存在之前就完成校验。→ 支持界面上的「试跑」必须在创建之前。
4. **"首跑不倒历史"有先例**：Zapier 明说「只处理发布之后的新数据」。→ 支持我们采集器首跑只建水位。
5. **FEED 没有先例**：四家官方文档里都没有把"数据来源"这一段叫 feed 的用法。它是本插件自造的词，
   `C6` 只能是 `inconclusive`（"没找到"≠"不存在"）。

## 诚实边界

- `C7`（三段式与 trigger + action + poll cadence 同构）是**规范性判断**，不是可核验事实，记 `partially_supported`。
- `C6` 的反例集是"这四家没这么叫"，换一组工具（Airflow / Huginn / Node-RED）可能翻案，见 `continuation_plan.json`。
- 这一轮不改设计：它确认了两条（TRIGGER、EVERY）有先例、一条（FEED）是我们的命名选择。

## 怎么核

```sh
python3 <research-nex>/scripts/research_nex_validate_statement_audit.py \
  --out-dir docs/research/2026-11-23-add-source-ui \
  --schema-dir <research-nex>/schemas
# PASS statement_support_matrix.json
# PASS unsupported_statement_register.json
# FACT citation_accuracy=0.8333 effective_citations=4 network_unavailable=True
```

`unsupported_statement_register.json` 是**空的**（`entry_count: 0`）：没有一条事实断言被判定为
"无支撑却当成结论发布"；`C6` 是 `inconclusive`，`C7` 是 `normative`，按 skill 的规则都不进这个表。
