---
name: layered-agent-datasource
description: "为分层智能体(ds-bot-layered-agent)添加新的数据源/监控指标。Use when the user asks to add a new data source, new collector, new metric to monitor, 添加数据源, 新数据源, 采集 xxx 数据, 监控 xxx, 写一个收集脚本. Provides the DATASOURCE contract: collector script format, auto-discovery, config enablement. 完整契约/模板/验证清单在此 skill 内自包含；本机路径均由环境约定（LAYERED_HOME / $HOME）推导，不写死绝对路径。"
version: 1.1.0
---

# 添加分层智能体数据源

当用户要添加新的数据源/监控指标时，按此规则执行。本 skill **自包含**——核心契约、模板、验证清单都在这里，不依赖任何本机绝对路径。

## 关键路径（全部由环境约定推导，不写死）

| 用途 | 路径（约定） | 说明 |
|---|---|---|
| 统一目录 | `$HOME/.dsh/bot/layered-agent/`（环境变量 `LAYERED_HOME`） | 数据源的家：`collectors/` 脚本、`facts/` 数据、manifest、状态文件 |
| 配置启用 | `$DSH_HOME`（默认 `$HOME/.dsh`）`/profiles/<当前 profile>/cordis.patch.yml` | 在 `layered-agent.l0.sources` 声明启用 |
| 代码/详细规则 | 插件安装目录（见下方"定位插件安装目录"） | `DATASOURCE.md` 随代码版本走，是详细版 |
| 本 skill | `~/.agents/skills/layered-agent-datasource/` | 由插件 install() 自动部署，随代码更新 |

> 定位插件安装目录：Bot 收到本 skill 时若需读详细规则 `DATASOURCE.md`，用 `npm ls ds-bot-layered-agent`（在 profile 目录）或从运行报错中的文件路径反推，或直接读取 `$HOME/.dsh/bot/layered-agent/manifest.json`（L0 自描述，给出了数据源布局）。不要假设某个固定的源码 checkout 路径。

## 核心流程（4 步，不改插件核心代码）

1. **写 collector 脚本** → 丢进 `$HOME/.dsh/bot/layered-agent/collectors/<name>.sh`
   - stdout 每行一个 JSON fact：`{"metric","raw","meta"?}`
   - source/ts 由插件补；脚本可读注入环境（`LAYERED_HOME`/CA 证书/PATH）
   - 脚本要幂等（多次调用不重复，如 mail 用 seen 去重）
2. **配置启用** → 当前 profile 的 `cordis.patch.yml` 里 `layered-agent.l0.sources` 加 `<name>`
3. **验证** → 重启后日志出现 `auto-discovered script sources: [... <name>]`；数据进 `facts/<name>/`
4. **（可选）增强**：
   - manifest `sourceSchema` 登记字段（让 L2 自主推理看懂）
   - `TARGETS` 加 target（异常时唤醒 L2）——只有这层需要 JS 代码

## Collector 契约

- **输出**：stdout 每行一个 JSON fact：`{"metric":"<m>","raw":{...},"meta":{...}}`；`source`/`ts` 由插件补齐
- **环境**：插件注入 `LAYERED_HOME`（统一目录）、IM 内部 CA（`SSL_CERT_FILE`/`CURL_CA_BUNDLE`/`REQUESTS_CA_BUNDLE`）、常用 PATH
- **行为**：退出 0 + 空输出 = 本轮无数据（正常）；退出非 0 = 记 `L0 <name> failed`，不影响其他源；必须幂等
- **自动发现**：插件启动扫描 `collectors/`，每个 `*.sh` 自动注册为源（源名 = 文件名去 `.sh`）；可选 `<name>.env.json` 提供 `{intervalMs, env}` 覆盖

### 模板

```bash
#!/bin/bash
# 数据源: <名称> — 一句话说明采集什么
DATA="$(your-collector-command)"
cat <<EOF
{"metric":"<metric>","raw":{...},"meta":{"provider":"<来源>"}}
EOF
exit 0
```

## 验证清单

- [ ] `collectors/<name>.sh` 可执行（`chmod +x`），单独跑输出合法 JSON line
- [ ] 加到 `l0.sources` 后，重启日志出现 `auto-discovered script sources: [... <name>]`
- [ ] 数据写入 `$HOME/.dsh/bot/layered-agent/facts/<name>/`
- [ ] manifest `sources` 列出 `<name>`，schema 可见（若登记了）
- [ ] 多次采集不重复（幂等）

## 注意

- 先看现有脚本参照：`collectors/` 下 `uptime.sh`（最简单）、`net.sh`（系统命令+meta）、`mail.sh`（有状态去重+内部 API）
- 敏感数据（如邮件）只采元数据，不落正文
- 详尽的契约、schema 登记、L1 target 做法见插件安装目录的 `DATASOURCE.md`
