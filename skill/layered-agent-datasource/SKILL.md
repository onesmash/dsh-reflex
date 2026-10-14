---
name: layered-agent-datasource
description: "为分层智能体(ds-bot-layered-agent)添加新的数据源/监控指标。Use when the user asks to add a new data source, new collector, new metric to monitor, 添加数据源, 新数据源, 采集 xxx 数据, 监控 xxx, 写一个收集脚本. Provides the DATASOURCE contract: collector script format, auto-discovery, config enablement. The rule source of truth is ~/SourceCode/ds-bot-layered-agent/DATASOURCE.md (随代码版本走)."
version: 1.0.0
---

# 添加分层智能体数据源

当用户要添加新的数据源/监控指标时，按此规则执行。

## 规则源（唯一事实来源）

- **契约文档**: `~/SourceCode/ds-bot-layered-agent/DATASOURCE.md`（随插件代码版本走，Git 管理）
- **代码**: `~/SourceCode/ds-bot-layered-agent/index.js`
- **统一目录**: `~/.dsh/bot/layered-agent/`（collectors/ 脚本、facts/ 数据、manifest 等）

> 规则以 DATASOURCE.md 和代码为准；本 skill 只是引导入口，细节按文档执行。

## 核心流程（4 步，不改插件核心代码）

1. **写 collector 脚本** → 丢进 `~/.dsh/bot/layered-agent/collectors/<name>.sh`
   - stdout 每行一个 JSON fact：`{"metric","raw","meta"?}`
   - source/ts 由插件补；脚本可读注入环境（LAYERED_HOME/CA 证书/PATH）
   - 脚本要幂等（多次调用不重复，如 mail 用 seen 去重）
2. **配置启用** → `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `layered-agent.l0.sources` 加 `<name>`
3. **验证** → 重启后日志出现 `auto-discovered script sources: [... <name>]`；数据进 `facts/<name>/`
4. **（可选）增强**：
   - manifest `sourceSchema` 登记字段（让 L2 自主推理看懂）
   - `TARGETS` 加 target（异常时唤醒 L2）—— 只有这层需要 JS 代码

## 注意

- 先看现有脚本参照（`collectors/uptime.sh` 最简单、`mail.sh` 有状态去重）
- 敏感数据（如邮件）只采元数据，不落正文
- 详尽的契约、模板、验证清单见 `DATASOURCE.md`
