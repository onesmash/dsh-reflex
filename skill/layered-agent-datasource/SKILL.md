---
name: layered-agent-datasource
description: "为分层智能体(ds-bot-layered-agent)添加新的数据源/监控指标。Use when the user asks to add a new data source, new collector, new metric to monitor, 添加数据源, 新数据源, 采集 xxx 数据, 监控 xxx, 写一个收集脚本. Provides the DATASOURCE contract: collector script format, auto-discovery, config enablement. 完整契约/模板/验证清单在此 skill 内自包含；本机路径均由环境约定（LAYERED_HOME / $HOME）推导，不写死绝对路径。"
version: 1.8.0
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
| SemIf skill | `~/.agents/skills/semif-decide/` | 同样是插件 install() 部署的（vendored 快照，只在缺失时装）；调 SemIf 用插件注入的 `$LAYERED_SEMIF_RUN`，别写死路径 |

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

1. **必须是时间倒序流**。算法推荐流（如 x.com 首页「为你推荐」）每次加载都返回一批不同的旧内容
   —— 轮询会持续吐"新"事实，还丢掉真正最新的。改成时间序入口
   （X 用 `search?q=filter:follows&f=live`）。验证法：连开三次，比较 id 集合是否完全相同。
2. **虚拟列表要两段式取快照**。滚动会把顶部条目挤出 DOM，所以顺序是
   「先取顶部 → 再滚动 → 再取一次 → 合并按 id 去重」，不能"先滚动再取"。
3. **去重持久化**在 `$LAYERED_HOME/seen-<name>.json`（有序数组 + 截断上限），不要用 set 丢顺序。

## 需要登录态的源

没有 API token、靠浏览器/账号登录态的源（如 `feed-timeline`）：

- 登录态 state 文件放 `$LAYERED_HOME/<name>-state.json`，权限 600，**只保留目标站点的 cookie**
- 配套写一个导出工具放 `$LAYERED_HOME/tools/`（**别放 `collectors/`，会被当成数据源**）；
  参照 `tools/x-export-state.sh`：复制浏览器 profile 副本 → 起带调试端口的浏览器 → CDP 导出明文 cookie
- collector 用独立会话名（如 `--session x-collect`）采集，结束 `close`，**不要常驻 headless 浏览器**
- **会话过期要以非 0 退出**（记 `L0 <name> failed`），绝不能把空数据伪装成"没有新事件"
- 告诉用户失效后怎么恢复（一条命令重跑导出工具）

## 让新源能唤醒 L2（可选）

### 脚本 target（首选，不用改代码）

写 `$LAYERED_HOME/targets/<name>.sh` + 在 `l1.targets` 启用。与 collector 同一套契约。

**职责分界**（关键，别混）：**脚本**负责判定与条目内容；**插件**负责指纹去重、冷却、
`minIntervalMs` 节流、pending 累积合并、**排版信封**（标题/编号/「其中 N 条为冷却期累积」/L0 入口）。
信封必须归插件 —— 那些信息来自跨轮统计，脚本不知道。

契约：stdin 收本轮新事实（JSONL）；stdout 一行 JSON；无输出 = 不唤醒；非 0 退出 = 记 failed。

    { "wake": true, "reason": "...", "fingerprint": {"ids": ["..."]}, "scanned": 12,
      "items": [ { "id": "...", "title": "一行标题", "body": "多行正文" } ] }

- **`items[].id` 必须有** —— 它是跨轮合并去重的唯一依据，缺了整个合并机制就退化
- 脚本别自己判重、别输出标题栏/编号/L0 入口
- 调 SemIf 用 `$LAYERED_SEMIF_RUN`（插件注入，别写死路径），**批量**打分别逐条起进程
- 用户画像从 `$LAYERED_PROFILE` 读
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

## ⚠️ 校准批量必须分块（会撑爆内存，进而撑爆磁盘）

**一次 `run_score.sh` 喂进去的行数要有硬上限：≤40 行。** 这不是性能建议，是事故防线。

SemIf 是**一次加载模型评 N 条**。N 一大，内存压力暴涨 → macOS 把内存换到 swap →
swap 文件写在磁盘上 → **磁盘被吃光**。表现在磁盘上，根因在内存，很容易查错方向。

实测（2026-10-15）：一次喂 326 行 →
48GB 内存的机器 swap 涨到 43GB（`/System/Volumes/VM`）→ **磁盘可用量 3 分钟内从 55GB 掉到
0.19GB**，触发了磁盘 target 的硬规则告警。事后只能靠 `du -sh /System/Volumes/VM` 手工挖出真凶。

正确做法 —— 分块跑再合并（输入输出分开放，脚本可重复跑）：

```bash
SEMIF="${LAYERED_SEMIF_RUN:-$HOME/.agents/skills/semif-decide/scripts/run_score.sh}"
rm -rf /tmp/cal && mkdir -p /tmp/cal/in /tmp/cal/out
split -l 40 all_rows.jsonl /tmp/cal/in/part_
for f in /tmp/cal/in/part_*; do
  bash "$SEMIF" --input "$f" --output "/tmp/cal/out/$(basename "$f").jsonl" --offline \
    || { echo "分块失败: $f" >&2; exit 1; }
done
cat /tmp/cal/out/*.jsonl > all_results.jsonl
```

（`LAYERED_SEMIF_RUN` 是插件注入给 target 脚本的；在手工 shell 里没这个变量，所以留了回退路径。）

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
~/.dsh/bot/layered-agent/tools/notify.sh "正文"       # 或 echo 正文 | 脚本
```

- 收件人取 `$LAYERED_IM_NOTIFY_TO` 或 `tools/notify.to`
- **消息是"用户发给自己"的**（helper 以用户本人身份认证，没有机器人账号），
  落在 IM 的"自己/备注"会话里 —— 能当通知渠道，但不显示成机器人
- 脚本强制 `text` 模式：默认的 markdown 模式**禁止裸 URL**，我们的通知里全是链接
- 超 3200 字符自动分段；退出码非 0 时按需降级

## 验证清单

- [ ] `collectors/<name>.sh` 可执行（`chmod +x`），单独跑输出合法 JSON line
- [ ] 加到 `l0.sources` 后，重启日志出现 `auto-discovered script sources: [... <name>]`
- [ ] 数据写入 `$HOME/.dsh/bot/layered-agent/facts/<name>/`
- [ ] manifest `sources` 列出 `<name>`，schema 可见（若写了 `<name>.schema.json`）
- [ ] 多次采集不重复（幂等）——连跑三次，第二次只出真正新增，第三次为 0
- [ ] 需要外部进程/浏览器的源，已在 `<name>.env.json` 放宽 `timeoutMs`

若还做了 target：

- [ ] `echo '<facts>' | bash targets/<name>.sh` 能独立跑出合法决策 JSON（这是最好的调试方式）
- [ ] 重启日志出现 `auto-discovered script targets: [... <name>]`，且 `l1.targets` 已启用
- [ ] manifest `l1Targets` 列出该 target，`type=script`
- [ ] 决策里 `items[].id` 非空（合并去重唯一依据）
- [ ] 命中后通知由插件排版（有标题栏/编号/L0 入口），脚本没自己拼这些
- [ ] 同一批内容重放 → 被抑制（0 投递）
- [ ] 冷却期内命中 → 进 `pending-wakes.json`；把上次唤醒时间推到冷却期之前且**不给新数据**再跑一次 → 必须被合并补发

若做了校准：

- [ ] 每块 ≤40 行（**先看上一节**，这条是事故防线不是性能建议）
- [ ] 校准前后各看一次 `df -h /System/Volumes/Data` 与 `du -sh /System/Volumes/VM`，异常增长立刻停

## 注意

- 先看现有脚本参照：`collectors/` 下 `uptime.sh`（最简单）、`net.sh`（系统命令+meta）、
  `mail.sh`（有状态去重+内部 API）、`feed-timeline.sh`（登录态+虚拟列表两段式快照）；
  `targets/feed-timeline.sh`（L1 判定 + 批量 SemIf + items 决策）
- 敏感数据（如邮件）只采元数据，不落正文；登录态文件要有 600 权限
- 详尽的契约、schema 登记、L1 target 做法见插件安装目录的 `DATASOURCE.md`
