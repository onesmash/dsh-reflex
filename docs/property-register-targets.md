# shadow_targets 登记表一致性：性质登记表（S0 产出，S5 收口时再核）

范围：`tools/shadow_targets.json` 这类「登记表」的**数字可信性**，对应 2026-11-24 优化清单的 1–5 条。
不含阈值算法改动，不含判据改动。

范围声明：**单进程、单写者**（人改脚本 / 脚本写盘，二者不并发；读侧可以有读者）。
不建模文件系统原子写、不建模多实例同步、不建模派生算法本身（模型里 `TrueRecall` 就是真值）。

| 编号 | 性质（一句话，可被反例证伪） | owner | 覆盖的文件/函数 | 范围 | 证据等级 | 破坏变体 / 证据命令 | 退出码 | S4 日志 | 状态 | sync commit |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 读者读到的登记表派生指标，恒等于同版本计数算出来的值 | Chief | `docs/verification/registry-consistency/Registry.tla`（模型）、`skill/reflex-tuning/scripts/shadow_targets_io.py`（真实读层，运行时文件在 REFLEX_HOME/tools/ 下，不在仓库） | 单进程、单写者 | L2（模型 + 真实文件回放） | 模型两卡成对：`docs/verification/registry-consistency/two-step.cfg` 必须报红、`single-source.cfg` 必须绿；回放：把 TLC 的 `WriteCounts → Read` 打到真实副本上，「取副本」读法须判红而读层须读对。命令 `bash docs/verification/registry-consistency/check.sh` 与 `python3 tests/test-reflex-targets-invariants.py` | 0 | 未做：无 CI 面，断言以守门测试形式存在（`--check` 子命令 + `tests/test-reflex-targets-invariants.py`），尚未挂到定时/提交钩子 | 守住（单写者） | 5357561bc728 |
| T2 | 任何工具读取标签文件前都要求它带 `state_hash`，缺失则拒绝读取并指名拒绝原因 | Chief | `skill/reflex-tuning/scripts/shadow_targets_io.py` 的 `load_labels` | 单进程 | 不建模：入口校验，一次检查就够；由守门测试覆盖 | 变体：真实标签文件缺 `state_hash` 时 `load_labels` 必须抛 `LabelsMissingStateHash` 并报出缺失计数；显式豁免必须回报计数与模式；契约检查要求每个 `LA.load(` 调用都写着 `require_state_hash=True`。解析只有一份实现（`skill/reflex-tuning/scripts/labels_any.py`），读层转调它。命令 `python3 tests/test-reflex-targets-invariants.py` | 0 | — | 守住（单写者） | 5357561bc728 |
| T3 | `threshold` 变更时登记表里必须存在可机检的 `whyNotBatch` 引用，且该 artifact 路径真实存在 | Chief | `skill/reflex-tuning/scripts/shadow_targets_io.py` 的 `check_why_not_batch` | 单进程 | 不建模：写盘前置条件，一次检查就够；由守门测试覆盖 | 变体：填不存在的 artifact 路径 → 必须 `WriteRefused`；不写 `whyNotBatch` → 同样拒写；写一句话（无路径无 id）→ 拒写。命令 `python3 tests/test-reflex-targets-invariants.py` | 0 | — | 守住（单写者） | 5357561bc728 |
| T4 | `citable` 恒等于由 `pc.noiseAppendNear` / `positives` / `calibration` 派生的值，手写值与派生值不符即红 | Chief | `skill/reflex-tuning/scripts/shadow_targets_io.py` 的 `derive_citable` | 单进程 | 不建模：纯函数，输入定了输出就定了；由守门测试覆盖 | 变体：登记表里出现手写 `citable` → 必须判红（当前零样本：没有手写值，故另有 T4-b 用真实字段现算，不许当成已覆盖）。命令 `python3 tests/test-reflex-targets-invariants.py` | 0 | — | 守住（单写者） | 5357561bc728 |
| T5 | 被标注为截断的拟合值（`fitTruncated`）不出现在「取最优阈值」的读取路径里 | Chief | `skill/reflex-tuning/scripts/shadow_targets_io.py` 的 `get_fit`、`skill/reflex-tuning/scripts/threshold_fit.py` | 单进程 | 不建模：静态字段契约，由 schema 级校验覆盖 | 变体：`fitTruncated` 里的 `R8`/`R16` 被当 `fit` 读 → 必须抛 `TruncatedFitMisuse`；真实登记表已把两者的 0.70 移入 `fitTruncated`。命令 `python3 tests/test-reflex-targets-invariants.py` | 0 | — | 守住（单写者） | 5357561bc728 |
| T6 | 登记表里的证书计数（tp/fp/fn/n_labeled）可由 labelsFile + shadow + 工作点现算复现，不可复现时必须显式声明过期 | Chief | `skill/reflex-tuning/scripts/risk_certificate.py` 的 `--json` 输出、`skill/reflex-tuning/scripts/shadow_targets_io.py` | 单进程、同一数据目录 | 不建模：外部数据随标注增长，属版本问题不是交错；由守门测试 T1-e 覆盖 | 变体：把 `certificate.countsStale` 删掉后必须判红（同一段代码路径已实测两次：先红于缺声明，后绿于声明）。重拟合要动阈值，属需决策项，未自动执行。命令 `python3 tests/test-reflex-targets-invariants.py` | 0 | — | 未判定（存量属 442 条旧样本，现存 487，未重拟合） | 5357561bc728 |

## S0：哪些性质建模、哪些不建模（决策留痕）

只有 **T1** 进 TLA+ 建模。判据是 S0 的「坏了最贵 × 测试最摸不到」：

- **坏了最贵**：这条坏了不是报一个错，是**所有人对外报的数都可能是错的**。2026-11-24 已经出过实例——顶层 `recallPoint: 0.856` 在登记表里没有任何一个已声明的分子分母能整除复现（0.856×144=123.26、×171=146.38 都不是整数），而证书按 `tp=132 / tp+fn=144` 算是 0.9167。抄错一次，往后每个引用它的人跟着错。
- **测试摸不到**：这不是某一次写入的 bug，是**跨版本累积漂移**——每次只改一部分字段，单次写入测试全绿，漂移只在两个字段之间慢慢拉大。纯函数测试看得见「这次写对了吗」，看不见「两个副本什么时候分叉」。

**T1 建模要回答的具体问题**：复制品方案（计数与派生分两步写）有没有一个可读窗口，让读者看到「计数已新、副本仍旧」？模型给的是最短违规路径：`WriteCounts → Read`，两步，`sawBad` 从 FALSE 变 TRUE。改成单一真值源后这条路径消失——因为派生是读时现算，窗口根本不存在。

其余四条不建模，替代证据写在「证据等级 / 破坏变体」列：

- **T2**：入口校验（和 sources 表的 P5、P13 同类），纯函数测试就能守；
- **T3**：写盘前的前置条件，一次检查就够，没有交错；
- **T4**：纯函数，`citable = f(噪声不变性, 正例数, 校准状态)`，输入定了输出就定了；
- **T5**：静态字段契约，schema 级校验，跑一次就知道。

> 这条决策本身要能被核对：只写「不建模」而不写理由，事后没人能判断当时是真不需要，还是漏了。

## S2：反例逐步映射到真实代码（模型 → 代码）

TLC 只证明「模型里有这条路径」；这一步证明真实文件上也有。逐步对照：

1. **`WriteCounts`（计数先写）**——`threshold_fit.py` / `risk_certificate.py` 把 `tp` / `fp` / `fn` 写进 `certificate`，同一份 `shadow_targets.json`。证据：`x-timeline.certificate` 有 `tp 132 / fp 242 / fn 12 / n_labeled 442`。
2. **副本未跟（窗口打开）**——四个派生字段（`precisionPoint` / `precisionLB` / `recallPoint` / `recallLB`）由人手抄写，全仓 grep 不到任何写者。证据：`grep -rn precisionPoint skill defaults` 无命中。
3. **`Read`（读者读到旧值）**——任何人或报告直接读这四个字段。实测 `recallPoint` 存 0.856、现算 0.9167；`precisionPoint` 存 0.348、现算 0.3529。

复现不出就要先疑模型——这次不用疑：真实文件的数就对不上，回放用例（`T1-b`/`T1-c`）在真实副本上判红。

## S3：守门（ub-mode：先红，再看它按预期理由红，再变绿）

1. **第一次红**：读层文件不存在 → `FAIL 读层存在`，其余全部 `未判定`（exit 1）。
2. **第二次红（预期理由）**：`FAIL T1-a … [x-timeline.precisionPoint 存 0.348 ≠ 算 0.3529; x-timeline.recallPoint 存 0.856 ≠ 算 0.9167]`。
3. **变绿**：删掉副本、`fit` 里的截断值移进 `fitTruncated` 之后 → `16 PASS / 0 FAIL / 0 UNVERIFIED`，exit 0。
4. **它有没有分辨力**：同一条断言换「取副本」的读法必须判红（`T1-c`：副本给 0.856、读层给 0.9172）；读层返回 `None` 时必须判红（`T1-d`）。两条都在同一份测试里常开。

## S5 收口：三句话

1. **这条性质是什么**：读者读到的登记表派生指标，恒等于同版本计数现算出来的值（T1）；证书里的计数必须能由 labelsFile + shadow + 工作点复现，不能复现就得显式声明过期（T6）。
2. **哪个命令重跑**：`bash docs/verification/registry-consistency/check-all.sh`——模型两卡 + 守门二十项 + 登记表机器核对，一次跑完，按 0/1/2 三态退出。
3. **覆盖到哪个 commit**：git sha `5357561bc728`（12 位前缀，与表内 sync commit 列同一提交）。代码再改就把 sync commit 列标 pending 并重跑，别让表上的数比代码新。

六条可重跑判据的自检（都实测过，不是推断）：

- 干净 shell：`env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/local/bin bash docs/verification/registry-consistency/check-all.sh` → exit 0。
- 不靠调用方变量：运行时目录走 `RVCA_HOME → REFLEX_HOME → 默认`，工具名走 `RVCA_NODE` / `RVCA_PYTHON`；前置检查找不到目录时报「找错目录」而不是「数据不足」。
- 三态分开：把 `RVCA_HOME` 指向空目录重跑 → exit 2（未判定），不是 0。
- 从零跑一次就有结论：脚本不写仓库、模型与守门都用临时目录，跑两遍结果一致。
- 观察值不算证据：「可复算 tag：1」「标签 487 唯一」这类只作快照记录，不挂在「守住」下面。
- 证据命令落成脚本：就是上面那条命令，不是聊天里的一段。

## 模型自身踩过的坑（记下来，免得下一个人重踩）

1. **无界序列会让状态空间发散**：第一版用 `seen` 记录每次读取结果，`Read` 可无限追加，`fn` 也可无限增长，TLC 跑到 60 秒仍不收敛。改法：把「读到过不一致」换成布尔锁存 `sawBad`，并把 `fn` 有界到 `FN0..FN0+2`。
2. **`=` 与 `\/` 的优先级陷阱**：写成 `sawBad' = sawBad \/ mismatch`，TLA+ 解析成 `(sawBad' = sawBad) \/ mismatch`——`mismatch` 为真时整个动作恒真，`sawBad'` 变成 unconstrained，TLC 打印 `sawBad = null`，退出码 75 而不是 12。改法：显式括号 `sawBad' = (sawBad \/ mismatch)`。

两条都不是代码的问题，是模型自己的问题。按 S2 的规矩：**复现不出先疑模型，不是先疑代码**——这次正是模型先错。

## 还没覆盖的（下一轮接着做，别当已完成）

1. **4/5 个 tag 不可复算**：只有 `x-timeline` 声明了 `tp/fp/fn`；`jev-friction` 的 `certificate` 只有两个下界、没有计数，无法现算。`--check` 只统计「可复算 tag 数」，零样本不会被当成通过。
2. **三处标签计数并存**：`labels: 531`（全部标注）、`thresholdExtended.n: 487`、`labelDuplicates` 里的唯一 442 —— 三个分母各自成立，但文件里没有一处声明「谁是哪个口径」。优化清单第 ③ 条。
3. **`state_hash` 全缺**：实测 `item-labels-x-timeline-20261119.jsonl` 与 `labels-jev-friction.jsonl` 都是 100% 缺 `state_hash`，当前只能走显式豁免（读层会打印 `LEGACY-NOHASH` 并计数）。优化清单第 ⑦ 条。
4. **原件覆盖事故（2026-11-24）**：复跑 `risk_certificate.py` 默认落盘路径，把 11-19 的证书 md 冲掉，内容不可得，只剩本表的 tp/fp/fn。已把「不覆盖」做成纯函数 `dated_report_path`（T6 守门），但原文件的损失收不回来。
5. **S4 无面**：没有 CI，断言靠人跑一条命令；收口时要挂到能自动跑的地方，否则「守住」只到 L2。
