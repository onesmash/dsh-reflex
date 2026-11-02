# semif-resident —— 常驻 SemIf 打分器

随插件分发（`defaults/` 进 npm 包），插件启动时同步到 `$REFLEX_HOME/runtime/semif-resident/`。

## 为什么

`run_score.sh` 每次调用都要重新付一遍固定成本：

| 环节 | 单次耗时 |
| --- | --- |
| `setup_env.sh` 依赖探测 | ~5.2s |
| 模型加载 | ~2.3s |
| 模型文件 sha256 复核（3.0GB） | ~1.2s |
| 前向（312 tokens） | ~0.6s |
| 结果校验 | ~0.1s |

单次墙钟 ~11.9s，前向只占 5%。常驻后模型只加载一次，热调用 ~0.7s（约 15×）。

## 结构

| 文件 | 职责 |
| --- | --- |
| `serve.sh` | 启动器：跑一次 `setup_env.sh` 解析 venv/repo，然后 exec 常驻进程 |
| `serve.py` | 常驻打分器：Unix socket + 单模型；create-only、临时文件 → 校验器 → 原子改名 |
| `request.py` | 薄客户端：退出码 0 已服务 / 3 不可用 / 1 服务报错 |
| `call.sh` | 给 `shadow-semif.sh` 用：拉起服务并请求；不可用则 exit 3 要求回退直调 |

协议：一行 JSON 请求 `{"input": "/abs/in.jsonl", "output": "/abs/out.jsonl"}`，
一行 JSON 响应 `{"ok": true, "cases": N, ...}`。socket/pid 在 `$REFLEX_HOME/run/`。

## 接入点

`skill/reflex-tuning/scripts/shadow-semif.sh` 是所有脚本 target 打分的必经之路：

```
target → shadow-semif.sh → [常驻 call.sh → serve.py]  ← 命中则跳过直调
                          └→ 失败 → bash run_score.sh（行为与以前完全一致）
         → shadow_record.py（两条路径都记录，影子数据不断）
```

插件内置 target（`disk`）走 `index.js` 的 `semifScoreBatch()`，那里同样先试常驻、失败回退直调。

## 开关与限制

- 关闭常驻：配置 `l1.semifResident: false`（插件注入 `REFLEX_SEMIF_RESIDENT=0`），
  或单次调用给 `REFLEX_SEMIF_RESIDENT=0`；关掉后行为回到直调。
- 只实现 MLX 后端（Apple Silicon）。`REFLEX_SEMIF_BACKEND` 非 `mlx` 时启动器直接退出，
  上层自动回退直调——不会让判定失败。
- 常驻进程常图 ~3.0GB RSS；空闲 `REFLEX_SEMIF_IDLE_SEC`（默认 900s）自退。
  进程被 SIGKILL 留下的死 socket 会被 `call.sh` 识别并重拉。
- 失败一律回退：常驻只负责"更便宜地跑出同样结果"，不影响判定语义。
