# 改动日志 · jev 补丁重构（ub-mode）

> 2026-11-11 · 对象：`dsh-reflex@0.3.18` 的 jev 补丁
> 模式：review → 重构。行为由测试锁定，重构后逐条复验。

## 一、为什么做

补丁是"先让它跑通"的产物，能工作，但按 ub-mode 审视有三处结构性欠账：

1. **一个决定写在多处**：`cfg.backend` 被三处各自 `trim()` 读取（注入环境变量、
   分流、日志标签），必然漂移。
2. **同一事实两个来源**：`scoreRow` 算出 `pYes`，`writeShadow` 又从 `probs`
   重算一遍，两套回退规则。
3. **死代码与过宽的公开面**：`raw` 字段无人消费；6 个纯函数导出但外部从不引用。

## 二、Make it Work（先锁行为）

**TDD：先写测试，跑通即证明当前行为**（20 条，全过）。
测试只走公开 API，用假 fetch 截住网络边界，不 mock 内部函数。

- 请求构造 3 条（state 序列化 / criteria 回退 / 无选项拒绝发请求）
- 响应解析 4 条（choice 优先 / argmax 回退 / 无 yes 时 pYes=0 / 缺 answers 报错）
- HTTP 错误 1 条
- URL 拼装 2 条（裸 host 补全 / 已含 systemone 不重复拼）
- 批量语义 3 条（部分失败保留成功 / 全失败抛出 / 空输入不发请求）
- shadow 7 条（字段集合 / passed 翻转 / 无阈值 null / 追加不覆盖 / 空结果不写 / 跳过未打分行 / 写盘失败静默）

`node --test jev-adapter.test.mjs` → **20 pass / 0 fail**。

## 三、Make it Right（改结构，证明没变行为）

### 3.1 拆分职责（Boundary Discipline）

原 `scoreRow` 38 行里同时做：校验、构造请求、发请求、判状态码、解析。拆成：

| 函数 | 职责 | 纯? |
|---|---|---|
| `buildRequestBody` | 一行 → 请求体 | ✅ |
| `buildCriteria` | 选项 → criteria（null 陷阱在这里挡） | ✅ |
| `parseAnswer` | 响应 → {winning, probs} | ✅ |
| `pickWinning` / `argmax` | 选优规则 | ✅ |
| `scoreRow` | 只做网络编排 | ❌ |

### 3.2 一个决定只留一处

- 新增 `configuredBackend()`，`index.js` 里三处读取收敛成一处调用。
- `pYesOf()`（给阈值比较，无 yes 即 0）与 `scoreOf()`（给 shadow，与 python
  `score_of` 同规则）**分开命名**——它们是两个不同的问题，不是一个重复实现。
- `toShadowRecord()` 成为字段映射的唯一位置；`writeShadow` 只负责 IO 与保留策略。

### 3.3 删掉的东西

| 删除 | 理由 |
|---|---|
| `raw` 字段 | 无人消费（死代码） |
| 6 个 `export`（`normalizeUrl`/`buildRequestBody`/`pYesOf`/`scoreOf`/`parseAnswer`/`toShadowRecord`） | 外部与测试都不直接用，公开面越小越好 |
| 重复的 `pYes` 回退链 | 收敛成命名函数 |
| 内联的并发池 | 提取 `forEachConcurrent`（12 行，一处复用） |

### 3.4 体量与函数长度

`jev-adapter.mjs` 从 207 → 266 行，但**函数显著变短**（原 38 行单体拆开）：

```
writeShadow 38 · scoreBatch 30 · scoreRow 24 · toShadowRecord 20
pruneOldShadowFiles 15 · buildRequestBody 14 · buildCriteria 12
parseAnswer 12 · forEachConcurrent 12 · pickWinning 7 · pYesOf 7
normalizeUrl 6 · argmax 6 · scoreOf 6 · localDate 6 · sha1hex 3
```

行数增加来自 import 归位、常量提取与注释；复杂度是下降的。

## 四、证明行为没变

| 检查 | 结果 |
|---|---|
| 重构后跑同一套测试 | **20 pass / 0 fail**（与重构前一致） |
| `node --check` 两个文件 | 通过 |
| 真实端点调用（重构后） | 576ms，`winning=no pYes=0.020`，shadow 写入 1 条 |
| shadow 字段 | 12 个字段与 `shadow_record.py` 逐一对齐 |
| 返回对象键 | `winning,pYes,probs`（`raw` 已删，调用方不依赖） |
| L1 运行时 | 11:51 仍在跑，`pYes=0.070`，无报错 |

## 五、遗留（未做，需明确）

| # | 项 | 原因 |
|---|---|---|
| 1 | jev 分支无重试 | 半小时内可加，但当前失败只浪费一轮（60s），优先级低于其它 |
| 2 | shadow 明文写 `state` 前 1200 字符 | 与 python 契约一致；**挂内容类 target 前必须先处理**（改哈希或压到 200 内） |
| 3 | 阈值仅在 7 个合成样本上测过 | 需真实 shadow 样本积累后拟合 |
| 4 | 未跑上游测试套件 | 需先装 `.skill-envs` |

## 六、下一步

重启一次即可让本次改动全部生效（此前已告知需重启）。重启后日志应显示
`L1[disk]: jev winning=...`（后端名不再写死为 SemIf）。
