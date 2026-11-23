# 数据源开关：性质登记表（S0 产出，S5 收口时再核）

范围声明：**单进程、单写者**（DSH 宿主内一个插件实例；面板与终端同时改同一文件时，以文件最后状态为准，不做锁）。跨机/多实例同步不在本表范围内。

| 编号 | 性质（一句话，可被反例证伪） | owner | 覆盖的文件/函数 | 范围 | 证据等级 | 破坏变体 / 证据命令 | 退出码 | S4 日志 | 状态 | sync commit |
|---|---|---|---|---|---|---|---|---|---|---|
| P1 | 面板列出的源集合恒等于 `collectors/*.sh` 的集合（与是否有 `.env.json` 无关） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | 带动 `tests/sources-invariants.mjs` 的 P1 变体（枚举改按 `.env.json`）；命令 `node tests/sources-invariants.mjs` | 0 | 未做：插件尚未重载进运行中的 DSH | 守住（单写进程） | 0e5e1ac |
| P2 | 每行的 `paused` 恒等于 `<name>.paused` 文件是否存在（不读内存、不读 manifest） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | P2 变体（`paused` 写死 false）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P3 | 任意次 pause/resume 之后，状态恒等于文件状态（幂等、不抖动） | Chief | `sources.mjs: setPaused` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | P3 变体（恢复时不删标记）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P4 | 对内置源（disk/cpu）发 pause 必被拒，且不产生任何文件 | Chief | `sources.mjs: setPaused` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | P4 变体（去掉内置源守卫）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P5 | 源名不含斜杠、不以上级目录开头、且必须对应已存在的 `.sh`，否则拒绝且不写文件 | Chief | `sources.mjs: setPaused` | 单进程 | 不建模（输入校验，由纯函数守门测试覆盖） | P5 变体（去掉名字与存在性校验）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P6 | 目录里没有 `manifest.json` 时，列表仍覆盖全部源（不依赖发现层） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模（数据形状问题，由纯函数守门测试覆盖） | P6 变体（无 manifest 就返回空）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P7 | `pause` 落 commit(name,true)、`resume` 落 commit(name,false)，未知 op 不写盘 | Chief | `sources.mjs: respondToOp` | 单进程 | 不建模（动作映射，由纯函数守门测试覆盖） | P7 变体（方向写反）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P8 | 客户端把**页面**注册进 `main`（keyed，key=`reflex-sources`）且**入口**（侧栏显示名 `Trigger`、闪电图标）注册进 `sidebar.panellist`，两者 id 相同；请求恒为 `POST api/reflex`、`credentials: same-origin`、body 含 `op` | Chief | `client.js: apply / reflexCall / SRC_PANEL_ID` | 单进程、仅 bundle 形状 | 不建模（接线形状，由假宿主冒烟覆盖） | 反证：把 panellist 的 `id` 改成别的 → CASES[2] 红；把 `label` 改回引用组件内变量 → CASES[2] 红（`tr is not defined`）；把 `credentials` 去掉 → CASES[3] 红；命令 `node tests/check-sources-panel.mjs` | 0 | 未做（需要刷新页面后在 GUI 里点开看） | 守住（bundle 形状） | e83c2ff |
| P9 | 宿主注册的路由恒为 `/api/…` 形状，且与客户端请求地址指向同一端点（只差前导斜杠） | Chief | `sources.mjs: SOURCE_ROUTE`、`client.js: SRC_ROUTE` | 单进程 | 不建模（跨文件一致性，由静态断言覆盖） | P9 变体（客户端地址改成 `api/other`）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（两文件一致） | 0e5e1ac |

## 未覆盖 / 下一步

- **S4（真实日志）未做**：路由已注册（`dsh-reflex.log` 有 `sources route registered: POST /api/reflex`），
  但面板真正发起请求只能在页面刷新后由浏览器触发。宿主 `/api` 通道先验会话 cookie，命令行探针一律 401
  （不存在的路径同样 401，所以 401 不能当「路由存在」的证据，负对照已作废）。全表最高仍记 L2。
- **并发写者**：面板与终端同时改同一标记时以文件为准，未做锁，也不打算做（单用户工具）。
- **命名空间**：`api/reflex` 与 ds-bot 的 `api/bot` 同机制；若将来有第二个插件用同名路径，`registerFetchRoute`
  会抛「already registered」——已由该实现自身挡住，不需要我们守。
- **主列页与旧弹层的差异**：弹层锚在侧栏底部、宽度被侧栏挤到 560px，十行源要横向缩，点到别处就消失；
  整页占主列，表格按 960px 上限排版。窄屏（<768px）下表格不折行，靠横向滚动，未做卡片化降级。

## 收口三句话

1. **这条性质是什么**：数据源的开关状态只有一处真相——磁盘上的 `<name>.paused` 文件；面板只是它的视图。
2. **哪条命令能重跑**：`node tests/sources-invariants.mjs`（8 条破坏变体；P8 的接线由下面那条冒烟单独覆盖）、
   `node tests/check-sources-panel.mjs`（5 条接线断言，含「入口 id == 主列 key」），从干净 shell 一次跑完即 exit 0。
3. **覆盖到哪个 commit、哪里没覆盖**：见各行的 sync commit；未覆盖的是运行期（S4 日志，要刷新页面点开一次）
   与窄屏下的表格几何。
