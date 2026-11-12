# reflex-tuning 工具脚本

## 核心流程（原有）

| 脚本 | 用途 |
|---|---|
| `shadow-semif.sh` | 影子记录：透明包在打分器外面，落盘全部判定 |
| `shadow_record.py` | 影子记录写入 |
| `shadow_replay.py` | 历史回放 |
| `threshold_fit.py` | 阈值拟合（效用网格）+ 分层抽样导出 |
| `shadow_ab.py` | 判据 A/B |
| `risk_certificate.py` | 风险证书（Clopper-Pearson） |
| `calibration.py` | 校准（Platt/Isotonic + ECE） |
| `pc_inject.py` | 因果敏感度审计（Predictable Change） |
| `wake_*.py` / `replay_wake_eval.py` | 唤醒策略与台账 |
| `reflex_e2e_probe.sh` | 端到端探针 |

## 工程配套（2026-11-12 新增）

这些是为了解决实际跑流程时踩到的摩擦，与具体 target 无关。

| 脚本 | 解决的摩擦 |
|---|---|
| `resolve-scorer.sh` | **打分后端解析**。`pc_inject.py` 默认硬编码 semif-decide 路径，本机走 jev 时直接失败。本脚本三级回退（`$REFLEX_SCORE_CMD` → jev → semif），是后端路径的唯一真相来源。 |
| `scorer-resilient.sh` | **create-only 冲突**。打分器拒绝覆盖已存在输出。upstream 清的是 `X.jsonl.summary.md`，而 jev-score 生成 `X.summary.md`，路径推导不一致 → 清理无效。本脚本把两种命名都清掉。 |
| `jl.py` | **jsonl 读写**。`json.load` 误用于 jsonl 会报 `Extra data: line 2 column 1`；`jl.load()` 容错，还能解析被误写成 JSON 数组的旧文件。 |
| `labels-join-key.py` | **idx 漂移**。`--export-sample` 产出的 `{idx,key,w}` 里 idx 绑定采样顺序，shadow 滚动增长后重导出会整体偏移，标签静默错位。本脚本把 `{idx,label}` 转成 `{key,label}`（key=state_hash，稳定）。 |
| `stamp-targets.py` | **元数据失去口径**。`shadow_targets.json` 的 P/R 若不绑定"用哪份标签、哪版判据"，标签一换数字就无意义。本脚本写入 `labelsHash` / `optionsHash`。 |
| `audit-by-template.py` | **模板混算误导**。shadow 里历史 dict 模板与新三段式模板共存，`shuffle_fields` 只对 fielded 适用。混在一起算总符合率会掩盖真实分布。本脚本分轨报告。 |

### 用法

```bash
S="$HOME/.agents/skills/reflex-tuning/scripts"
T="$REFLEX_HOME"          # 默认 ~/.dsh/dsh-reflex

# 解析打分器（其他工具应调用它，不要自己硬编码）
SCORER="$(bash "$S/resolve-scorer.sh")"

# 幂等跑审计
python3 "$S/pc_inject.py" --tag x-timeline --days all --sample 30 \
  --score-cmd "$S/scorer-resilient.sh" --out /tmp/pc

# 标签从 idx 型转 key 型（防漂移）
python3 "$S/labels-join-key.py" x-timeline

# 拟合后给元数据打 hash
python3 "$S/stamp-targets.py"

# 按模板分轨看审计
python3 "$S/audit-by-template.py" x-timeline all
```

### 环境变量

| 变量 | 用途 |
|---|---|
| `REFLEX_SCORE_CMD` | 直接指定打分命令，最高优先 |
| `REFLEX_JEV_SCORE` | jev 打分器路径 |
| `REFLEX_CREDENTIALS` | 凭据文件（默认 `~/.dsh/.credentials.yaml`） |
| `REFLEX_SCORER_CACHE` | 生成的包装器路径 |
| `JEV_BASE_URL` / `JEV_MODEL` | jev 端点与模型 |

### 已知未闭环

- `threshold_fit.py` 仍只读 `{idx,label}` 格式。用 `labels-join-key.py` 转出的 `{key,label}`
  目前只能存、不能直接喂给拟合。要真正闭环需要上游支持 key 型标签。
