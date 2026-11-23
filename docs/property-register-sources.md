# 数据源开关：性质登记表（S0 产出，S5 收口时再核）

范围声明：**单进程、单写者**（DSH 宿主内一个插件实例；面板与终端同时改同一文件时，以文件最后状态为准，不做锁）。跨机/多实例同步不在本表范围内。

| 编号 | 性质（一句话，可被反例证伪） | owner | 覆盖的文件/函数 | 范围 | 证据等级 | 破坏变体 / 证据命令 | 退出码 | S4 日志 | 状态 | sync commit |
|---|---|---|---|---|---|---|---|---|---|---|
| P1 | 面板列出的源集合恒等于 `collectors/*.sh` 的集合（与是否有 `.env.json` 无关） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | 带动 `tests/sources-invariants.mjs` 的 P1 变体（枚举改按 `.env.json`）；命令 `node tests/sources-invariants.mjs` | 0 | 未做：插件尚未重载进运行中的 DSH | 守住（单写进程） | ccd9021 |
| P2 | 每行的 `paused` 恒等于 `<name>.paused` 文件是否存在（不读内存、不读 manifest） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | P2 变体（`paused` 写死 false）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | ccd9021 |
| P3 | 任意次 pause/resume 之后，状态恒等于文件状态（幂等、不抖动） | Chief | `sources.mjs: setPaused` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | P3 变体（恢复时不删标记）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | ccd9021 |
| P4 | 对内置源（disk/cpu）发 pause 必被拒，且不产生任何文件 | Chief | `sources.mjs: setPaused` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | P4 变体（去掉内置源守卫）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | ccd9021 |
| P5 | 源名不含斜杠、不以上级目录开头、且必须对应已存在的 `.sh`，否则拒绝且不写文件 | Chief | `sources.mjs: setPaused` | 单进程 | 不建模（输入校验，由纯函数守门测试覆盖） | P5 变体（去掉名字与存在性校验）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | ccd9021 |
| P6 | 目录里没有 `manifest.json` 时，列表仍覆盖全部源（不依赖发现层） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | P6 变体（无 manifest 就返回空）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | ccd9021 |
| P7 | `pause` 落 commit(name,true)、`resume` 落 commit(name,false)，未知 op 不写盘 | Chief | `sources.mjs: respondToOp` | 单进程 | 不建模（动作映射，由纯函数守门测试覆盖） | P7 变体（方向写反）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | ccd9021 |
| P8 | 客户端把入口注册进 `sidebar.footer.action`，且面板请求恒为 `POST api/reflex`、`credentials: same-origin`、body 含 `op` | Chief | `client.js: apply / reflexCall` | 单进程、仅 bundle 形状 | 不建模（接线形状，由假宿主冒烟覆盖） | 反证：把 `reflexCall` 的 `credentials` 去掉 → `tests/check-sources-panel.mjs` 断言失败；命令 `node tests/check-sources-panel.mjs` | 0 | 未做（需要 DSH 重启后在 GUI 里看） | 守住（bundle 形状） | ccd9021 |

## 未覆盖 / 下一步

- **S4（真实日志）未做**：`api/reflex` 的调用只能等插件以新代码加载后产生日志；当前运行中的 DSH 仍是 npm 安装的 0.5.1 副本（`node_modules/dsh-reflex` 不是软链）。所以全表最高记 L2，不写 L3。
- **并发写者**：面板与终端同时改同一标记时以文件为准，未做锁，也不打算做（单用户工具）。
- **命名空间**：`api/reflex` 与 ds-bot 的 `api/bot` 同机制；若将来有第二个插件用同名路径，`registerFetchRoute` 会抛「already registered」——已由该实现自身挡住，不需要我们守。

## 收口三句话

1. **这条性质是什么**：数据源的开关状态只有一处真相——磁盘上的 `<name>.paused` 文件；面板只是它的视图。
2. **哪条命令能重跑**：`node tests/sources-invariants.mjs`（7 条破坏变体，基座 7 条测试）与 `node tests/check-sources-panel.mjs`（4 条接线断言），从干净 shell 一次跑完即 exit 0。
3. **覆盖到哪个 commit、哪里没覆盖**：`ccd9021`；未覆盖的是运行期（S4 日志）与 390px 窄屏下的弹层几何——都要等 DSH 以新 bundle 重启后在真实界面看。
