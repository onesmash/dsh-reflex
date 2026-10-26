---
name: reflex-datasource
description: "为分层智能体(dsh-reflex)添加新的数据源/监控指标。Use when the user asks to add a new data source, new collector, new metric to monitor, 添加数据源, 新数据源, 采集 xxx 数据, 监控 xxx, 写一个收集脚本. Provides the DATASOURCE contract: collector script format, auto-discovery, config enablement. 完整契约/模板/验证清单在此 skill 内自包含；本机路径均由环境约定（REFLEX_HOME / $HOME）推导，不写死绝对路径。"
version: 2.1.2
---

# 添加分层智能体数据源

当用户要添加新的数据源/监控指标时，按此规则执行。本 skill **自包含**——核心契约、模板、验证清单都在这里，不依赖任何本机绝对路径。

## 关键路径（全部由环境约定推导，不写死）

| 用途 | 路径（约定） | 说明 |
|---|---|---|
| 统一目录 | `$HOME/.dsh/dsh-reflex/`（环境变量 `REFLEX_HOME`） | 数据源的家：`collectors/` 脚本、`facts/` 数据、manifest、状态文件 |
| 启用 | 脚本源/target：**丢进目录即生效**（热发现）。内置源（disk/mail/swap）仍在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 `layered-agent.l0.sources` 声明 |
| 代码/详细规则 | 插件安装目录（见下方"定位插件安装目录"） | `DATASOURCE.md` 随代码版本走，是详细版 |
| 本 skill | `~/.agents/skills/reflex-datasource/` | 由插件 install() 自动部署，随代码更新 |
| SemIf skill | `~/.agents/skills/semif-decide/` | 同样是插件 install() 部署的（vendored 快照，只在缺失时装）；调 SemIf 用插件注入的 `$REFLEX_SEMIF_RUN`，别写死路径 |

> 定位插件安装目录：Bot 收到本 skill 时若需读详细规则 `DATASOURCE.md`，用 `npm ls dsh-reflex`（在 profile 目录）或从运行报错中的文件路径反推，或直接读取 `$HOME/.dsh/dsh-reflex/manifest.json`（L0 自描述，给出了数据源布局）。不要假设某个固定的源码 checkout 路径。

## 核心流程（4 步，不改插件核心代码）

1. **写 collector 脚本** → 丢进 `$HOME/.dsh/dsh-reflex/collectors/<name>.sh`
   - stdout 每行一个 JSON fact：`{"metric","raw","meta"?}`
   - source/ts 由插件补；脚本可读注入环境（`REFLEX_HOME`/CA 证书/PATH）
   - 脚本要幂等（多次调用不重复，如 mail 用 seen 去重）
2. **启用** → 脚本源/脚本 target：**丢进目录即生效**（热发现，无需改配置、无需重启；移除文件即退出）。内置源仍在 profile 的 `l0.sources` 声明
3. **验证** → 下一轮日志出现 `discovery refreshed: sources=[... <name> ...]`（**不需要重启**；落盘后下一轮扫描即生效）；数据进 `facts/<name>/`
4. **（可选）增强**：
   - manifest `sourceSchema` 登记字段（让 L2 自主推理看懂）
   - `TARGETS` 加 target（异常时唤醒 L2）——只有这层需要 JS 代码

## Collector 契约

- **输出**：stdout 每行一个 JSON fact：`{"metric":"<m>","raw":{...},"meta":{...}}`；`source`/`ts` 由插件补齐
- **环境**：插件注入 `REFLEX_HOME`（统一目录）、自定义 CA（`SSL_CERT_FILE`/`CURL_CA_BUNDLE`/`REQUESTS_CA_BUNDLE`）、常用 PATH
- **行为**：退出 0 + 空输出 = 本轮无数据（正常）；退出非 0 = 记 `L0 <name> failed`，不影响其他源；必须幂等
- **自动发现**：插件启动扫描 `collectors/`，每个 `*.sh` 自动注册为源（源名 = 文件名去 `.sh`）
- **伴生文件**（都是纯数据，加源不改代码）：
  - `<name>.env.json` → `{intervalMs, timeoutMs, env}`
    - **`timeoutMs` 默认只有 20s**：凡启停外部进程/浏览器的源必须放宽到 60-120s，否则被杀在半路
  - `<name>.schema.json` → `{metric, fields:{名:含义}, notes?}`，自动进 `facts/manifest.json` 的 `sources[].schema`，让 L2 看得懂

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

## 抓「最新 N 条」类源的硬要求

要采的是「我的时间线 / 我的信息流」这类列表时，先验证**列表稳定性**，否则轮询全是噪音：

1. **必须是时间倒序流**。算法推荐流（如 feed 平台首页「为你推荐」）每次加载都返回一批不同的旧内容
   —— 轮询会持续吐"新"事实，还丢掉真正最新的。改成时间序入口
   （某信息流平台用 `search?q=filter:follows&f=live`）。验证法：连开三次，比较 id 集合是否完全相同。
2. **虚拟列表要两段式取快照**。滚动会把顶部条目挤出 DOM，所以顺序是
   「先取顶部 → 再滚动 → 再取一次 → 合并按 id 去重」，不能"先滚动再取"。
3. **去重持久化**在 `$REFLEX_HOME/seen-<name>.json`（有序数组 + 截断上限），不要用 set 丢顺序。

## 需要登录态的源

没有 API token、靠浏览器/账号登录态的源（如 `feed-timeline`）：

- 登录态 state 文件放 `$REFLEX_HOME/<name>-state.json`，权限 600，**只保留目标站点的 cookie**
- 配套写一个导出工具放 `$REFLEX_HOME/tools/`（**别放 `collectors/`，会被当成数据源**）；
  参照 `tools/feed-export-state.sh`：复制浏览器 profile 副本 → 起带调试端口的浏览器 → CDP 导出明文 cookie
- collector 用独立会话名（如 `--session feed-collect`）采集，结束 `close`，**不要常驻 headless 浏览器**
- **会话过期要以非 0 退出**（记 `L0 <name> failed`），绝不能把空数据伪装成"没有新事件"
- 告诉用户失效后怎么恢复（一条命令重跑导出工具）

## 让新源能唤醒 L2（可选）

### 脚本 target（首选，不用改代码）

写 `$REFLEX_HOME/targets/<name>.sh` 即自动启用（drop-in，热发现；无需改 `l1.targets`、无需重启）。与 collector 同一套契约。

**职责分界**（关键，别混）：**脚本**负责判定与条目内容；**插件**负责指纹去重、冷却、
`minIntervalMs` 节流、pending 累积合并、**排版信封**（标题/编号/「其中 N 条为冷却期累积」/L0 入口）。
信封必须归插件 —— 那些信息来自跨轮统计，脚本不知道。

契约：stdin 收本轮新事实（JSONL）；stdout 一行 JSON；无输出 = 不唤醒；非 0 退出 = 记 failed。

    { "wake": true, "reason": "...", "fingerprint": {"ids": ["..."]}, "scanned": 12,
      "items": [ { "id": "...", "title": "一行标题", "body": "多行正文" } ] }

- **`items[].id` 必须有** —— 它是跨轮合并去重的唯一依据，缺了整个合并机制就退化
- 脚本别自己判重、别输出标题栏/编号/L0 入口
- 调 SemIf 用 `$REFLEX_SEMIF_RUN`（插件注入，别写死路径），**批量**打分别逐条起进程
- 用户画像从 `$REFLEX_PROFILE` 读
- **在 `<name>.env.json` 里声明 `sources: ["<源名>"]`** —— 否则 target 脚本会被每分钟空跑一次
  （disk 每分钟产出一条事实就触发一轮决策，而脚本对那批事实并不关心）
- 想全权排版可输出 `{"notice": "整段文本"}`，代价是累积时插件只能粗暴拼接、无法跨轮去重

### 内置 target（要写 JS，仅当需要计算逻辑）

像 `disk` 那样要算趋势、跨源关联的才写进 `TARGETS`。三条最常翻车的：

1. **必须给 `stateFingerprint` 补该 target 的分支**。不补 → 指纹恒为 null → **每轮都唤醒**（刷屏）。
   （脚本 target 有兜底：script fingerprint → items[].id）
2. **内容类源要设唤醒硬上限 `minIntervalMs`**，且缺省应**跟随该源的采集间隔**
   （`sourceIntervalMs('<source>')`），别写死数字。冷却期内命中项会漏报，所以要声明
   `mergeCtx(prev, next)` 攒进 `pending-wakes.json`，冷却期一到合并发出。
   注意：攒了就必须发得出去 —— `decideOnce` 在**没有新事实时也要继续跑**。
3. **SemIf 判据必须拿真实历史 facts 校准**，别拍脑袋：逐条拼 `{id,state,question,options}` 批量跑
   `run_score.sh` 看 p(yes) 分布。
   ⚠️ **校准时用的措辞和 state 构造，必须原样搬进实现**。手滑多写一句限定、或把上下文从
   "全部消息"改成"最近 8 条"，分数就会整批漂移（实测 2/9→5/9、0.75→0.93），
   而且表现为"数字变好"，很难察觉。改动判据后必须重跑校准。实测 4B 模型下「收紧判据」比「调高阈值」更容易把 target 压死到
   永不触发；加用户画像（`l1.profile`）会显著改变灵敏度。
   逐条筛选用批量打分（框架的 `semifScoreBatch`），**不要再跑第二次 SemIf**。

### 跨源关联的 target（源 A 要判断"跟我有关吗"）

场景：频道消息里出现一个票号，但"这个票号是不是我的"只有另一个源知道。
（实例：`tickets-progress` —— release 排期 × 工单系统任务。）

**关键约束：target 脚本只拿到本轮新事实，没有历史。** 判"这条提到我名下的票"
需要"我名下有哪些票"这份**存量**，它不在本轮事实里。存量从**采集器的状态文件**读 ——
同一个脚本源自己的状态，不是新机制：

```
collectors/tickets-my-tasks.sh  →  tickets-my-tasks-state.json  (票号 → {status, fixVersion})
                                 ↓ target 直接读它当上下文
targets/tickets-progress.sh  →  判断"频道消息里的票号 ∈ 这个集合"
```

- **不重新调 API**：省一次鉴权/错误处理/往返；且**状态文件是单一事实来源**，
  两次调用之间的时间差不会造成不一致
- **代价（必知）**：状态文件格式成了采集器与 target 的**契约**。改结构必须同步改读它的 target，
  否则 target 静默读到空 → **判定永不命中**（"看起来在跑"的失败，不会报错）

**打标放采集层，别丢给 L1**：能从文本直接算的结构化事实（**票号正则、版本号、是否 @我、有无附件**）
应在 collector 里算好存成字段，而不是让本地决策模型数正则 —— 正则确定、算一次所有消费方都能用、
target 里只剩集合判断（连 SemIf 都省了）。对应地 **collector 不为"取舍"负责**：
忠实采集 + 打标，判断留给 L1；采集层做取舍会漏数据。

**判据必须锚定在"属于用户的"那一侧**：该频道每条消息都带版本号和日期，
写成"含日期 + 排期词就报"会全量命中。实测 15 条消息里别人版本(`7.2.5`)出现 11 次、
用户的版本(`7.3.0`)只 1 次 —— 锚定到"用户 fixVersion 里实际存在的版本"后
才只需 1 条。**先量数据分布再定判据。** 另外正文截断长度要够判据用
（300 字符会把长消息里的日期切掉，判定静默失败）。

**target 测试必须有反例**：只验正例只能证明通路，不能证明它**不会乱叫**。
`tickets-progress` 用 3 正例 + 4 反例（别人名下的票号、有排期词但没 @我、我的票没变化、
我的票变 Done）。**反例不过的 target 不要上线** —— 噪音是这套系统最常见的死法。


## ⚠️ 校准批量必须分块（会撑爆内存，进而撑爆磁盘）

**一次 `run_score.sh` 喂进去的行数要有硬上限：≤40 行。** 这不是性能建议，是事故防线。

SemIf 是**一次加载模型评 N 条**。N 一大，内存压力暴涨 → macOS 把内存换到 swap →
swap 文件写在磁盘上 → **磁盘被吃光**。表现在磁盘上，根因在内存，很容易查错方向。

实测（2026-10-15）：一次喂 326 行 →
48GB 内存的机器 swap 涨到 43GB（`/System/Volumes/VM`）→ **磁盘可用量 3 分钟内从 55GB 掉到
0.19GB**，触发了磁盘 target 的硬规则告警。事后只能靠 `du -sh /System/Volumes/VM` 手工挖出真凶。

正确做法 —— 分块跑再合并（输入输出分开放，脚本可重复跑）：

```bash
SEMIF="${REFLEX_SEMIF_RUN:-$HOME/.agents/skills/semif-decide/scripts/run_score.sh}"
rm -rf /tmp/cal && mkdir -p /tmp/cal/in /tmp/cal/out
split -l 40 all_rows.jsonl /tmp/cal/in/part_
for f in /tmp/cal/in/part_*; do
  bash "$SEMIF" --input "$f" --output "/tmp/cal/out/$(basename "$f").jsonl" --offline \
    || { echo "分块失败: $f" >&2; exit 1; }
done
cat /tmp/cal/out/*.jsonl > all_results.jsonl
```

（`REFLEX_SEMIF_RUN` 是插件注入给 target 脚本的；在手工 shell 里没这个变量，所以留了回退路径。）

注意区分两条链路：

| | 批量大小 | 安全性 |
|---|---|---|
| **生产 target** 每轮打分 | 受 `maxCandidates` 约束（如 12 条） | 安全 |
| **临时校准脚本** 全量历史 | 由你决定 —— **危险就在这里** | 必须分块 |

分块时还要盯一眼磁盘：`df -h /System/Volumes/Data | tail -1` 和
`du -sh /System/Volumes/VM`。跑之前记一下，跑完再对一次，异常增长要立刻停。

## 安静时段

`l1.quietHours: { from: "18:00", to: "09:00" }` —— 时段内**内容类** target 的命中不进唤醒，
走已有的 pending 队列攒着；时段结束后第一次决策自动合并成一条摘要发出。
**硬规则 target 用 `interruptAlways: true` 穿透**（内置 disk 已标；脚本 target 在 env.json 里写）。

冷知识：它和 `minIntervalMs` 是同一类限制，实现上共用一个 `limited` 判断 —— 加这类
"暂不打扰"的规则时，优先复用它，别另起一套调度。

## 输出通道：给用户发 IM

需要让用户注意的事，可以推到他的 IM：

```bash
~/.dsh/dsh-reflex/tools/im-notify.sh "正文"       # 或 echo 正文 | 脚本
```

- 收件人取 `$REFLEX_IM_NOTIFY_TO` 或 `tools/im-notify.to`
- **消息是"用户发给自己"的**（helper 以用户本人身份认证，没有机器人账号），
  落在 IM 的"发给自己"会话里 —— 能当通知渠道，但不显示成机器人
- 脚本强制 `text` 模式：默认的 markdown 模式**禁止裸 URL**，我们的通知里全是链接
- 超 3200 字符自动分段；退出码非 0 时按需降级

## 代用户回复消息（高风险，先读）

如果要做"替用户回复"，记住实测结论：**"会话最后一条不是我发的" ≠ "有人在等我回"**。
按它实现会一次标出 17 个会话（含三个月前的 `👍`、`好的`）。必须加时间上限
（只看最近 N 分钟到达且无人回的），再叠加判断 —— 判断归 L2，不放进 L1。

链路：采集器产 `dm-awaiting` 事实 → target 只叫醒 L2 → L2 判断 → `im-notify.sh --to "<会话id>"`。

**先跑影子模式**：给同事发消息不可撤回，且以用户本人身份发出。样本不足时别给
"是否需要回复"定阈值。

## 验证清单

- [ ] `collectors/<name>.sh` 可执行（`chmod +x`），单独跑输出合法 JSON line
- [ ] 新脚本源落盘后，下一轮日志出现 `discovery refreshed: sources=[... <name> ...]`（无需重启）
- [ ] 数据写入 `$HOME/.dsh/dsh-reflex/facts/<name>/`
- [ ] manifest `sources` 列出 `<name>`，schema 可见（若写了 `<name>.schema.json`）
- [ ] 多次采集不重复（幂等）——连跑三次，第二次只出真正新增，第三次为 0
- [ ] 需要外部进程/浏览器的源，已在 `<name>.env.json` 放宽 `timeoutMs`

若还做了 target：

- [ ] `echo '<facts>' | bash targets/<name>.sh` 能独立跑出合法决策 JSON（这是最好的调试方式）
- [ ] 脚本 target 落盘后，下一轮日志出现 `discovery refreshed: ... script-targets=[... <name> ...]`（无需重启）
- [ ] manifest `l1Targets` 列出该 target，`type=script`
- [ ] 决策里 `items[].id` 非空（合并去重唯一依据）
- [ ] **反例测试**：构造不该唤醒的输入（别人名下的票号 / 没 @我 / 无变化），确认输出为空
- [ ] 跨源 target：读的采集器状态文件存在且字段对得上（读空会静默永不命中）
- [ ] 命中后通知由插件排版（有标题栏/编号/L0 入口），脚本没自己拼这些
- [ ] 同一批内容重放 → 被抑制（0 投递）
- [ ] 冷却期内命中 → 进 `pending-wakes.json`；把上次唤醒时间推到冷却期之前且**不给新数据**再跑一次 → 必须被合并补发

若做了校准：

- [ ] 每块 ≤40 行（**先看上一节**，这条是事故防线不是性能建议）
- [ ] 校准前后各看一次 `df -h /System/Volumes/Data` 与 `du -sh /System/Volumes/VM`，异常增长立刻停

## 生效边界：哪些改动不用重启，哪些必须重启

**先分清，别默认「要重启」**——这是最容易搞错的一条，按下表判断：

| 改动 | 生效方式 |
|---|---|
| `collectors/<name>.sh`、`collectors/<name>.env.json` | **热生效**，不用重启（目录/环境文件 mtime 签名变了就重扫） |
| `targets/<name>.sh`、`targets/<name>.env.json` | **热生效**，不用重启 |
| 脚本 target 是否启用 | **落盘即自动激活**，不用写进 profile 的 `l1.targets`（代码：`activeTargets = keys(ALL_TARGETS).filter(k => cfgSet.has(k) \|\| SCRIPT_TARGETS[k])`）；停用 = 删文件或加 `<name>.paused` |
| profile 的 `l0.sources` / `l1.targets` / `quietHours` 等**配置** | 需要重启（进程启动时读） |
| 插件本体 `index.js`（判定逻辑、重试、发现机制） | 需要重启（link: 安装也要重启进程才加载新代码） |
| profile 里的 npm 包（`ds-bot`、各类 `dsh-*` 插件） | 需要重启（`dsh plugin --profile <p> add <pkg>@<ver>` 装完后重开 App） |

**验证办法**（不要靠猜）：
```bash
grep "discovery refreshed" $REFLEX_HOME/dsh-reflex.log | tail -1
# 看 sources=[...] 里有没有新 collector、script-targets=[...] 里有没有新 target
```

## 注意

- **改已有采集器时不要就地写文件**：采集器由 L0 循环按各自节拍执行，`write` 截断重写的瞬间
  若正有一轮在跑，bash 会读到半截脚本 —— 表现为莫名其妙的语法错误（2026-10-19 zoom-im 实测：
  `line 337: 非: command not found`），并产生一条假的「采集失败」。正确做法：写临时文件 →
  `bash -n` 校验 → `mv` 原子替换（同一文件系统上是 rename，运行中的进程继续用旧 inode）。
- 先看现有脚本参照：`collectors/` 下 `uptime.sh`（最简单）、`net.sh`（系统命令+meta）、
  `im-mail.sh`（有状态去重+凭据调用）、`feed-timeline.sh`（登录态+虚拟列表两段式快照）；
  `targets/feed-timeline.sh`（L1 判定 + 批量 SemIf + items 决策）
- 敏感数据（如邮件）只采元数据，不落正文；登录态文件要有 600 权限
- 详尽的契约、schema 登记、L1 target 做法见插件安装目录的 `DATASOURCE.md`
