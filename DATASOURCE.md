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
| 5 | （可选）写 L1 target 脚本放 `targets/`，在 `l1.targets` 启用 | 否 |
| 6 | （极少）target 需要趋势计算/跨源关联时才写进插件 `TARGETS` | 是 |

**核心原则**：加数据源 = 写脚本 + 配置启用，**不改插件核心代码**。
L0 采集和 L1 判定**都是脚本驱动的**，两者同一套契约（自动发现、`.env.json`、env 注入、超时、失败隔离）。

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

- `intervalMs`：该源独立采集间隔（默认跟随 `l0.scriptIntervalMs`，60s）。
  **只有比采集节拍（`l0.intervalMs`）更长的间隔才会被额外节流** —— 扫描循环会给每个脚本源都
  塞上默认 `intervalMs`，若不比较就当成独立间隔，抖动会让 60s 的源变成 120s 才跑一次。
  ⚠️ 浏览器类源必须在这里设成分钟级（如 900000），否则会按节拍每分钟启停一次 Chrome。
- `timeoutMs`：**脚本执行超时，默认只有 20s**。凡是启停外部进程/浏览器的脚本（如 `feed-timeline.sh`）
  必须在这里放宽，否则会被杀在半路
- `env`：额外注入的环境变量

> **双重节流**：调度器按 `intervalMs` 控制调用频率；**脚本自己也应该自节流**
> （记一个 last-run 时间戳，没到间隔就 `exit 0`）。因为脚本每次都是重新执行的，
> 自节流的改动**不需要重启插件**就能生效 —— 是调度器出问题时的兜底。
> 参考 `feed-timeline.sh` 的"自节流"段落。

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

## 5.3 没有「批量入口」的源（逐会话扫描）

有些源只提供**单会话**查询（IM Team Chat 就是：`message_fetch` 只收一个 `session_id`，
没有"取所有会话最近消息"的接口，`msg_search` 又强制要求 keyword）。这类源只能逐会话扫。

要点：

- **先量清楚成本再定间隔**。实测 28 个私聊会话全扫 ≈ 34 秒，所以该源 `intervalMs` 设 15 分钟。
  把实测数字写进脚本注释 —— 后面的人调间隔时要靠它判断
- **单会话失败不能中断整轮**：每个会话 try/except 包住，否则一个 403 会让整个源当轮无数据
- **首次运行只建水位、不产历史**，否则第一次就把几千条历史倒进 L0。
  要回填历史用专门的环境变量（如 `LAYERED_IM_BACKFILL_MIN`），不要靠改代码
- **逐会话拉取要限量**（如每会话只取最近 3 个线程），否则线程多的会话会拖垮整轮

## 5.4 服务端不告诉你「具体是哪一条」

IM 的 `msg_mention_me_fetch` 只返回"这个线程里有人 @ 过你"，**不标记具体哪条消息**。
同一线程的后续普通讨论也会一起返回。若不处理，采集会被同线程闲聊灌满。

做法：先看真实数据找规律，再用可配置的别名收紧。实测真正的提及消息都含 `@`，
而同线程的普通讨论不含 —— 先用"含 @"近似，再用 `LAYERED_IM_MENTION_ALIASES`
（本人名字 + 所在的提及组）精确匹配。效果：2 天样本从 122 条降到 39 条，且 39 条全部相关。

> 教训：服务端语义模糊时，**别猜，先拉一批真实数据统计**（数一数 @ 后面到底跟的是谁），
> 别名表就是从统计里得出来的，不是拍脑袋写的。

## 5.2 增量源的时间线必须稳定

采集"最新 N 条"时，先确认该列表**多次加载结果一致**（时间倒序流）。

- ✅ `https://x.com/search?q=filter:follows&f=live` — 按时间倒序，三次加载 id 集合完全相同
- ❌ `https://x.com/home`（"为你推荐"）— 算法流，每次加载都返回一批不同的旧推文，
  轮询会持续吐"新"噪音且丢掉真正最新的

另外注意**虚拟列表**（如 X 的时间线）：滚动会把顶部条目挤出 DOM。
需要更多条目时，正确顺序是「先取顶部快照 → 再滚动 → 再取一次 → 合并去重」，
不能"先滚动再取"。

## 6. 可选：参与 L1 决策（唤醒 L2）

只采集供查询的源完全不用做这一步。

### 6.1 脚本 target（推荐，与 collector 同构）

把 `<targetsDir>/<name>.sh` 放好 + 配置 `l1.targets` 启用，**不用改插件代码**。

职责分界 —— 这是本设计的关键，别混：

| | 谁做 | 为什么 |
|---|---|---|
| **判定 + 条目内容** | **脚本** | 组装 context、调 SemIf、按阈值筛、产出 `items` |
| **投递纪律** | **插件** | 指纹去重、冷却、`minIntervalMs` 节流、pending 累积合并、投递 |
| **排版信封** | **插件** | 标题/编号/合并说明/L0 入口 —— `"其中 N 条为冷却期累积"` 来自插件跨轮统计，脚本不知道；且信封对所有 target 是同一套，复制进脚本必然漂移 |

**契约**：stdin 收到本轮新事实（JSONL）；stdout 输出一行 JSON；无输出 = 本轮不唤醒；非 0 退出 = 记 `L1 <name> failed`。

```json
{ "wake": true,
  "reason": "SemIf 逐条筛选命中 (阈值 0.8)",
  "fingerprint": { "ids": ["2110377288923758975"] },
  "scanned": 12,
  "header": "可选：target 专属副标题",
  "items": [ { "id": "2110377288923758975",
               "title": "@someone · 08:56 · 相关度 0.94",
               "body": "正文…\nhttps://x.com/...\n互动: …" } ] }
```

- **`items[].id` 是合并去重的依据** —— 没有它，插件无法跨轮去重，同样的内容会被重复列出
- `items` 按你希望的展示顺序排；合并时**新一轮的 items 排在前面**
- 想全权排版可以改输出 `{"notice": "整段文本"}`：插件原样投递，但**冷却期累积时只能把多段粗暴拼起来**
  （自由文本没法跨轮去重）。要结构化合并就得用 `items`。
- 脚本不必自己判重、不必输出标题栏/编号/L0 入口 —— 那些是插件的事

插件注入的环境：`LAYERED_HOME`、`LAYERED_PROFILE`（用户画像）、`LAYERED_SEMIF_RUN`（SemIf 打分脚本路径，
**别写死路径**）、`LAYERED_TARGET`、IM 内部 CA、完整 PATH。

`<name>.env.json`（可选，与 collector 同规则）：`{ "displayName": "X 关注流", "timeoutMs": 180000,
"minIntervalMs": "auto", "env": { "LAYERED_X_THRESHOLD": "0.9" } }`

- `minIntervalMs: "auto"` = 跟随同名采集源的采集间隔（每轮采集最多叫醒一次）；缺省即 auto（若存在同名源）
- **建议声明 `sources: ["<源名>"]`**：本轮新事实里没有该源的数据时，插件**连脚本都不起**。
  不声明的话 target 脚本会被每分钟空跑一次 —— 因为 disk 每分钟产出一条事实就会触发一轮决策，
  而脚本对那批事实根本不关心。声明后也顺带让"上次真正扫了几条"这类运行标记变得可信。
- **防重入**：脚本跑得比 `l1.intervalMs` 还久时，插件会跳过本轮而不是并发跑两轮（并发会读到同一批事实重复唤醒）

### 6.2 内置 target（`TARGETS` 注册表，需要计算逻辑时）

像 `disk` 那样要做趋势计算、跨源关联的，才写进插件的 `TARGETS`：

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

### 6.3 跨源关联的 target（源 A 的信息要判断"跟我有关吗"）

典型场景：频道消息里出现一个票号，但"这个票号是不是我的"只有另一个源知道。
（实例：`tickets-progress` —— release 排期 × 我的 工单系统 任务。）

**关键约束：target 脚本只拿到本轮新事实，没有历史。** 判"频道这条提到我名下的票"
需要"我名下有哪些票"这份**存量**数据，它不在本轮事实里。存量从哪来：

**从采集器的状态文件读 —— 这是同一个脚本源自己的状态，不是新机制。**

```
collectors/工单-my-tasks.sh   →  state/工单-my-tasks-state.json   (票号 → {status, fixVersion})
                                  ↓ target 直接读它当上下文
targets/tickets-progress.sh   →  判断"频道消息里的票号 ∈ 这个集合"
```

为什么这么设计：

- **不重新调 API**：再调一次要重复鉴权、重复错误处理，还多一次网络往返
- **状态文件是单一事实来源**：采集器和 target 用同一份数据，不会因为两次调用时间差而不一致
- **反面参考**：如果让 target 自己去查 工单系统，prompt/凭据就散到两处了 —— 这是最容易忘的一条

**代价（必须知道）**：状态文件的**格式成了采集器与 target 之间的契约**。
改采集器状态结构时，必须同步改读它的 target，否则 target 静默读到空 → 判定永不命中。
（而且不会报错 —— 是那种"看起来在跑"的失败。）

**结论链**：频道里出现你的票号 → 直接相关；排期词 + @我 → 排期会砸到你；
你的票进入卡点状态 → 进度停滞；**你版本上的排期信息 → task 安排会被影响**。
**四类都是可验证的事实，不需要模型去"理解"。**

#### 判据必须锚定，否则"相关信息"就是噪音

`tickets-progress` 的第 4 类信号（你版本上的排期）最容易写坏。该频道**每条消息几乎都带
版本号和日期** —— 写成"消息含日期 + 排期词就报"会全量命中。

实测数据（近 2 天 15 条消息）：

```
7.2.5   出现 11 次   ← 别人的版本（都在找 @REDACTED 批 scope）
7.3.0   出现  1 次   ← 用户真正在做的版本
```

**所以判据锚定在"用户 fixVersion 里实际存在的版本"上，而不是"任何版本"。**

三个条件同时成立才算：**① 有日期 + ② 有排期动作词 + ③ 版本属于用户**。
少任何一个都不报 —— 缺 ③ 就是刷屏，缺 ①② 就是普通讨论。

同类教训在前面的源上出现过（5.3 逐会话扫描的量级问题、5.4 服务端不标具体是哪条）：
**先量一下数据分布，再定判据。拍脑袋的判据在真实数据上不是漏就是吵。**

顺带一条：这类判据依赖正文里的日期，所以**采集器的正文截断长度要考虑判据需要**。
一开始定 300 字符，长消息里的日期会被切掉 → 判定静默失败。现放宽到 600。

### 6.4 打标放在采集层，别丢给 L1

能从文本直接算出来的结构化事实 —— **票号正则、版本号、是否 @我、有无附件** ——
应该在 **collector 里算好存成字段**，而不是让 L1 的本地小模型去数正则。

理由：

1. **确定性**：正则是精确的，小模型对"这条提到几个票号"是不稳定的
2. **省钱**：采集时算一次，所有消费方（target / L2 自主推理）都能用
3. **判定变简单**：target 里只剩集合判断和比较，不需要 SemIf —— 而 SemIf 是有成本的

对应地，**collector 不为"取舍"负责**：它忠实采集并打标，判断"哪条跟我有关"留给 L1。
采集层做取舍会漏数据，而漏掉的那条可能正是排期。

### 6.5 target 的测试必须有反例

只验正例（"该报的报了"）是不够的 —— 那只能证明通路，不能证明**它不会乱叫**。
`tickets-progress` 的测试是 3 正例 + 4 反例，反例包括：别人名下的票号、有排期词但没 @我、
我的票没变化、我的票变成 Done（好消息不该占注意力）。

**反例不过的 target 不要上线** —— 噪音是这套系统最常见的死法（参见 5.3 / 5.4 的教训）。

### 安静时段（quietHours）

工作之外不打扰，但也不丢消息 —— 靠**复用 pending 累积**实现，不额外写调度：

```yaml
l1:
  quietHours: { from: "18:00", to: "09:00" }   # 支持跨午夜
```

- 安静时段内，**内容类** target 的命中不进唤醒，直接走已有的 pending 队列
- 时段结束后的第一次决策，pending 自动合并成**一条摘要**发出（"睡醒看隔夜汇总"）
- **硬规则 target 通过 `interruptAlways: true` 穿透** —— 磁盘满这类事没有"上班再说"
  （内置 disk target 已标注；脚本 target 在 `<name>.env.json` 里写 `"interruptAlways": true`）
- 与 `minIntervalMs` 是同一类限制（都产生 pending），实现上合并成一个 `limited` 判断

> 为什么必须做这件事：内容类命中（AI 新闻、同事私聊）本身都"值得知道"，
> 但半夜推三次之后，人会开始无视整个通知渠道 —— 而同一个渠道还承担着磁盘告警。
> **和不要紧的消息混在一起按时段无差别推送，最后会一起被无视掉。**

### 六个必须遵守的点

> 第 1、2、4 条针对**内置 target**（`TARGETS` 注册表）。脚本 target 由插件统一处理指纹兜底、
> 闸门与合并，脚本只要把 `items[].id` 填对即可 —— 但第 3、5、6 条对两者都成立。

1. **`stateFingerprint` 必须为新 target 补一条分支**。框架里只有 `disk` 有指纹；
   新 target 若不补，`fp` 恒为 `null` → `contentChanged()` 恒返回 true → **每轮都唤醒**，直接刷屏。
   文本/内容类源的指纹取「本次命中条目的 id 集合」。
   （脚本 target 有兜底：脚本给的 `fingerprint` → 否则从 `items[].id` 推。**但如果 `items` 里没有 id，
   兜底同样失效**，所以 id 不能省。）
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
   ⚠️ **判据措辞必须与校准时逐字一致**。实测：实现时手滑在 yes 条件里多写一句
   「直接点名该用户的 @提及 也算」，命中立刻从 2/9 涨到 5/9 —— 一句话就能把整批判据抬上去，
   **校准等于白做，而且看不出来**（数字变好了，谁会去怀疑）。改完措辞必须重跑校准。
   同理，喂进模型的**上下文也要与校准时一致**：本次分组上限从"全部消息"改成"最近 8 条"，
   同一个会话的分数就从 0.75 跳到 0.93。校准时的 state 构造方式要原样搬进实现。
   ⚠️ **批量必须分块，一次 ≤40 行**。SemIf 是一次加载模型评 N 条，N 大了内存压力暴涨 →
   macOS 写 swap → **磁盘被吃光**（症状在磁盘，根因在内存，极易查错方向）。
   实测：326 行一次跑 → 48GB 机器 swap 涨到 43GB → 磁盘可用量 3 分钟掉 55GB 到 0.19GB。
   分块示例见 skill。生产 target 每轮受 `maxCandidates` 约束（如 12 条）是安全的，
   **危险只来自临时校准脚本**。
   实测结论（qwen3.5-4b）：
   - 短判据（一句话）→ 概率整体被压低（最高 0.59），**永远不触发**
   - 只写"与我相关"→ 模型理解成泛泛相关，触发率过高（≈18%），每轮都想唤醒
   - **收紧判据比调高阈值更容易把 target 压死**。要改的是措辞，不是阈值
   - 加用户画像（`l1.profile`）效果显著：同一条推文从 0.978 掉到 0.130，
     所以画像里的措辞直接决定灵敏度，别写得太窄（写成"只关心雇主相关"就永不触发了）
4. **逐条筛选要用批量 SemIf**：一次进程只加载一次模型给 N 条打分，比 N 次单调用快得多。
   - 内置 target：用框架的 `semifScoreBatch(rows)`
   - 脚本 target：直接把 N 行写进 `$LAYERED_SEMIF_RUN --input` 的输入文件（见 `targets/feed-timeline.sh`）
   跑完不要**再**让框架跑第二次 SemIf（内置 target 用 `interim` + `interimReason` 直接进唤醒）。
5. **通知要自包含**：L2 无状态，通知必须带判定依据、条目原文、链接、触发原因
   和 L0 入口（`manifest.json`）。信封部分插件会自动补，条目内容归脚本。
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
      ⚠️ **单独跑会烧掉去重窗口**：collector 一跑就把新 id 写进 `seen-*.json`，但那些事实
      没经过插件、没进 L0 —— 等于永久丢一批。**手工测试务必换一个 seen 文件**
      （如 `LAYERED_X_SEEN=/tmp/test-seen.json`），或者事后把多出来的 id 从 seen 里回滚掉。
- [ ] 加到 `l0.sources` 后，重启插件日志出现 `auto-discovered script sources: [... <name>]`
- [ ] 数据写入 `~/.dsh/bot/layered-agent/facts/<name>/`
- [ ] manifest `sources` 列出 `<name>`，schema 可见（若登记了）
- [ ] 多次采集不重复（幂等）

## 7.5 给用户发 IM 通知（输出通道）

插件采集是"输入端"，这里是"输出端"：把需要用户注意的事推到他的 IM。

> ⚠️ **不要把这条通道接进插件的投递路径（`wakeL2`）。**
> L1 的职责只有一条：判断某件事值不值得占用 L2 的注意力，然后唤醒 L2。
> **要不要落到用户手机上、以什么形式落，是 L2 拿到通知之后自己判断的事** ——
> 用户明确纠正过这一点。把 IM 投递焊进 `wakeL2`，等于让 L1 替 L2 决定要不要打扰用户，
> 越过了分层边界。
>
> 正确链路：`L1 判定 → 唤醒 L2 → L2 判断是否推送 → 调 tools/notify.sh`
>
> 同理可推：任何"对人类做动作"的决定都归 L2，L1 只做"值不值得占用 L2"的筛选。
> 唯一的例外是**批量投递**（安静时段的 pending 累积）—— 它必须留在 L1，
> 因为 L2 是无状态的，没人替它暂存。

```bash
~/.dsh/bot/layered-agent/tools/notify.sh "正文"
echo "正文" | ~/.dsh/bot/layered-agent/tools/notify.sh
~/.dsh/bot/layered-agent/tools/notify.sh --tag "磁盘告警" "正文"
```

收件人取 `$LAYERED_IM_NOTIFY_TO` 或 `tools/notify.to`。退出码非 0 会说明原因，
调用方据此决定是否降级到别处投递（比如只留 L0 记录）。

两个必须知道的约束：

1. **消息是"用户发给自己"的**。helper CLI 以用户本人身份认证，没有机器人账号 ——
   消息落在 IM 的"自己/备注"会话里，不会显示成系统/机器人发件人。
   当通知渠道可用（手机端一样有提醒），但别指望它看起来像系统消息。
2. **必须显式用 `text` 模式**。API 默认 markdown，而 markdown 模式**禁止裸 URL** ——
   我们的通知里全是 URL（推文链接 / deep link / L0 入口），用默认模式会失败或变形。
   脚本里已经写死 text 模式。

超过 3200 字符会自动按行分段续发（不切断 URL）—— 这是 API 硬限，超了直接失败。

## 7.6 代用户回复 IM 消息（高风险动作，务必先看这节）

用户要求：私聊超过 5 分钟没回，就代他发一条中性回执，然后告诉他。

**这里有一个必须避开的坑，是实测踩出来的：**

"会话里最后一条不是我发的" 这个条件**不等于**"有人在等我回"。按它实现，一次会标出
**17 个会话** —— 包括对方三个月前发的 `👍`、`好的`、`哦`、`:done:`，以及 2 月、7 月的老消息。
照那个实现，等于替用户给 17 个同事群发回执。

**必须加时间上限**（`LAYERED_IM_ACK_LOOKBACK_MIN`，默认 120 分钟）：
只认"最近这段时间内到达、且仍没人回"的消息。加上之后同一批数据从 17 条降到 0 条。

即便如此，"是否需要回复"仍需判断 —— 实测候选里既真有提问（"这个进度条是走完了对吧"），
也有根本不用回的（`👍`）。**所以判断归 L2，不放进 L1**（分层边界：对人类做动作的决定归 L2）。

链路：

```
collectors/im.sh   每轮扫私聊, 产出 kind=dm-awaiting 事实(带会话id, 5~120分钟窗口, 按消息去重)
      ↓
targets/im-reply.sh  捞出来叫醒 L2, 【不判断、不发送】
      ↓
L2 判断该不该回 → tools/notify.sh --to "<会话id>" "收到，我稍后回复你"
```

`minIntervalMs: 0` + `interruptAlways: true`：回执有时效性，不该被唤醒闸门或安静时段拖到第二天；
而且发回执**不打扰用户本人**，安静时段保护的是用户，不是同事。

> ⚠️ **上线前先跑影子模式。** 给同事发消息不可撤回，且消息以用户本人身份发出。
> 先只提醒不代发，攒够真实候选、看清误判率之后再打开自动发送。
> 样本不足时不要急着给"是否需要回复"定阈值 —— 那只会重演前面几次"拍脑袋阈值"的坑。

## 8. 插件自带的 skill 与部署策略

插件启动时把仓库 `skill/<name>/` **整个目录**递归部署到 `~/.agents/skills/<name>/`
（有的 skill 带 `scripts/`、`assets/` 边车，只拷 `SKILL.md` 会装出个残废）。
排除 `.DS_Store`、`__pycache__`；内容一致的文件不重写；可执行位保留。

策略由 `skill/<name>/.deploy.json` 的 `policy` 决定：

| policy | 适用 | 行为 |
|---|---|---|
| `sync`（默认） | 自有 skill | 内容不同就覆盖，随插件版本走 |
| `seed-only` | 第三方 vendored skill | 只在目标**整个缺失**时安装；已存在则整体跳过 |

`seed-only` 的理由：用户可能装了**更新的上游版本**，插件不能把它悄悄降级成仓库里这份快照。
要强制用仓库这份，先删掉目标目录再重启插件。

当前打包：

| skill | policy | 说明 |
|---|---|---|
| `layered-agent-datasource` | sync | 本插件的加数据源规则，随代码版本走 |
| `semif-decide` | seed-only | L1 决策依赖它打分；vendored 快照（MIT），不随上游自动更新 |

> vendored 快照升级要手工做：重新 rsync 上游 skill 目录，并在 `.deploy.json` 里更新
> `bundledAt` / `upstreamVersion`。别指望它会自己跟着上游走。

## 9. 示例参照

| 脚本 | 展示 |
|---|---|
| `collectors/uptime.sh` | 最简单：单条 metric 的静态脚本 |
| `collectors/net.sh` | 用系统命令采集、带 meta |
| `collectors/mail.sh` | 有状态（seen 去重）+ 内部 API + 独立 env |
| `collectors/feed-timeline.sh` | 浏览器登录态采集 + 时间线稳定性 + 虚拟列表两段式快照 + timeoutMs 放宽 |
| `targets/feed-timeline.sh` | L1 target 脚本：stdin 收事实 → 批量 SemIf 逐条筛 → 输出 items 决策 |
| `collectors/swap.sh` | 系统瞬时量（swap/磁盘占用），用于区分“文件涨了”和“内存换到磁盘” |
| `tools/x-export-state.sh` | 从本机 Chrome 导出站点登录态（Chrome 136+ 禁默认 profile 调试的绕法） |
