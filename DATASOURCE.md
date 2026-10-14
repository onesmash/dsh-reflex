# 添加数据源规则（DATASOURCE 契约）

> 本文档是 `ds-bot-layered-agent` 插件的官方规则，随代码版本走（Git 管理）。
> Bot（L2/Chief）在「添加数据源」任务触发时，通过同名 skill 自动加载。
> 本机路径不在文档中写死：统一目录用环境变量 `LAYERED_HOME`（默认 `$HOME/.dsh/bot/layered-agent/`）；插件安装目录可由 `npm ls ds-bot-layered-agent` 或运行报错路径定位。

## 1. 规则速览

| 步骤 | 做什么 | 是否需要改代码 |
|---|---|---|
| 1 | 写一个 collector 脚本（`.sh` 或内置） | 否 |
| 2 | 把脚本放到 **统一目录** `~/.dsh/bot/layered-agent/collectors/` | 否 |
| 3 | 在 `cordis.patch.yml` 的 `l0.sources` 里启用它 | 否（只改配置） |
| 4 | （可选）写 `<name>.schema.json` 让该源在 manifest 里自描述 | 否 |
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
- 可选 companion `<name>.env.json` 提供该源的 `{intervalMs, env, timeoutMs}` 覆盖
- 可选 companion `<name>.schema.json` 自描述字段 → 自动进 manifest 的 `sources[].schema`，供 L2 自主推理看懂

### `<name>.env.json`

```json
{ "intervalMs": 900000, "timeoutMs": 120000, "env": { "MY_VAR": "x" } }
```

- `intervalMs`：该源独立采集间隔（默认跟随 `l0.scriptIntervalMs`，60s）
- `timeoutMs`：**脚本执行超时，默认只有 20s**。凡是启停外部进程/浏览器的脚本（如 `feed-timeline.sh`）
  必须在这里放宽，否则会被杀在半路
- `env`：额外注入的环境变量

### `<name>.schema.json`

```json
{ "metric": "post", "fields": { "id": "推文id", "text": "正文" }, "notes": "可选说明" }
```

写它的好处：L2 读 `facts/manifest.json` 就能知道这个源有什么字段、能查什么，无需读脚本源码。
**这是一个纯数据文件，加源依然不用改插件代码。**

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

### 可选：写 schema 让 L2 看懂该源

在同一个 `collectors/` 目录放一个 `<name>.schema.json`（内容见 §3），manifest 会自动收录。
**不需要改任何 JS 代码。**

## 5.1 需要登录态的源（浏览器/账号类）

有些源（如 `feed-timeline`）没有 API token，靠浏览器登录态采集。约定做法：

1. 登录态存成 JSON state 文件放统一目录，如 `$LAYERED_HOME/feed-timeline-state.json`
2. 写一个**导出工具**放 `$LAYERED_HOME/tools/`（不要放 `collectors/`，那会被当成数据源）
   参考 `tools/x-export-state.sh`：从本机 Chrome 复制 profile 副本 → 起带调试端口的 Chrome
   → CDP 导出明文 cookie → 只保留目标站点 → 落盘 600 权限
3. collector 用 `agent-browser --session <私有会话名> --state <state 文件>` 采集，**用完 `close`**
   （不要常驻 headless 浏览器，占内存）
4. **会话过期必须是非 0 退出**——让它记 `L0 <name> failed`，绝不能把空数据伪装成"没有新事件"
5. 该源至少要 `intervalMs`（登录态类通常 10-15 分钟）+ `timeoutMs`（启浏览器需要 60-120s）

## 5.2 增量源的时间线必须稳定

采集"最新 N 条"时，先确认该列表**多次加载结果一致**（时间倒序流）。

- ✅ `https://x.com/search?q=filter:follows&f=live` — 按时间倒序，三次加载 id 集合完全相同
- ❌ `https://x.com/home`（"为你推荐"）— 算法流，每次加载都返回一批不同的旧推文，
  轮询会持续吐"新"噪音且丢掉真正最新的

另外注意**虚拟列表**（如 X 的时间线）：滚动会把顶部条目挤出 DOM。
需要更多条目时，正确顺序是「先取顶部快照 → 再滚动 → 再取一次 → 合并去重」，
不能"先滚动再取"。

## 6. 可选：参与 L1 决策（唤醒 L2）

只采集供查询的源完全不用做这一步。要让源能唤醒 L2，在 `TARGETS` 注册表加一个 target：

```js
'mysource': {
  name: '显示名',
  collect: async (facts) => { /* 组装决策 context；无内容返回 null */ },
  interim: (ctx) => /* 硬规则: 命中即唤醒, 跳过 SemIf */,
  semif: { question, options },   // 无硬规则时走这条: 需要 id 为 'yes' 的 option
  render: (ctx, extra) => '给 L2 的结构化通知文本',
}
```

然后配置启用：`l1.targets: [disk, mysource]`。

### 六个必须遵守的点

1. **`stateFingerprint` 必须为新 target 补一条分支**。框架里只有 `disk` 有指纹；
   新 target 若不补，`fp` 恒为 `null` → `contentChanged()` 恒返回 true → **每轮都唤醒**，直接刷屏。
   文本/内容类源的指纹取「本次命中条目的 id 集合」。
2. **内容源要设唤醒硬上限 `minIntervalMs`**：值得看的消息可能每轮都有，但人不能被每 15 分钟
   打断一次。**缺省值应跟随该源的采集间隔**（用框架的 `sourceIntervalMs('<source>')` 读
   `<name>.env.json` 的 `intervalMs`），而不是写死一个数字 —— 每轮采集最多叫醒一次，
   比采集勤没意义（根本没新数据），比采集慢太多又会把窗口拖过头。
   ⚠️ **别在 `DEFAULTS` 里给它写死默认值**：DEFAULTS 会合并进 cfg，写死了
   `cfg...?.minIntervalMs ?? sourceIntervalMs(...)` 的回落分支就永远不生效。
   两种行为，看 target 有没有声明 `mergeCtx`：
   - **没声明**：冷却期内直接短路，连 `collect` 都不跑 —— 省算力，但那几轮的命中项**会漏报**
   - **声明了**（推荐给内容源）：冷却期内照常筛选，命中项攒进 `pending-wakes.json`，
     冷却期一到就合并成**一条摘要**发出，不漏报。`mergeCtx(prev, next)` 负责去重合并，
     并给出 `carried`（其中多少条是攒下的）供 `render` 说明窗口
3. **SemIf 判据要拿真实历史数据校准，不要拍脑袋写**。方法：把已入库的 facts 逐条拼成
   `{id, state, question, options}` 跑一次 `run_score.sh`（可批量），看 p(yes) 分布。
   实测结论（qwen3.5-4b）：
   - 短判据（一句话）→ 概率整体被压低（最高 0.59），**永远不触发**
   - 只写"与我相关"→ 模型理解成泛泛相关，触发率过高（≈18%），每轮都想唤醒
   - **收紧判据比调高阈值更容易把 target 压死**。要改的是措辞，不是阈值
   - 加用户画像（`l1.profile`）效果显著：同一条推文从 0.978 掉到 0.130，
     所以画像里的措辞直接决定灵敏度，别写得太窄（写成"只关心雇主相关"就永不触发了）
4. **逐条筛选要用批量 SemIf**（`semifScoreBatch`）：一次进程只加载一次模型给 N 条打分，
   比 N 次单调用快得多。跑完把结果放进 `ctx`，用 `interim: ctx => !!ctx.notable?.length`
   + `interimReason: '...'` 直接进唤醒，**不要再让框架跑第二次 SemIf**。
5. **通知要自包含**：L2 无状态，`render` 必须把判定依据、条目原文、链接、触发原因
   和 L0 入口（`manifest.json`）都写进去。
6. **攒了就必须发得出去**。`decideOnce` 在**没有新事实**时也要继续跑 —— 否则「冷却期内攒了，
   但之后一直没新数据」的 pending 会永远躺在文件里发不出去。框架已按
   `facts 为空 && pending 为空` 才提前返回处理；自己加 target 时不要在开头无脑 `return`。
   被限流那轮的原始数据本身一直在 L0 facts 里，L2 可经 manifest 自主回查。

### 验证（别只看"跑通了"）

用 mock `sessionController` 起一个 harness，喂真实历史 facts 调 `decideOnce()`，至少验三件事：

- [ ] 该命中的命中、该挡的挡住（看 render 出来的通知正文）
- [ ] **同一批内容重放 → 必须被抑制**（0 投递），否则就是第 1 条踩坑了
- [ ] 没声明 `mergeCtx` 的 target：`minIntervalMs` 生效时秒返回，不跑 SemIf
- [ ] 声明了 `mergeCtx` 的 target：冷却期内命中项进 `pending-wakes.json`；
      **把上次唤醒时间改到冷却期之前、且不给任何新数据再跑一次 → pending 必须被补发出去并清空**
      （这条是累积机制里最容易永远发不出去的地方，必须单独验）

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
| `collectors/feed-timeline.sh` | 浏览器登录态采集 + 时间线稳定性 + 虚拟列表两段式快照 + timeoutMs 放宽 |
| `tools/x-export-state.sh` | 从本机 Chrome 导出站点登录态（Chrome 136+ 禁默认 profile 调试的绕法） |
