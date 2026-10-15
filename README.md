# dsh-reflex

> 给 [ds-bot](https://github.com/Fei2411/DeepSeek-Bot) 加一条**反射弧**：大多数时候保持安静，只在值得占用大模型注意力时才叫醒它。

一个 DSH（DeepSeek Harness）的兄弟插件，与 ds-bot 并存，**不改动 ds-bot 任何代码**。

[中文](README.md) | [English](README.en.md)

---

## 它解决什么

大模型不适合做轮询的事。每 5 分钟醒一次问"有事吗"，绝大多数答案是"没有"，而每次都要花钱、占配额、还要处理一遍上下文。

dsh-reflex 的做法是**把判断上移到便宜的地方**：便宜的层一直跑（采集事实、本地决策模型打分），只有跨过阈值时才唤醒贵的层。所以叫"反射" —— 不经过大脑的判断。

```
                 ┌─── 一直跑，几乎不花钱 ───┐   ┌─ 只在必要时 ─┐
  数据源  ──►   L0 事实层  ──►  L1 决策层  ──►   L2 推理层
  (脚本)       (汇总存储)     (本地决策模型)     (ds-bot / 大模型)
                                    │
                                    └─ 大多数时候：什么都不做，保持安静
```

## 三层各做什么

| 层 | 职责 | 成本 | 实现 |
|---|---|---|---|
| **L0** | 采集事实，落盘成可追溯的时间线 | 极低 | 脚本驱动，自动发现 `collectors/*.sh` |
| **L1** | 判断"这条值不值得占用 L2 的注意力" | 极低（本地决策模型，一次前向） | 脚本驱动，自动发现 `targets/*.sh` |
| **L2** | 真正需要判断"要不要打扰人、以什么形式"的事 | 高 | 唤醒 ds-bot 里的 Bot |

**为什么要分层**：判断"要不要打扰人"这件事本身是大模型的活，但它不该在每一次采集后发生。L1 用本地决策模型（[SemIf](https://github.com/TheoLeeCJ/SemIf) 读答案槽 logits，约 0.3 秒、不联网）先筛一遍，把 99% 的"不值得"挡在 L2 之外。

## 与 ds-bot 的关系

- 独立 cordis 插件，通过 `cordis.patch.yml` 以 `insert` 方式挂载
- 与 ds-bot **同进程**运行（拿到 `sessionController` 用于投递），但**零修改**原版
- 初始化失败会降级为日志记录，**不拖垮宿主**（兄弟插件的硬要求）

## 安装

```bash
dsh plugin --profile <你的 profile> add github:onesmash/dsh-reflex
```

`dsh plugin` 把参数转发给 profile 目录里的 pnpm：它拉取并安装这个包，并因为本包在
`package.json` 里声明了 `dsh.bundle`，同时把 `dsh-reflex` 追加进该 profile 的
`dsh.profile.bundles`。依赖随包一起装在 profile 里，不需要额外步骤。

不启动、先验证层已生效：

```bash
dsh --profile <你的 profile> --dump-config    # 应出现 "# == dsh-reflex"
```

然后在同一个 profile 的 `cordis.patch.yml` 里给插件留配置块：

```yaml
- id: dsh-reflex
  config:
    l0:
      sources: [disk, swap]        # 启用哪些采集源
    l1:
      targets: [disk]              # 启用哪些判定目标
      targetBot: Chief             # 唤醒哪个 Bot
      quietHours: { from: '18:00', to: '09:00' }
```

重启 DSH 生效。日志里会看到：

```
dsh-reflex installed: L0=60000ms L1=60000ms target="Chief" sources=[disk,swap]
```

### 本地开发：指向你的 checkout

改这个插件本身时，用**路径**安装 —— pnpm 会建符号链接，改动直接随源码走：

```bash
dsh plugin --profile <你的 profile> add /绝对路径/dsh-reflex
```

**这种方式下依赖要装在 checkout 里**：linked 安装保留自己的 `node_modules`，
Node 按仓库真实路径解析依赖，所以要单独跑一次：

```bash
cd /绝对路径/dsh-reflex && pnpm install
```

（从 GitHub 安装没有这个问题 —— 包和依赖一起装进 profile。）

## 配置

全部配置项都可以在 profile patch 的 `dsh-reflex.config` 下覆盖。关键项：

| 项 | 默认 | 说明 |
|---|---|---|
| `l0.intervalMs` | 60000 | 采集周期 |
| `l0.sources` | `[disk]` | 启用的源；内置 `disk`/`swap`，其他靠 `collectors/*.sh` |
| `l0.homeDir` | `~/.dsh/dsh-reflex` | 工作目录（可用环境变量 `REFLEX_HOME` 覆盖） |
| `l1.intervalMs` | 60000 | 判定周期 |
| `l1.targets` | `[disk]` | 启用的判定目标 |
| `l1.threshold` | 0.8 | 本地模型打分阈值 |
| `l1.hardRule` | `{lowAvailableGB:20, highUsedPct:90}` | 硬规则（如磁盘告警），可穿透安静时段 |
| `l1.targetBot` | `Chief` | L1 命中后唤醒谁 |
| `l1.cooldownMs` | 1800000 | 同状态冷却，避免重复唤醒 |
| `l1.quietHours` | `null` | 安静时段：内容类命中不打扰，攒到时段结束合并成一条 |
| `l1.profile` | `''` | 用户画像，组装判定 context 用 |

**决策后端**可切换（`backend` 字段）：本地 SemIf（默认，不联网）或托管 Jev。适配层在 `tools/semif-adapt.py`。

## 数据源：由你自己写

**插件仓库里没有 `collectors/` `targets/` `tools/`** —— 这三样是你的东西（接哪些源、什么判定口径、回执走哪个渠道），因人和环境而异，不属于框架。它们只活在运行目录（默认 `~/.dsh/dsh-reflex/`）里。

插件启动时会扫描：

```
~/.dsh/dsh-reflex/
├── collectors/     <name>.sh → 自动注册为采集源（配 <name>.env.json 提供参数）
├── targets/        <name>.sh → 自动注册为判定目标
├── tools/          判定脚本可以调用的工具
├── facts/          L0 采集到的原始事实（按源/日期分文件）
└── dsh-reflex.log
```

**完整契约、模板、验证清单见 [DATASOURCE.md](DATASOURCE.md)** —— 也可以作为 skill 自动加载（`skill/reflex-datasource/`）。

## 目录结构

```
index.js              宿主侧: L0 调度 + L1 判定 + 唤醒投递
client.js             面板侧: 配置表单
cordis.patch.yml      挂载声明
DATASOURCE.md         数据源开发契约
skill/                随插件分发的能力包
tests/                回归测试
```

## 第三方

`skill/` 下有两份随插件分发的第三方内容，各自保留原许可与署名：

| 包 | 来源 | 许可 |
|---|---|---|
| `skill/semif-decide/` | [SemIf](https://github.com/TheoLeeCJ/SemIf) 源码快照 | MIT |
| `skill/typesafe-ai/` | TypeSafe 官方 agent skill | MIT |

两者均为 **seed-only** 策略：只在你本地**缺失**时安装，已存在则跳过，不会把你自己装的上游版本降级。

## License

[MIT](LICENSE)
