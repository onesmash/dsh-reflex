---
name: reflex-tuning
description: "调优分层智能体(dsh-reflex)的 L1 判定：shadow 影子记录、历史回放、阈值拟合、判据 A/B、风险证书、校准、唤醒台账与单条目策略。Use when the user asks to tune thresholds, calibrate the local decision model, evaluate rubric changes, 拟合阈值, 校准, 判据 A/B, 影子模式, shadow, 唤醒策略, 或者想知道某个 target 该不该叫醒 L2. 本 skill 自包含：脚本、契约、坑与验证清单都在这里；路径由 REFLEX_HOME / $HOME 推导，不写死绝对路径。"
version: 1.0.0
---

# dsh-reflex 判定调优（shadow → 回放 → 拟合 → 策略）

本 skill 是一套**与数据源/target 无关**的调优机制。它把"L1 该不该叫醒 L2"从拍脑袋变成可回放、可标注、可下证书的闭环。
脚本随插件分发、由插件 `install()` 自动部署到 `~/.agents/skills/reflex-tuning/scripts/`（`sync` 策略：随插件版本更新）。

## 关键路径（全部由环境约定推导）

| 用途 | 路径 |
|---|---|
| 运行目录（用户自己的 collectors/targets/状态） | `$HOME/.dsh/dsh-reflex/`（`REFLEX_HOME`） |
| 本 skill 脚本（唯一来源） | `$HOME/.agents/skills/reflex-tuning/scripts/`（插件注入 `REFLEX_TUNING_DIR`） |
| shadow 打分数据 | `$REFLEX_HOME/shadow/<tag>-<YYYY-MM-DD>.jsonl` |
| 标签 | `$REFLEX_HOME/shadow/labels-<tag>.jsonl`、`wake-labels.jsonl` |
| 阈值映射（tag → 当前阈值） | `$REFLEX_HOME/tools/shadow_targets.json` |
| 报告 | `$REFLEX_HOME/shadow/*.md` |

> 运行目录里**不再放**这些脚本的副本（DATASOURCE.md §0：同一份文件只能有一份）。target 里引用
> `$REFLEX_TUNING_DIR`（缺省 `~/.agents/skills/reflex-tuning/scripts`），插件未注入时也能工作。

## 机制总览（四层，每层可单独用）

1. **影子记录**（`shadow-semif.sh` + `shadow_record.py`）
   透明包在 SemIf 打分外面：真实打分照跑，结束后把**全部条目**的 `p(yes)/state/阈值/是否通过`
   落盘。不改变判定、不改变退出码；记录失败绝不影响判定。target 里只需把 `SEMIF` 指向它。
2. **回放**（`shadow_replay.py`）
   把 facts 目录里的历史事实按生产批次重放进 target，立刻得到"如果当时用这个判据会得多少分"。
   逐条打分与批次无关（实测 12/40 条一批分数一致）。
3. **标注与拟合**（`threshold_fit.py`、`shadow_ab.py`、`risk_certificate.py`、`calibration.py`）
   - 分层抽样导出标注 → 按期望效用拟合：`ΔU(τ)=Σ w[yR−1]`，`R=(真阳价值+漏报代价)/误报代价`
   - 判据 A/B：两套判据跑同一批 facts，按 `state_hash` 对齐比 P/R
   - 风险证书：Clopper-Pearson 精确单侧界（精度下界/误报率上界/召回下界）
   - 校准：Platt/Isotonic + ECE 交叉验证；唤醒概率阈值 = `1/R`
4. **策略与验证**（`wake_policy.py`、`wake_ledger.py`、`replay_wake_eval.py`、`wake_policy_sim.py`）
   - `wake_policy.py`：通用的"单条目暂存/第二条合并/高置信立即发/超时补发"策略，任何 target 可调用
     - 默认：等待窗口 `wait_min=10` 分钟、`immediate=0.97`、`late_min=0.95`
     - 语义：单条 ≥immediate 立即发；<immediate 先暂存等第二条；等满 wait_min 仍无第二条时，
       分数 ≥late_min 单独补发，否则丢弃（`late_min=None` 退回旧的"超时即丢弃"）
     - 2026-10-18 调整原因：0.9785 的高价值单条被 0.98 阈值按 60 分钟规则暂存了 46 分钟才随第二条发出
   - `wake_ledger.py`：从 reflex 日志 + DSH 会话正文还原每次唤醒的投递/用户回应/L2 动作，支持批量标注
   - `replay_wake_eval.py`：把回放通过条目按发布时间聚成"假设唤醒"，做唤醒级（OR 语义）评估
   - `wake_policy_sim.py`：策略仿真（baseline / wait / thresh / combo），输出精度、正例覆盖、每天唤醒量
5. **因果敏感度审计**（`pc_inject.py`，Predictable Change，源自 CausalCoT arXiv:2610.31639）
   回答"分数是因为**对的原因**在动，还是因为无关上下文"——阈值拟合证明"分得开"，本层证明"分得对"。
   对 shadow 采样做四种有明确逻辑预期的算子，原始/扰动各打一次分（本地 SemIf，零 API）：
   - 方向类：`strip_signal` 删内容提分、`swap_irrelevant` 换等长无关文本 → 期望降分（信号敏感度）
   - 不变类：`noise_append` 追加无关噪声、`shuffle_fields` 字段重排 → 期望分数不动（反泄漏）
   产出**判据指纹**：方向类 near≥90%/high≥95%、不变类 near≥85%/high≥95% 为过（mid/low 地板带仅诊断，
   翻转率只作诊断——记录越贴近阈值越易翻）。总判定三态：通过/不通过/无法判定（样本不含决策区间记录）。
   模板自适应：state 含 `正文: ` 走 fielded 四算子；纯标题源（如 ai-policy）走 blob 三算子（shuffle 标 n/a）。
   可复现：`--snapshot-out` 存采样记录，之后 `--from-snapshot` 复跑，报告 `sample_hash` 一致才可逐项对比。

## 命令速查

```bash
S="$HOME/.agents/skills/reflex-tuning/scripts"

# 1) 看分布（无标签也能跑）
python3 "$S/threshold_fit.py" --tag <tag> --mode replay

# 2) 导出样本标注（分层：边界带优先）
python3 "$S/threshold_fit.py" --tag <tag> --mode replay --export-sample 120
#    标注写 $REFLEX_HOME/shadow/labels-<tag>.jsonl: {"idx":1,"label":0|1}

# 3) 拟合阈值（R 越小越怕误报）
python3 "$S/threshold_fit.py" --tag <tag> --mode replay --ratios 1,2,4,8,16

# 4) 判据 A/B（两套判据各自的回放 tag）
python3 "$S/shadow_ab.py" --tag-a <oldTag> --tag-b <newTag> --labels-tag <labelTag> --mode replay

# 5) 风险证书 / 校准
python3 "$S/risk_certificate.py" --tag <tag> --labels-tag <labelTag> --mode replay --operating <τ>
python3 "$S/calibration.py" --tag <tag> --labels-tag <labelTag> --mode replay --operating <τ>

# 6) 唤醒台账（结果标签）
python3 "$S/wake_ledger.py" --export-pending /tmp/pending.jsonl
python3 "$S/wake_ledger.py" --label-batch /tmp/labels-batch.jsonl
python3 "$S/wake_ledger.py" --report "$REFLEX_HOME/shadow/wake-report.md"

# 7) 回放构造唤醒 + 策略仿真
python3 "$S/replay_wake_eval.py" --tag <tag> --export /tmp/wakes.jsonl
python3 "$S/wake_policy_sim.py" --items /tmp/passed-items-labeled.json --days 5

# 8) 因果敏感度审计（判据指纹）
python3 "$S/pc_inject.py" --tag <tag> --days all --sample 100
#    可复现: 首次加 --snapshot-out DIR, 之后 --from-snapshot DIR/pc-snapshot-*.jsonl 复跑
#    纯标题源自动走 blob 模板; 强制: --template auto|fielded|blob; 报告在 $REFLEX_HOME/shadow/pc/

# 9) 端到端探针（改完 target/采集源后验证全链: 采集→判定→唤醒，自动清理）
bash "$S/reflex_e2e_probe.sh" --timeout 300
#    需要运行中的 DSH; 临时建 e2e-probe 源+target 走真实热发现, PASS 打印判定/唤醒日志行
#    只测投递(不测判定)可用插件钩子: touch "$REFLEX_HOME/wake-test" → 下一轮强制 wakeL2
```

## target 侧约定

- 用 `$REFLEX_TUNING_DIR/shadow-semif.sh` 作为 `SEMIF`（影子记录；缺失则自动退回真实打分）。
- decide.py 里应用策略（不要自己写状态机）：
  ```python
  sys.path.insert(0, os.environ["REFLEX_TUNING_DIR"])
  import wake_policy
  d = wake_policy.decide(items, state_file, now_ms,
                         wait_min=60, immediate=0.98, defer=True)
  ```
  `items` 每条需带 `score`；返回的 `items` 已合并暂存条目并去重。
- 阈值映射写进 `$REFLEX_HOME/tools/shadow_targets.json`（`{tag: {threshold, source, replay_tag?}}`），
  拟合/证书工具靠它读"当前阈值"。

## 必须知道的坑（都踩过）

1. **换判据必须重拟合阈值**：判据措辞一改，分数尺度整体漂移（实测中位数 0.63→0.19），旧阈值直接失效。
2. **分数不是概率**：实测原始分 ECE 41%；校准后 0.93 对应真实概率约 50%。要么先校准再用 `p≥1/R`，
   要么用效用网格拟合——两者在 R≥2 时给出一致工作点。
3. **标签是代理标签**：分层抽样标签的区间只对抽样分布成立；要总体证书，用唤醒级自然抽样。
4. **回放构造唤醒 ≠ 线上自然抽样**：它重演"同一判据+历史事实"，用于方向判断，不替代 live 证书。
5. **prompt 判据有边际**：v2.2/guard 模式实测劣于 v2.1（负结果），残余噪音应交给 L2 过滤，不是继续堆措辞。
6. **单条 vs 多条**：单条目唤醒价值显著低于多条（37% vs 100%），故有 `wake_policy`；但窗口/阈值要用
   自己的数据重新拟合，别照抄 60 分钟/0.98。
7. **shadow 记录的 `id` 不是唯一键**（x-timeline 是位置索引，同一推文多轮重复记录）：任何"重打分再对比"
   的工具必须用**采样序号或 state_hash** 做载体键，直接用 id 会让分数互相覆盖（实测 MAE 假象 0.24）。
   自校验：原 state 重打分的 MAE 必须 ≈0 才能拿来比；同时 SemIf 打分器是 create-only，重跑前清旧输出。
8. **state 模板是判据的一部分**：字段顺序变化能翻转近线带 31% 的判定（x-timeline 实测 shuffle 65.4%）。
   改模板 = 改判据，必须重跑 `pc_inject.py` 看指纹不退化。

## 验证清单

- [ ] `shadow_stats` 有数据：`wc -l $REFLEX_HOME/shadow/<tag>-*.jsonl`
- [ ] 回放批次与逐条分数一致（抽 3 条手跑对比）
- [ ] 拟合报告里 `通过量` 与 `P/R` 同时给出，且带固定基线（always-wake / always-suppress / 同量随机）
- [ ] 证书带样本量规划；小样本不下结论
- [ ] target 改动后：`python3 <repo>/tests/shadow-regress.py`（运行时）或 `python3 tests/test-tuning-tools.py`（仓库）
- [ ] target/采集源改动后：`bash "$S/reflex_e2e_probe.sh"` PASS（采集→判定→唤醒全链实测）
- [ ] 策略变更可回滚：单条目策略用 `REFLEX_X_DEFER=0`；判据/阈值改回脚本默认值即热生效

## 限制

- 需要 SemIf（或同构决策后端）打分；纯硬规则 target 只能做唤醒台账，不能做阈值拟合。
- 唤醒级评估依赖 DSH 会话正文（`~/.dsh/sessions/*/<session>/session.v4.jsonl.zstd`）；换目录结构则台账退化。
- 所有统计结论建立在"标签口径不变"上；换标注人或改口径必须重跑。
