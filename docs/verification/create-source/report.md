# 创建数据源：崩溃原子性（S1 模型 + S2/S3 桥接）

对象：Trigger 页「＋ 添加数据源」这条链路 —— `sources.mjs` 的 `planSourceFiles` / `createSource`。
上游登记表：`docs/property-register-sources.md` 的 **P19**。

## 这条规则（读者认可的那句话）

> **绝不会出现「采集器已经在盘上、但判定脚本不在」的源。**

为什么这条最贵：`collectors/<name>.sh` 一出现，插件下一轮就把它当数据源开始采集；而
`targets/<name>.sh` 是判定入口。缺了后者，这个源会**一直采集、永远不叫醒**——数据静默堆在
L0 里没人知道。更糟的是重名守卫会拦住重建（`已存在：collectors/<name>.sh`），
用户只能自己去删文件，而界面上看不出为什么。

为什么测试摸不到：`createSource` 用 `try/catch` 回滚，只能挡「抛异常」；**进程被杀跑不到 catch**。
P13 的语法检查测试、P10 的采集器行为测试都不经过这个窗口。

## 模型（不建模到什么程度）

`Order.tla`：3 个变量（`staged` 临时文件、`committed` 已落盘的文件、`crashed` 是否被杀），
7 个动作（`Stage` / `Rename1` / `Rename2` / `Rename3` / `Crash` / `Abort` / `Done`），
状态空间 10 个状态 / 18 步（TLC 实测），`-workers auto` 一秒内跑完。

**抽象**：五个文件压成三类 —— `1` = `collectors/<name>.sh`（提交点），`2` = `targets/<name>.sh`，
`3` = 其余三个配置。规则只关心「采集器 vs 判定脚本」，所以其余配置归一类足够。
落盘顺序用守卫编码，不用序列（`statechart` 的前端不吃序列，会把模型跑崩）。

**两个变体**：

| 变体 | 落盘顺序 | 判定 |
|---|---|---|
| `current.cfg`（改之前的代码） | `1 → 3 → 2`，采集器最先 | **Atomic breaks** |
| `fixed.cfg`（现在的代码） | `3 → 2 → 1`，采集器最后 | `Atomic, NoDeadlock` 全守住 |

## 反例（TLC 给的最短路径，两步）

```
0. nothing yet
1. you press create                  → staged, invisible to the plugin
2. the collector file lands           → visible source after 1/3 files      ← Atomic 破在这里
```

读成人话：**点了创建以后，第一个落盘的就是采集器。这时源已经"可见"，但它的判定脚本还没落盘；
此刻进程被杀，半成品就永久留在盘上。**

`chart-current.mmd` 是同一张图（`chart-fixed.mmd` 是修好之后的样子，没有 breaks 标记）。

## 桥接（模型的话 ↔ 代码的哪一行）

| 模型里的东西 | 代码里的东西 |
|---|---|
| `Rename1` 是采集器落盘 | `planSourceFiles` 返回数组的**第一项**就是 `collectors/<name>.sh`（改之前） |
| `commit` 顺序 = `Order` | `createSource` 里 `for (const f of rendered) rename(f.tmp, f.path)` 按 plan 顺序逐个 rename |
| `Crash`（清理跑不到） | 真进程被 `SIGKILL`：`tests/create-source.test.mjs` 的 **P19** 用子进程在第 2 次 `rename` 时杀自己 |
| `Atomic` | P19 的断言：`!collector || targetScript` |

**先红后绿**：P19 在改代码前跑出来是红的，理由就是上面那句
「collectors/crash.sh 在盘上，但 targets/crash.sh 不存在」；把顺序改掉之后变绿。

## 修法与证据

改成 `planSourceFiles` 最后返回采集器：

```js
return [...collectorConfig, ...targetFiles, commitPoint]   // commitPoint = collectors/<name>.sh
```

采集器成为**唯一提交点**：前面任何一个文件没落成，源都还不可见（最坏留下无害残留）。
这不是靠推理定下来的，两个证据都能重跑：

```sh
bash docs/verification/create-source/check.sh
#   现顺序（采集器最先）：TLC rc=12，违例=1
#   修法顺序（采集器最后）：TLC rc=0，无错=1
#   PASS Atomic：现顺序被违反、修法顺序守住 —— 与代码里的落盘顺序一致
#   退出码 0 / 1（结论与预期不符）/ 2（找不到 Java 或 tla2tools.jar，未判定）

node --test tests/create-source.test.mjs     # 含 P19 崩溃重放
node tests/sources-invariants.mjs            # P19 的破坏变体：把提交点挪回最前必须报红
```

生成图（可选，需要 `statechart`）：

```sh
JAVA=... TLA2TOOLS=... <statechart>/scripts/statechart Order.tla --config current.cfg --view view.mjs --out out-current
```

## 模型不管的部分（写清边界，别当成已覆盖）

- **并发同名创建**：不建模。`createSource` 全是同步 fs 调用，同一事件循环里没有 `await` 交错点，
  两个请求不可能同时进到存在性检查与 rename 之间。
- **写一半的临时文件**：不建模。`rename` 在同一个文件系统内是原子的；tmp 写一半不会出现在目标名上。
- **异常路径的回滚**：不建模（已有 P13 的语法检查测试守着：检查失败时一个文件都不留）。
- **读侧**：`scanSources` 只看 `*.sh` 存在与否，它不检查配套文件是否齐全——这是模型成立的前提，
  也是这个不变量值得守的原因：读侧不会替你发现问题。
