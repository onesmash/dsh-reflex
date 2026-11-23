# 数据源开关与新增：性质登记表（S0 产出，S5 收口时再核）

范围：Trigger 页的两件事 —— 开关既有源（P1–P9）、按三段式新增源（P10–P18）。

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

| P10 | FEED 段·生成的采集器：首跑只发一条 `<name>-scan`（`seeded:true`，不发存量）；第二轮只发新增行（原样转发）；第三轮幂等；命令无输出或所有行都不是 JSON 对象时非 0 退出且 stdout 为空 | Chief | `sources.mjs: renderCollector`（生成物） | 单进程 | 不建模（生成物行为，用真跑两轮脚本的行为测试守） | 变体：去重失效 / 首跑把存量也发出去；命令 `node tests/sources-invariants.mjs` | 0 | 部分：`tests/create-source-route.mjs` 在临时 HOME 里真跑两轮 | 守住（生成物行为） | 7ac0ac1 |
| P11 | EVERY 段：`<name>.env.json` 的 `intervalMs` 恒等于界面选的间隔，且带 `timeoutMs`（≥60s，慢源不会被 20s 默认值杀在半路） | Chief | `sources.mjs: renderCollectorEnv` | 单进程 | 不建模（数据形状，由行为测试守） | 变体：间隔写死 900000；命令 `node tests/sources-invariants.mjs` | 0 | — | 守住 | 7ac0ac1 |
| P12 | TRIGGER 段·生成的 target：`<name>-scan` 汇总行永远不算数据（只有 scan 行时 stdout 为空）；`match` 不命中一个字都不输出；`semantic` 只写影子分数不叫醒；`off` 不生成任何 target 文件；命中时 stdout 恰好一行决策且 `fingerprint.ids` 与条目 id 一一对应 | Chief | `sources.mjs: renderTarget / planSourceFiles` | 单进程 | 不建模（生成物行为，由行为测试守） | 变体：scan 行当数据 / 关键词不过滤；命令 `node tests/sources-invariants.mjs` | 0 | 部分：`tests/create-source-route.mjs` 把真实事实喂进 target | 守住 | 7ac0ac1 |
| P13 | 非法输入一个文件都不写：名字不合 `^[a-z0-9][a-z0-9._-]*$`、内置源名、空命令、未知 trigger、match 缺关键词、semantic 缺判据、间隔越界一律拒绝；已存在的源不覆盖（解析层与写盘层各拒一次）；`bash -n` 失败整批回滚（不留 `.tmp`、不留半成品） | Chief | `sources.mjs: parseNewSource / createSource`、`index.js: syntaxGuard` | 单进程 | 不建模（输入校验 + 落盘原子性，由行为测试守） | 变体：名字校验去掉 / 覆盖守卫去掉；命令 `node tests/sources-invariants.mjs` | 0 | 部分：`tests/create-source-route.mjs` 用坏命令与重名各打一次路由 | 守住 | 7ac0ac1 |
| P14 | 试跑摘要：`lines`=非空行数、`valid`=其中能解析成对象的行数、`bad`=差值、`sample`=前三行；空输出时三者为 0 且不算失败 | Chief | `sources.mjs: summarizeProbe` | 单进程 | 不建模（纯函数，由行为测试守） | 变体：把每一行都算成合法；命令 `node tests/sources-invariants.mjs` | 0 | 部分：`tests/create-source-route.mjs` 的 probe 调用 | 守住 | 7ac0ac1 |
| P15 | 三段式表单（FEED/EVERY/TRIGGER）拼出的请求体恒为 `{op:'create', name, about, cmd, intervalMs:Number, trigger}`：name/about/cmd 去首尾空白，关键词按半角/全角逗号、分号、顿号、换行切分，semantic/off 不带多余字段 | Chief | `client.js: newSourceBody` | 单进程、仅 bundle | 不建模（纯函数，由 bundle 冒烟守） | 变体：`op` 写成 `"add"`；命令 `node tests/check-sources-panel.mjs` | 0 | — | 守住（bundle 形状） | 7ac0ac1 |
| P16 | 客户端只挡「还没填完」（名字/命令/match 关键词/semantic 判据），格式合法性交给宿主 —— 不写第二份正则 | Chief | `client.js: formBlocker` | 单进程、仅 bundle | 不建模（纯函数，由 bundle 冒烟守） | 变体：漏掉采集命令这一项；命令 `node tests/check-sources-panel.mjs` | 0 | — | 守住 | 7ac0ac1 |
| P17 | 界面用 `tr()` 取的每个文案 key，在 zh / en / 英文兜底三处词典里都存在（少一处只会让非 zh/en 用户看到 `addProbeRc` 这种字样，静态看不出来） | Chief | `client.js: SourcesPage / NewSourceForm / SRC_FALLBACK` | 单进程、仅 bundle | 不建模（静态完整性，由 bundle 冒烟守） | 变体：英文兜底删掉一条；命令 `node tests/check-sources-panel.mjs` | 0 | — | 守住 | 7ac0ac1 |
| P18 | 三段式表单能被真的渲染：FEED/EVERY/TRIGGER 三段都在、创建/取消在、条件字段跟模式变（match 才有关键词框、semantic 才有判据框）、试跑结果（行数/合法数/退出码/stderr）与创建失败原因都渲染出来 | Chief | `client.js: NewSourceForm` | 单进程、仅 bundle | 不建模（渲染冒烟，走一遍 jsx 树） | 变体：条件字段不再跟模式走；命令 `node tests/check-sources-panel.mjs` | 0 | 未做：未在运行中的 DSH 里点过 | 守住（渲染冒烟） | 7ac0ac1 |

## 未覆盖 / 下一步

- **S4（真实日志）未做**：路由已注册（`dsh-reflex.log` 有 `sources route registered: POST /api/reflex`），
  但面板真正发起请求只能在页面刷新后由浏览器触发。宿主 `/api` 通道先验会话 cookie，命令行探针一律 401
  （不存在的路径同样 401，所以 401 不能当「路由存在」的证据，负对照已作废）。全表最高仍记 L2。
- **新增数据源（P10–P18）的 S4 只到「假宿主 + 真脚本」**：`tests/create-source-route.mjs` 用假
  `connection` 把 `apply()` 挂起来、走真实路由、在临时 HOME 里真跑采集器与 target；但**运行中的 DSH
  里还没有点过** —— 宿主的 `index.js` 是启动时加载的，改完要重载插件（或重启 DSH）才生效。
  页面刷新只会换客户端 bundle：那一刻界面能看到入口，点「创建」会被旧宿主回 `unknown op: create`
  （界面对这句做了替换，提示重启）。这条缺口在 P18 那行也记了。
- **并发写者**：面板与终端同时改同一标记时以文件为准，未做锁，也不打算做（单用户工具）。
- **命名空间**：`api/reflex` 与 ds-bot 的 `api/bot` 同机制；若将来有第二个插件用同名路径，`registerFetchRoute`
  会抛「already registered」——已由该实现自身挡住，不需要我们守。
- **主列页与旧弹层的差异**：弹层锚在侧栏底部、宽度被侧栏挤到 560px，十行源要横向缩，点到别处就消失；
  整页占主列，表格按 960px 上限排版。窄屏（<768px）下表格不折行，靠横向滚动，未做卡片化降级。

## 收口三句话

1. **这条性质是什么**：数据源的开关状态只有一处真相——磁盘上的 `<name>.paused` 文件；面板只是它的视图。
   新增数据源只有一处真相——`collectors/<name>.sh` 存在与否（界面只是把它按三段式拼出来）。
2. **哪条命令能重跑**：`node tests/sources-invariants.mjs`（20 条破坏变体，覆盖 P1–P18）、
   `node tests/check-sources-panel.mjs`（9 条：接线 + 请求体 + 本地校验 + 文案完整性 + 渲染冒烟）、
   `node tests/create-source-route.mjs`（21 条：路由 → 落盘 → 真跑脚本）、`node tests/check-client-bundle.mjs`（9 条），
   从干净 shell（`env -i`）一次跑完即 exit 0。
3. **覆盖到哪个 commit、哪里没覆盖**：见各行的 sync commit；未覆盖的是运行期（S4 日志，要重载宿主插件后在
   页面里点一次）与窄屏下的表格几何。
