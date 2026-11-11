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

---

## 数据源：futu-baba 交易时段门控（2026-11-11 18:2x）

用户要求：「非交易时段没必要采集」。

原来的采集器每 `intervalMs=3600000`（1 小时）跑一次，**不分时段**。非交易时段取日 K
拿到的是同一根已收盘的 K，值完全不变，采集纯属空耗（每次 2 次 OpenD 往返 + 起 2 个 python）。

### 门控口径

用富途 `market_state` 判断，**不自己算交易日历**（自己算节假日与半日市必错）：

| market_state | 处理 |
|---|---|
| `MORNING` / `AFTERNOON` / `AUCTION` | **采** |
| 其它（`PRE_MARKET_*`、`CLOSED`、`AFTER_HOURS_*`、`NIGHT_*`、`OVERNIGHT`、`REST`…） | **跳过**，退出 0，stderr 写一行原因 |
| 取不到（OpenD 抖动/脚本异常） | **放行照采** —— 宁可多采一次，也不要因为门控坏了永久不采 |

跳过的语义是「本轮正常、无数据」，所以 `exit 0` 且 stdout 空；**不能非 0 退出**，
否则会被记成 L0 failed，每天非交易时段刷一堆告警。

盘前盘后夜盘一律不算交易中：日 K 在这些时段不动，采了也是同一个值。

### 两个 macOS bash 3.2 的静默坑（都让门控失效却看着正常）

**① `${VAR^^}` 不支持**

macOS 自带 `/bin/bash` 是 **3.2.57**，没有 bash 4 的大小写转换。写了会报
`bad substitution`，**该行展开为空**，正好落进「取不到就放行」分支 ——
门控全线失效，但日志看起来只有一句 benign 的「门控放行」。
改用 `tr '[:lower:]' '[:upper:]'`。

**② 变量紧贴全角字符会 `unbound variable`**

`"非交易时段（$MARKET_STATE），跳过"` —— bash 3.2 的 locale 不解析多字节字符，
把 `）` 的第一字节当成变量名的一部分，报 `MARKET_STATE�: unbound variable`，
`set -u` 下直接退出 1。必须写 `${MARKET_STATE}`。

**教训**：这两条都表现为「脚本在跑、退出码 0 或 1、没有任何显式错误」。
门控这类「本该干活/本该不干活」的逻辑，**必须做全状态矩阵实测**，
不能只看真机当前那一个状态碰巧对不对。本轮实测了 16 种状态（含空状态），16/16 通过。

### 实测记录

16 种 market_state 矩阵（伪造 market_state、真 get_kline）：

```
✓ MORNING            fact=1   交易中（MORNING），采集
✓ afternoon          fact=1   大小写不敏感
✓ Afternoon          fact=1
✓ AUCTION            fact=1
✓ PRE_MARKET_BEGIN   fact=0   非交易时段，跳过采集
✓ PRE_MARKET_END     fact=0
✓ CLOSED             fact=0
✓ AFTER_HOURS_BEGIN  fact=0
✓ AFTER_HOURS_END    fact=0
✓ NIGHT_OPEN         fact=0
✓ NIGHT_END          fact=0
✓ OVERNIGHT          fact=0
✓ FUTURE_OPEN        fact=0
✓ REST               fact=0
✓ WHATEVER           fact=0   未枚举的状态一律不采（保守方向正确）
✓ <空>               fact=1   门控坏 → 放行
```

真机当前 `PRE_MARKET_BEGIN` → 跳过，`facts/futu-baba/` 无新增，符合预期。

**布林带口径未动**：伪造 MORNING 实跑，输出 `price=102.72 ma=104.313 upper=112.7545
lower=95.8715 positionPct=40.56` —— 与改前逐字一致。

### 遗留

- 采集仍按固定 1 小时间隔跑，交易时段内**每天最多采 6–7 次**（21:30–04:00）。
  这不是「每小时整点采」，是「开机后每小时轮到一次」。要整点对齐得改成 cron 式调度。
- 跨日边界：`lastBarTime` 是美东日期，`ts` 是本地时间，两者不同源，看数据时别混。

---

## 唤醒台账自动化（2026-11-11 21:0x）

### 问题

`shadow/wake-ledger.jsonl` 停在 16:24，而 17:02（arxiv）和 17:09（x-timeline）两次唤醒
都没进账。`last-wake.json` 有这两次记录，说明**投递成功了，台账没跟上**。

根因：`wake_ledger.py` 是**手动工具**，插件里没有任何调用点
（`grep wake_ledger index.js` 为空）。台账只是某次手工跑留下的快照。

而且台账只覆盖 `reflex-health` 和 `x-timeline` 两个 target —— **arxiv 全程零记录**。
那次「首次上线」的唤醒恰好是最有价值的一条。

**为什么一直没发现**：reflex-health 的检查项只有采集失败/判定失败/叫不醒/重载风暴/源静默，
没有一项管"台账有没有在写"。

### 改动

**不碰插件代码**（`index.js` 改在 node_modules，npm 升级会覆盖 —— 与补丁 3/4 同一个坑）。
改在采集器侧，两件事：

**① 每轮重建台账**（`REFLEX_HEALTH_LEDGER_REBUILD`，默认开）

`wake_ledger.py` 是**纯重建**（读日志 + 会话正文，覆盖写），天然幂等，跑多少次结果一样。
实测 **0.74s / 14 条**，自检本来就是 10 分钟一轮，完全负担得起。

重建路径按序探测：`~/.agents/skills/reflex-tuning/scripts/wake_ledger.py`
→ `~/SourceCode/dsh/skill/reflex-tuning/scripts/wake_ledger.py`。
`REFLEX_HEALTH_LEDGER_TOOL` 可指定。

**② 检测滞后**（`wake-ledger-stale`，新检查项）

判据三条同时成立才报：

1. 日志里 `L2: woken` 条数 **>** 台账条数
2. 日志最后一次唤醒距今 **≥ 5 分钟**（`REFLEX_HEALTH_LEDGER_LAG_MIN`）
3. 不在安静时段

第 2 条不能省：台账是重建出来的，正常轮次里它总比日志晚一个写盘周期。
去掉阈值会在每轮自检都报一次"滞后"—— 而实际上重建已经修好了。

第 3 条同理：夜里本来就没唤醒，滞后是必然。

### 为什么重建和检测都要有

只有重建：重建失败（脚本被移走、权限变了）时台账悄悄停摆，又回到看不见的状态。
只有检测：每次都报一个"已经好了"的问题，纯噪音。

**重建负责自愈，检测负责在自愈失效时告诉你。** 两个都有，正常情况下一条都不响。

### 实测

| 场景 | 期望 | 实际 |
|---|---|---|
| 台账与日志一致（2 vs 2） | 不报 | ✓ 0 条 |
| 台账少 1 条，最后唤醒 1 分钟前 | 不报（阈值保护） | ✓ 0 条 |
| 台账少 1 条，最后唤醒 30 分钟前 | 报 | ✓ 1 条 |
| 安静时段（20:59） | 不报 | ✓ 0 条 |
| 删掉台账文件跑采集器 | 自动重建 | ✓ 恢复 14 条 |
| target 端到端（喂一条 stale 事实） | 唤醒，中文标题+正文 | ✓ |

反例 2 第一次"失败"是**我测试脚本自己的 bug**（`time.time()` 是秒，我当毫秒传，
时间落到 1970），不是生产代码问题。修正后通过。

### 补充：台账里的一列指标无效

`user_msg_10m` 恒为 True，**零区分度**。实测用户真实消息中位间隔 3.6 分钟，
79% 的间隔 < 10 分钟，任何时刻往后看 10 分钟都能"找到用户回应"。

这个指标早在 2026-11-11 16:2x 就判定无效了，但台账还在算、还在写。
**看台账时不要用它判断唤醒有没有用**，要看 `items` 里的具体条目和后续动作。
（要不要把它从台账里去掉，等哪天确认没人依赖再说 —— 删字段比加字段危险。）

---

## x-timeline 阈值微调 0.9 → 0.82（2026-11-11 21:4x）

### 起因

用户问「x 好久没推送了」。查下来系统没坏：17:09 之后判了 283 条，
但最高只有 0.910（就是 17:09 那条本身），之后最高 0.890，差 0.01 没到 0.9。

### 根因：阈值卡在无标签的空白带里

原阈值 0.9 是 **48 条标签**时拟合的。检查标签覆盖发现：

```
标签覆盖的分数区间: 0.00 - 0.96
但 0.80-0.94 这 20 条里, 只有 1 条有标签, 19 条没有
```

**阈值之争正好卡在没有标签的空白带。** 拟合工具给出的 0.940 是"没数据就别说低"的
保守解，不是数据支持的结论。

### 补标 19 条后的反转

按用户 16:35 定的口径（x 是扩信息面，判据不能严）标注：

- **正例**：模型/工具的真实发布、开源、上线、可用性变化、有工程内容的博客
- **负例**：纯观感对比、只写"我的测试"无内容、预告配图、低于预期吐槽

补标后 67 条标签，重新拟合：

| 阈值 | Precision | Recall | 通过量 |
|---|---|---|---|
| 0.61 | 75.0% | 100% | 53 条 (9.5%) |
| **0.82** | **100%** | **90.5%** | 19 条 (3.4%) |
| 0.90（旧） | 100% | 75.0% | 8 条 (1.4%) |

**边界非常干净**：

```
≤0.80  全是负例（前端动画对比 / 低于市场预期 / "my tests" / 预告配图）
≥0.81  全是正例（ERNIE 5.5 发布、Qwen 4 Max 上线、vLLM 工程博客、Agent 推理加速论文）
```

### 为什么取 0.82 而不是拟合点 0.81

0.81 紧挨着 0.80 的两条负例，只差 0.01。打分本身有抖动（今天实测同类内容在
0.86–0.91 之间浮动），留 0.02 余量。代价：Recall 95.2% → 90.5%，少 1 条。

### 风险证书 @0.82

| 指标 | 点估计 | 单侧置信界 |
|---|---|---|
| Precision | 100.0% | **≥ 85.4%** |
| 误报率 | 0.0% | ≤ 14.6% |
| Recall | 90.5% | **≥ 72.9%** |

⚠️ 标签是**分层抽样**（边界带优先），CP 区间严格说只对抽样分布成立，不是总体证书。

### 改动

`targets/x-timeline.sh:151` 默认值 `${X_TIMELINE_THRESHOLD:-0.9}` → `0.82`，
注释里写了完整依据。热生效，不用重启。

同时新建 `tools/shadow_targets.json` 记录 tag→阈值映射（拟合/证书工具靠它读当前阈值）。

### 教训

**阈值拟合的前提是「阈值附近的样本有标签」。** 48 条标签散在 0.00–0.96，
看上去覆盖全区间，实际上边界带是空的 —— 拟合工具仍会给出一个精确到小数点后三位的
"最优阈值"，但那个数字没有任何数据支撑。以后拟合前先查一件事：
**目标阈值 ±0.10 内有多少条标签**，不够就先补标。
