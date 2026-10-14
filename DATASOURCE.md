# 添加数据源规则（DATASOURCE 契约）

> 本文档是 `ds-bot-layered-agent` 插件的官方规则，随代码版本走。
> Bot（L2/Chief）在「添加数据源」任务触发时，通过同名 skill 自动加载本文档。
> 以 `~/SourceCode/ds-bot-layered-agent/` 代码为唯一事实来源。

## 1. 规则速览

| 步骤 | 做什么 | 是否需要改代码 |
|---|---|---|
| 1 | 写一个 collector 脚本（`.sh` 或内置） | 否 |
| 2 | 把脚本放到 **统一目录** `~/.dsh/bot/layered-agent/collectors/` | 否 |
| 3 | 在 `cordis.patch.yml` 的 `l0.sources` 里启用它 | 否（只改配置） |
| 4 | （可选）脚本的 schema 登记进 manifest `sourceSchema` | 是（仅一处） |
| 5 | （可选）加 L1 target 让它参与决策唤醒 | 是（仅当要决策） |

**核心原则**：加数据源 = 写脚本 + 配置启用，**不改插件核心代码**。

## 2. Collector 契约（脚本必须遵守）

脚本是**自包含的可执行文件**（shebang + 可执行位），每个采集周期被插件调用一次：

### 输出契约（stdout）
- 每行一个 JSON fact，形如：
  ```json
  {"metric": "your-metric", "raw": {...}, "meta": {"optional": ...}}
  ```
- **`source` 由插件按脚本文件名补齐**（不写也行；写了会被覆盖）
- **`ts`（时间戳）由插件补齐**
- `raw` 是任意 JSON 值——**采集的真实数据都放这里**
- `meta` 可选，放非数据信息（来源、类型等）

### 环境契约（插件注入到脚本进程）
- `LAYERED_HOME`：统一目录 `~/.dsh/bot/layered-agent/`——脚本用它定位自己的状态文件
- `SSL_CERT_FILE` / `CURL_CA_BUNDLE` / `REQUESTS_CA_BUNDLE`：IM 内部 CA（访问内部 API 必需）
- `PATH`：已含 `/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin`

### 行为约定
- 退出码 0 + stdout 为空 = 本轮无数据（正常，比如无新事件）
- 退出码非 0 / 异常 = 插件记录 `L0 <name> failed`，不影响其他源
- **脚本要自带幂等/去重**：多次调用不应产生重复事实（如 mail 用 seen 文件）

## 3. 脚本源自动发现

插件启动时扫描 `collectorsDir`（= 统一目录 `collectors/`）：
- 每个 `*.sh` 自动注册为一个源，**源名 = 文件名（去 `.sh`）**
- 可选 companion `<name>.env.json` 提供该源的 `{intervalMs, env}` 覆盖（仅当需要非默认配置才加）

## 4. 常见脚本模板

```bash
#!/bin/bash
# 数据源: <名称> — 一句话说明采集什么
# 契约: stdout 每行一个 JSON fact; source/ts 由插件补

# 采集你的数据...
DATA="$(your-collector-command)"

cat <<EOF
{"metric":"<metric>","raw":{...你的字段...},"meta":{"provider":"<来源>"}}
EOF
exit 0
```

## 5. 启用（配置层，不改代码）

在 `~/.dsh/profiles/desktop/cordis.patch.yml`：
```yaml
- id: layered-agent
  config:
    l0:
      sources:
        - disk
        - mail
        - <你的新源名>
```

### 可选：登记 schema（让 L2 自主推理能看懂该源）

在 `index.js` 的 `sourceSchema` 加一行（这是加源唯一可选的代码改动）：
```js
yourname: { metric: '<metric>', fields: { key: '含义', ... } },
```

## 6. 可选：参与 L1 决策（异常唤醒）

若要让该源在异常时唤醒 L2，额外在 `TARGETS` 注册表加一个 target（collect/interim/semif/render）。
只有这一层才需要 JS 代码——若只采集供查询，完全不用。

## 7. 验证清单

- [ ] `collectors/<name>.sh` 可执行（`chmod +x`），单独跑输出合法 JSON line
- [ ] 加到 `l0.sources` 后，重启插件日志出现 `auto-discovered script sources: [... <name>]`
- [ ] 数据写入 `~/.dsh/bot/layered-agent/facts/<name>/`
- [ ] manifest `sources` 列出 `<name>`，schema 可见（若登记了）
- [ ] 多次采集不重复（幂等）

## 8. 示例参照

| 脚本 | 展示 |
|---|---|
| `collectors/uptime.sh` | 最简单：单条 metric 的静态脚本 |
| `collectors/net.sh` | 用系统命令采集、带 meta |
| `collectors/mail.sh` | 有状态（seen 去重）+ 内部 API + 独立 env |
