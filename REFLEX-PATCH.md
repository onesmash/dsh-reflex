# dsh-reflex 本机补丁记录

> 补丁日期：2026-11-11
> 作用对象：`~/.dsh/profiles/web/node_modules/dsh-reflex@0.3.18`（npm 安装，`^0.3.18`）
> 目的：让 L1 决策层改用配置里的 `backend: jev`（托管 SystemOne），而不是本地 SemIf。

## 为什么必须打这个补丁

本机是 **MacBookPro16,1 / Intel i7-9750H / x86_64**。而 `semif-decide` 的 `run_score.sh`
后端自动选择逻辑是：

```bash
Darwin + arm64          → mlx        # 需要 Apple Silicon
有 nvidia-smi           → torch      # 需要 CUDA
其他                     → fail "cannot select a backend on this machine"
```

Intel Mac 两者都不满足；GGUF 是浏览器/wllama 轨道，CLI 明确不读。
**结论：SemIf 后端在本机永远不可能工作**，日志里 `cannot select a backend on this machine`
不是偶发故障，是环境不支持。

用户已配置托管 Jev：

```yaml
- id: dsh-reflex
  config:
    backend: jev
    jevBaseUrl: https://llm-ei7x74obik76ddkb.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone
    jevModel: decision-model-preview
```

但 v0.3.18 有两个缺口，导致配了也不生效：

1. **内置 target 绕过 backend**：`semifScoreBatch()` 里 `run_score.sh` 是写死的，
   不读 `cfg.backend`。`disk` 是 JS 内置 target，直接调它 → 必走本地 SemIf → 必失败。
   （只有脚本类 target 会拿到 `REFLEX_DECIDE_BACKEND` 环境变量。）
2. **适配器缺失**：文档承诺的 `tools/semif-adapt.py` 与 `tools/decide-calibrate.py`
   **没有随包发布**（package.json 的 `files` 未含 `tools/`，源码 tarball 里也没有）。
   因此即便脚本 target 拿到环境变量，也没有东西消费它。

## 补了什么

| 文件 | 动作 | 说明 |
|---|---|---|
| `jev-adapter.mjs` | 新增 | SystemOne HTTP 客户端，输出与 SemIf 同构 `{winning,pYes,probs}`；另含 `writeShadow()` |
| `index.js` | 改 4 处 | ① 顶部加 import；② `semifScoreBatch()` 后端分流；③ jev 分支写 shadow；④ 判定日志按真实后端打标签 |

#### 补丁 2 的问题补充

**问题**：补丁 1+2 只让**内置 JS target（disk）**走 jev。脚本 target 走的仍是
`shadow-semif.sh` → `run_score.sh`，于是这四条链在 jev 后端下全断：

| 链路 | 断点 |
|---|---|
| 脚本 target 的 shadow 记录 | wrapper 只调 `run_score.sh` |
| 历史回放 `shadow_replay.py` | 回放要跑 target 脚本 → 又回到 wrapper |
| 判据 A/B | 同上 |
| 新判据打分 `pc_inject.py` | 第 36 行写死 `DEFAULT_SCORE=run_score.sh` |

**做法**（两处，各司其职）：

1. 新增 `jev-score.mjs` —— 用 SystemOne 端点顶替 `run_score.sh` 的命令行入口。
   - 输出契约与 SemIf 完全一致：`{id, option_ids[], probabilities[], model{backend,source,revision}}`
   - `option_ids` 按输入选项顺序，`probabilities` 对齐并归一到和为 1
   - **原子提交**：先写 temp，全行成功才 rename；create-only；任一行失败不落盘
   - 直接复用 `validate_results.py` 做校验（契约只保留一份实现）
   - 照收 `run_score.sh` 的旗标（`--mode/--backend/--revision/--offline/...`），可透明替换

2. `shadow-semif.sh` 增加后端分支：`REFLEX_DECIDE_BACKEND` 为 `jev|jevlocal` 时
   改调该 CLI，跳过常驻与本地 SemIf；**影子记录块不动**（CLI 输出是 SemIf 格式，
   `shadow_record.py` 原样能读）。

3. 插件 `scriptEnv` 多注入一个 `REFLEX_JEV_SCORE`，指向该 CLI。

**验证**：
- CLI 单测 12 条（本地假端点起真实进程）：同序、归一、create-only、失败不留半成品、
  旗标兼容、裸 host 补 `/v1/systemone`
- 集成验证：`shadow-semif.sh` + `REFLEX_DECIDE_BACKEND=jev` + 假端点
  → 退出码 0，输出 SemIf 格式，`shadow/<tag>-<date>.jsonl` 出现且 `score=0.93`
- 两套测试合计 **32 pass / 0 fail**

**`pc_inject.py` 用法**：`--score-cmd <该 CLI 路径>` 即可（已 chmod +x，带 shebang），
环境需提供 `JEV_BASE_URL` / `JEV_MODEL` / `JEV_API_KEY`。


**问题**：原版只有 `shadow-semif.sh` 这一条 bash 旁路，它绑死在 `run_score.sh` 上；
而**内置 target（disk）从来不走 shadow wrapper**（index.js 注释原文：`disk 这个内置
target 不经过 shadow wrapper`）。所以：

- 即便在 SemIf 能跑的机器上，`disk` 也没有影子样本
- 切到 jev 后，`shadow-semif.sh` 因为 `$REAL` 失败而跳过记录 → 样本为零
- 结果：**判定能跑，但阈值拟合/回放/判据 A/B 全部无数据**

**做法**：在 jev 分支打分成功后，用 JS 直写同格式 shadow 记录，
不依赖 python、不依赖 bash 旁路。

落盘：`$REFLEX_HOME/shadow/<tag>-<YYYY-MM-DD>.jsonl`，字段与
`reflex-tuning/scripts/shadow_record.py` **逐字段一致**：

```
ts, mode, tag, key, state_hash, id, score, threshold, passed, p_yes, question, state
```

- `key` = sha1(tag \0 question \0 state) 前 16 位；`state_hash` = sha1(state) 前 16 位
- `threshold` 取**实际生效的** `cfg.l1.threshold`（而非 tools/shadow_targets.json，
  这样记录的是真话）
- 保留策略同原版：只清理 `*-YYYY-MM-DD.jsonl`，超过 `REFLEX_SHADOW_RETENTION_DAYS`（默认 30 天）
- 失败绝不影响判定（整体 try/catch）；关闭方式 `REFLEX_SHADOW_DISABLED=1`

**验证**：把产出的 shadow 文件喂给真实的 `threshold_fit.py`，能正常输出分数分布报告
（不再是"没有数据"）。这一步是格式兼容性的硬证据。


分流逻辑：

```js
const backendName = String(unwrap(cfg.backend, '') ?? '').trim()
if (backendName === 'jev' || backendName === 'jevlocal') {
  // 走 jev-adapter，不碰 run_score.sh
}
```

`unwrap()` 是必须的：`.volatile()` 声明的字段运行时是取值器而非裸值，
直接 `cfg.backend === 'jev'` 永远为 false 且不报错（插件源码 655 行有同样的警告）。

## 线格式（实测，非推测）

```http
POST {base}          # base 若已以 /systemone 结尾就不再拼 /v1/systemone
{"model":"decision-model-preview",
 "state":"...",
 "questions":{"q":{"type":"choice","question":"...","criteria":{"yes":"...","no":"..."}}}}
```

```json
{"answers":{"q":{"type":"choice","choice":"yes","confidence":0.73,
                 "probabilities":{"yes":0.86,"no":0.14}}},
 "usage":{"input_tokens":54},"latency_ms":36.5}
```

两条硬坑（已实测避开）：

- **base URL 拼接口**：写成 `.../api/v1` 会拼成 `/api/v1/v1/systemone` → 404。
  适配器做了 `/systemone$` 判断，两种写法都吃。
- **criteria 不能为 null**：无 description 时回退用 option id 文本，否则端点 400。

## 验证记录

| 项 | 方法 | 结果 |
|---|---|---|
| 端点连通 | curl 直打配置的 URL | HTTP 200，45ms 量级 |
| 适配器单测 | `scoreBatch` 打 2 条真实磁盘判定 | 2 行 / 1080ms；12.3GB→pYes 0.42；1.2GB→pYes 0.63，方向正确 |
| 密钥可读 | 复刻插件 `loadSecrets()` 的 refs 解析 | 命中 `JEV_API_KEY`（35 字符） |
| 语法 | `node --check index.js` / `jev-adapter.mjs` | 通过 |
| 端到端（重启后） | 看 `~/.dsh/dsh-reflex/dsh-reflex.log` | **2026-11-11 11:37 / 11:38 两轮连续成功**：`L1[disk]: SemIf winning=no pYes=0.090`；重启后 `cannot select / 打分失败 / L1[disk] error` 计数 **0** |

日志里那行的后端名原本硬编码为 `SemIf`，已改为按 `cfg.backend` 输出真实后端
（`semif` / `jev` / `jevlocal`），否则排障时会被误导成"还在走本地模型"。
该改动**下次重启生效**；当前生效的是更早那版补丁（功能相同，仅日志措辞不同）。


## 生效方式

插件代码与配置都是**进程启动时加载**，必须重启 DSH web：

```bash
# 停掉现有 node dsh web，再重新起
```

重启后日志里 `L1[disk] error: ... cannot select a backend` 应当消失。

## 补丁 3（2026-11-11 12:0x）：jev 打分器，解锁 shadow / 回放 / A/B / 新判据

补丁 1+2 只让**内置 JS target（disk）**走 jev。脚本 target 仍走
`shadow-semif.sh` → `run_score.sh`，于是四条链在 jev 后端下全断：脚本 target 的
shadow 记录、历史回放 `shadow_replay.py`、判据 A/B、新判据打分 `pc_inject.py`
（第 36 行写死 `DEFAULT_SCORE=run_score.sh`）。

**做法（三处）**

1. 新增 `jev-score.mjs`：SystemOne 端点顶替 `run_score.sh` 的 CLI 入口。
   - 输出契约与 SemIf 完全一致 `{id, option_ids[], probabilities[], model{backend,source,revision}}`
   - `option_ids` 按输入选项顺序；`probabilities` 对齐并归一到和为 1
   - 原子提交（先写 temp，全行成功才 rename）、create-only、任一行失败不落盘
   - 复用 `validate_results.py` 校验（契约只保留一份实现）
   - 照收 `run_score.sh` 的旗标，可透明替换（`--offline` 是无值开关，单独处理）
2. `shadow-semif.sh` 增加后端分支：`jev|jevlocal` 改调该 CLI，跳过常驻与本地 SemIf；
   **影子记录块不动**——CLI 输出是 SemIf 格式，`shadow_record.py` 原样能读。
3. 插件 `scriptEnv` 多注入 `REFLEX_JEV_SCORE` 指向该 CLI。

**验证**：CLI 单测 12 条（起本地假端点跑真实进程）＋ 适配器测试 20 条 = **32 pass / 0 fail**；
集成验证 wrapper + jev + 假端点 → 退出码 0、输出 SemIf 格式、`shadow/disk-<date>.jsonl`
出现且 `score=0.93`。

**`pc_inject.py` 用法**：`--score-cmd <jev-score.mjs>`（已 chmod +x 带 shebang），
环境需给 `JEV_BASE_URL` / `JEV_MODEL` / `JEV_API_KEY`。

## 已知遗留

- **阈值是旧尺子**：`l1.threshold: 0.8` 是给本地 SemIf 调的。换后端等于换尺子
  （见 DATASOURCE.md「⚠️ 换后端 = 换尺子」）。实测 jev 在 1.2GB 可用空间时只给
  0.63，说明 0.8 偏严。磁盘的硬规则（可用 < 20GB 或占用 > 90%）仍在 SemIf 之前
  兜底，所以紧急告警不会漏；但细粒度趋势告警需要重新校准。
  校准工具：`reflex-tuning` skill（shadow 记录 → 回放 → 阈值拟合）。
- **升级会被覆盖**：`npm install dsh-reflex@新版本` 会重建 node_modules，
  本补丁需重新应用（本文件 + `jev-adapter.mjs` 是全部内容）。
- **隐私边界**：`backend: jev` 会把判定用的 state 发到阿里云 MaaS 端点。
  磁盘类 fact 只是容量数字，风险低；若将来挂内容类 target（邮件/消息），
  需重新评估是否可接受离机。

## 补丁 4（2026-11-11 12:1x）：`.paused` 落空

文档两处承诺「去掉脚本或加 `<name>.paused` 即停」（`index.js:375`、`:1255`），
但 `scanScriptSources()` 与 `scanScriptTargets()` **都只过滤 `*.sh`，从不检查 `.paused`**。
加这个文件此前完全无效 —— 与缺失的 `tools/semif-adapt.py` 属同一类「文档有、代码无」。

补丁：两个扫描循环在拿到 name 之后各加一行 `existsSync(<name>.paused)` → skip。
生效需重启（扫描器属插件本体代码）。

在它生效之前，停用一个脚本源要改名（`x.sh` → `x.sh.disabled`，热发现立刻摘除）。

## 数据源：x-timeline（2026-11-11 12:2x）

| 文件 | 作用 |
|---|---|
| `collectors/x-timeline.sh` | 采集 X 关注时间线新推文 |
| `collectors/x-timeline.env.json` | `intervalMs=300000`、`timeoutMs=60000`（外部进程，放宽） |
| `collectors/x-timeline.schema.json` | manifest 字段说明 |
| `targets/x-timeline.sh` | 有新推文即唤醒 L2（**不做语义筛选**，判定交给 L2） |
| `targets/x-timeline.env.json` | `sources:["x-timeline"]`、`minIntervalMs=900000`（15 分钟合并一次） |
| `tools/x-export-state.sh` | 从 Chrome 导出登录态 → `x-timeline-state.json`(600) |
| `seen-x-timeline.json` | 去重表 `{ids, sinceMs}` |

**为什么必须叠时间水位**：X 的 for-you 与 following 两条流都不稳定 ——
2026-11-11 实测连开三次，id 集合 md5 三样，且会混进 8/9/10 月的旧帖（算法插入）。
只按 id 集合差分会把旧帖当新推文持续吐出。现在用 `createdAt` 早于水位即丢弃。

**为什么 target 不调 SemIf/jev**：用户明确要求判定交给 L2。哪些推文重要依赖
上下文（关注谁、在做什么），本地小模型给不出稳定判断。L1 只提供"有新内容"这个
确定性事实，频率由 `minIntervalMs` 兜住。

**实测**：回填 5 条 → `L1[x-timeline]: 6 条新推文（L2 判定）` → `L2: woken "Chief"`，
端到端打通。反例（空输入 / 只有 disk 事实 / 垃圾 JSON）均空输出且退出 0。

## target 改为 L1 判定（2026-11-11 12:4x）

用户纠正：判定应在 **L1**（本地/托管小模型打分），不是唤醒 L2 再判。
target 改为批量调 `$REFLEX_SEMIF_RUN` 逐条打分，阈值 0.7，只把命中项交给 L2。

### ⚠️ 校准得到的硬结论：判据要写在 options.description，不是 question

同一推文、同一 question，只换选项描述：

| 选项描述 | p(yes) |
|---|---|
| 通用「与技术工作相关 / 无关」 | **0.70** |
| 明确写出「是模型评测/agent 工程…；不是 AI 娱乐/政治/财经…」 | **0.01** |

改 question 措辞（138 字 → 195 字）对分数**毫无影响**（0.89/0.98/0.84 逐条不变）。
这跟本地 SemIf 的直觉相反 —— 本端点把 criteria 当判据、question 只当背景。
**写 jev target 时必须把判据塞进 description。**

### 校准结果（13 条真实事实，阈值 0.7）

| p(yes) | 内容 | 判定 |
|---|---|---|
| 0.950 | Android Bench 模型评测 | ✅ 命中 |
| 0.800 | benchmark 上下文说明 | ✅ 命中 |
| 0.180 | Qwen 生成 3D 动画（边缘） | 未达阈值 |
| ≤0.05 | 财经/政治/体育/碎片/AI 娱乐预告片 | ✅ 正确排除 |

双峰分布，命中与未命中间隔 0.62，阈值 0.7 落在间隔内。

**误报被消除**：AI 预告片原先 0.89（会误唤醒），判据进 description 后降到 0.000。

### 其它

- 按推文 id 去重（同一推文可能被多轮采集重复落盘）
- 批量打分行数上限 `X_TIMELINE_MAX_CANDIDATES=12`（skill 硬上限 40）
- 影子样本自动落 `shadow/x-timeline-<date>.jsonl`（走 shadow wrapper，阈值拟合有粮）
- `minIntervalMs` 900000 → 300000（判定已过滤噪音，可以更实时）

## ⚠️ 补丁打在 skill 目录会被覆盖（2026-11-11 12:43 踩坑）

`skill/reflex-tuning/.deploy.json` 的 policy 是 **`sync`**：插件每次启动都会用
`node_modules/dsh-reflex/skill/reflex-tuning/` 覆盖 `~/.agents/skills/reflex-tuning/`。

所以 12:41 那次重启把打给 `~/.agents/skills/.../shadow-semif.sh` 的 jev 分支冲掉了，
target 立刻退回本地 SemIf，报 `cannot select a backend on this machine`。

**规则**：给 reflex-tuning 的补丁必须打在**源头**
`~/.dsh/profiles/web/node_modules/dsh-reflex/skill/reflex-tuning/scripts/`，
然后 `cp` 到 skill 目录（或直接重启让它 sync）。

- `sync` 策略（自有 skill）：reflex-tuning / semif-decide 之外的、随插件分发的
- `seed-only` 策略：第三方 vendored（semif-decide、typesafe-ai）——已存在就整体跳过，
  所以直接改 `~/.agents/skills/` 下的副本是安全的

判别方法：`cat skill/<name>/.deploy.json` 看 `policy`。

## target 端到端打通（2026-11-11 12:57）

```
12:57:39  L1[x-timeline]: 逐条筛选命中 1/6（阈值 0.7）
12:57:39  L2: woken "Chief"
```

### 途中修掉的四个真问题（都是"看起来在跑"的静默失败）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `cannot select a backend` | 补丁打在 `~/.agents/skills/`，被插件的 **sync 策略**在重启时覆盖 | 改打源头 `skill/reflex-tuning/scripts/` |
| 2 | `fetch failed` | 插件注入 `SSL_CERT_FILE=''`；**Homebrew node 23** 见空值即清空信任库（nvm node 26 不这样） | wrapper 里空值 unset |
| 3 | 打分成功但无输出 | 最后一步用 `python3 - <<'PY'`，**heredoc 顶掉 stdin** | 抽成独立 `x-timeline.pick.py` |
| 4 | 有命中却恒为 0 | 候选窗口取 `rows[-12:]`，但 facts 按**采集轮次**追加，不是时间序 | 按 `createdMs` 排序后截断，窗口提到 40 |

第 4 条最阴：首轮回填的旧推文排在文件末尾，把真正的新推文挤出窗口。排序修好后立刻命中。

### 最终配置

```json
{ "sources": ["x-timeline"], "minIntervalMs": 300000,
  "env": { "X_TIMELINE_MAX_ITEMS": "20", "X_TIMELINE_MAX_CANDIDATES": "40" } }
```

阈值 0.7。校准样本 24 条真实推文，双峰分布（命中 0.93/0.78，未命中最高 0.61）。

## 数据源：arxiv（2026-11-11 13:4x）

| 文件 | 作用 |
|---|---|
| `collectors/arxiv.sh` | 采集 arXiv 新论文（官方 API） |
| `collectors/arxiv.env.json` | `intervalMs=1800000`（30 分钟）、`timeoutMs=90000` |
| `collectors/arxiv.schema.json` | manifest 字段说明 |
| `targets/arxiv.sh` | L1 逐条 jev 打分，阈值 0.9 |
| `targets/arxiv.pick.py` | 按阈值筛成 items |
| `targets/arxiv.env.json` | `sources:["arxiv"]`、`minIntervalMs=1800000` |
| `seen-arxiv.json` | 去重表 `{ids, sinceIso}` |

### 为什么不用 alphaxiv

实测四条路径全部走不通：curl 直取首页 403、无头浏览器卡 Turnstile、**有头浏览器同样被挡**、
抓 HAR 显示首页 403 且**全程没有任何数据 API 请求**（Cloudflare 在入口拦死，连问哪个接口都看不到）。
无公开 API（`api.alphaxiv.org` 全 404）、无 RSS、无 sitemap。

它的 MCP（`https://api.alphaxiv.org/mcp/v1`）**确实能用**，`get_hot_feed` 正是要的 Hot 榜，
但需要 API key（Settings > API Keys）或 OAuth。用户选择先走 arXiv。

**代价**：拿不到 alphaxiv 的热度排序，只有时间序。**好处**：新论文比"已上榜的热门"更早。

### 两个必须记的坑

**1. 采集器不写 `source` 字段。** 插件会补，但离线校准/测试时它是 `null`。
target 里若写 `if fact["source"] != "arxiv"` 会把全部事实拒掉，表现为"候选 0 条、永不唤醒"。
已改为：**只在有值时校验，否则退化为按 `metric` 判断**。x-timeline 同一问题一并修了。

**2. 分类过滤已经筛掉了领域无关的论文，判据必须在这个基础上再加一层区分度。**
第一版判据写成"是否属于 AI/软件工程领域"，结果 15 篇里 10 篇都是 0.97+（因为
`cs.AI` 的论文天然满足）。收紧为"**论文是否直接给出可被工程复用的机制与实测数据**"后，
分布变成 0.91→0.01，只有 1 篇超过 0.9。

### 校准结果（15 篇真实论文，阈值 0.9）

| 分数 | 标题 |
|---|---|
| **0.91** | **Comparative Analysis of Agent Evaluation Frameworks**（三种评测范式受控对比，KDD 2026） |
| 0.89 | Continual-ARC（技能获取长期测量） |
| 0.78 / 0.77 / 0.71 | 翻译评测 / tool-using agent 蒸馏 / 蛋白配体排序 agent |
| ≤0.62 | 训练方法、领域建模、理论、综述 |

命中的正是与用户 dsh-reflex 判定层同题的工作（trace-based vs deterministic 评测范式选择）。

## arxiv 改为三层分级（2026-11-11 16:4x）

**用户口径纠正**：arxiv 是高质量信息源，**不是要挡掉，是要花更多精力分析**。
原来的二分阈值（0.9 过 / 否则丢）是信息损失——把「值得读但不紧急」的论文一起扔了。

### 改动

| 层 | 含义 | 处理 |
|---|---|---|
| `must` | 直接可复用的机制或实测结论 | **立即唤醒**（默认最多 3 篇/次） |
| `worth` | 相关但有价值需读正文判断 | **进待读清单**，不打扰；唤醒时报告清单条数 |
| `skip` | 与软件工程/AI 系统无关 | 丢弃 |

待读清单：`$REFLEX_HOME/arxiv-reading-list.json`，按 `worth` 概率排序，上限 200 条。

### 校准发现的硬事实

**三层判据下 `worth` 拿走 0.73–0.95 的概率，`must` 最高只有 0.27。**

20 篇实测分布：

```
must 0.27 / worth 0.73 / skip 0.00   ← ReTrace（蒸馏 tool-using agent）
must 0.24 / worth 0.76 / skip 0.00   ← Agent Evaluation Frameworks
must 0.19 / worth 0.81 / skip 0.00   ← FERN（表格检索）
...
must 0.01 / worth 0.87 / skip 0.12   ← 贝叶斯逆问题
```

所以**绝对阈值不适用**。改为：

1. `skip` 概率占优（≥ max(must, worth)）→ 丢弃
2. 其余按 **must 概率排名**，前 3 名且 must ≥ 0.10 → 立即唤醒
3. 剩下的都有 worth ≥ 0.30 → 进清单

`ARXIV_MUST=0.10` 这个低阈值是有意的：它只用来防止「一堆 0.01 的也算 must」，
真正决定谁唤醒的是**排名**。

### 一个字段名教训

清单里最初存 `score`，但实际存的是 `worth` 概率。打印时标成 must，
导致「清单里 must=0.87 比唤醒的 must=0.27 还高」这种误读。已改名 `worth`。

**教训**：字段名必须写清是哪个维度的概率，否则半年后必被误读。
