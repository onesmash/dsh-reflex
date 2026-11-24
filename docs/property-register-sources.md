# 数据源开关与新增：性质登记表（S0 产出，S5 收口时再核）

范围：Trigger 页的六件事 —— 开关既有源（P1–P9）、创建事务与生成物（P10–P14、P19）、一句话建源（P15–P18、P23–P26）、界面无障碍底座（P20）、浅/深主题对比度（P21）、首帧不等网络（P22）。

形态变更（2026-11-25）：专用的「添加数据源」三段式页面已删除，首页只留一个输入框 —— 用户说一句，宿主把原话拼成提示词投给 Chief，由它按 `reflex-datasource` 写采集器并自验。P15–P18、P20 因此按新形态重写；`op:"create"` 仍保留给脚本与测试用。

范围声明：**单进程、单写者**（DSH 宿主内一个插件实例；面板与终端同时改同一文件时，以文件最后状态为准，不做锁）。跨机/多实例同步不在本表范围内。

| 编号 | 性质（一句话，可被反例证伪） | owner | 覆盖的文件/函数 | 范围 | 证据等级 | 破坏变体 / 证据命令 | 退出码 | S4 日志 | 状态 | sync commit |
|---|---|---|---|---|---|---|---|---|---|---|
| P1 | 面板列出的源集合恒等于 `collectors/*.sh` 的集合（与是否有 `.env.json` 无关） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模：数据形状问题，由纯函数守门测试覆盖 | 带动 `tests/sources-invariants.mjs` 的 P1 变体（枚举改按 `.env.json`）；命令 `node tests/sources-invariants.mjs` | 0 | 未做：插件尚未重载进运行中的 DSH | 守住（单写进程） | 0e5e1ac |
| P2 | 每行的 `paused` 恒等于 `<name>.paused` 文件是否存在（不读内存、不读 manifest） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模：数据形状问题，由纯函数守门测试覆盖 | P2 变体（`paused` 写死 false）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P3 | 任意次 pause/resume 之后，状态恒等于文件状态（幂等、不抖动） | Chief | `sources.mjs: setPaused` | 单进程 | 不建模：数据形状问题，由纯函数守门测试覆盖 | P3 变体（恢复时不删标记）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P4 | 对内置源（disk/cpu）发 pause 必被拒，且不产生任何文件 | Chief | `sources.mjs: setPaused` | 单进程 | 不建模：数据形状问题，由纯函数守门测试覆盖 | P4 变体（去掉内置源守卫）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P5 | 源名不含斜杠、不以上级目录开头、且必须对应已存在的 `.sh`，否则拒绝且不写文件 | Chief | `sources.mjs: setPaused` | 单进程 | 不建模：输入校验，由纯函数守门测试覆盖 | P5 变体（去掉名字与存在性校验）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P6 | 目录里没有 `manifest.json` 时，列表仍覆盖全部源（不依赖发现层） | Chief | `sources.mjs: scanSources` | 单进程 | 不建模：数据形状问题，由纯函数守门测试覆盖 | P6 变体（无 manifest 就返回空）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P7 | `pause` 落 commit(name,true)、`resume` 落 commit(name,false)，未知 op 不写盘 | Chief | `sources.mjs: respondToOp` | 单进程 | 不建模：动作映射，由纯函数守门测试覆盖 | P7 变体（方向写反）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（单写进程） | 0e5e1ac |
| P8 | 客户端把**页面**注册进 `main`（keyed，key=`reflex-sources`）且**入口**（侧栏显示名 `Trigger`、闪电图标）注册进 `sidebar.panellist`，两者 id 相同；请求恒为 `POST api/reflex`、`credentials: same-origin`、body 含 `op` | Chief | `client.js: apply / reflexCall / SRC_PANEL_ID` | 单进程、仅 bundle 形状 | 不建模：接线形状，由假宿主冒烟覆盖 | 反证：把 panellist 的 `id` 改成别的 → CASES[2] 红；把 `label` 改回引用组件内变量 → CASES[2] 红（`tr is not defined`）；把 `credentials` 去掉 → CASES[3] 红；命令 `node tests/check-sources-panel.mjs` | 0 | 未做（需要刷新页面后在 GUI 里点开看） | 守住（bundle 形状） | e83c2ff |
| P9 | 宿主注册的路由恒为 `/api/…` 形状，且与客户端请求地址指向同一端点（只差前导斜杠） | Chief | `sources.mjs: SOURCE_ROUTE`、`client.js: SRC_ROUTE` | 单进程 | 不建模：跨文件一致性，由静态断言覆盖 | P9 变体（客户端地址改成 `api/other`）；命令 `node tests/sources-invariants.mjs` | 0 | 未做 | 守住（两文件一致） | 0e5e1ac |
| P10 | FEED 段·生成的采集器：首跑只发一条 `<name>-scan`（`seeded:true`，不发存量）；第二轮只发新增行（原样转发）；第三轮幂等；命令无输出或所有行都不是 JSON 对象时非 0 退出且 stdout 为空 | Chief | `sources.mjs: renderCollector`（生成物） | 单进程 | 不建模：生成物行为，用真跑两轮脚本的行为测试守 | 变体：去重失效 / 首跑把存量也发出去；命令 `node tests/sources-invariants.mjs` | 0 | 部分：`tests/create-source-route.mjs` 在临时 HOME 里真跑两轮 | 守住（生成物行为） | 7ac0ac1 |
| P11 | EVERY 段：`<name>.env.json` 的 `intervalMs` 恒等于界面选的间隔，且带 `timeoutMs`（≥60s，慢源不会被 20s 默认值杀在半路） | Chief | `sources.mjs: renderCollectorEnv` | 单进程 | 不建模：数据形状，由行为测试守 | 变体：间隔写死 900000；命令 `node tests/sources-invariants.mjs` | 0 | — | 守住（单进程） | 7ac0ac1 |
| P12 | TRIGGER 段·生成的 target：`<name>-scan` 汇总行永远不算数据（只有 scan 行时 stdout 为空）；`match` 不命中一个字都不输出；`semantic` 只写影子分数不叫醒；`off` 不生成任何 target 文件；命中时 stdout 恰好一行决策且 `fingerprint.ids` 与条目 id 一一对应 | Chief | `sources.mjs: renderTarget / planSourceFiles` | 单进程 | 不建模：生成物行为，由行为测试守 | 变体：scan 行当数据 / 关键词不过滤；命令 `node tests/sources-invariants.mjs` | 0 | 部分：`tests/create-source-route.mjs` 把真实事实喂进 target | 守住（单进程） | 7ac0ac1 |
| P13 | 非法输入一个文件都不写：名字不合 `^[a-z0-9][a-z0-9._-]*$`、内置源名、空命令、未知 trigger、match 缺关键词、semantic 缺判据、间隔越界一律拒绝；已存在的源不覆盖（解析层与写盘层各拒一次）；`bash -n` 失败整批回滚（不留 `.tmp`、不留半成品） | Chief | `sources.mjs: parseNewSource / createSource`、`index.js: syntaxGuard` | 单进程 | 不建模：输入校验 + 落盘原子性，由行为测试守 | 变体：名字校验去掉 / 覆盖守卫去掉；命令 `node tests/sources-invariants.mjs` | 0 | 部分：`tests/create-source-route.mjs` 用坏命令与重名各打一次路由 | 守住（单进程） | 7ac0ac1 |
| P14 | 试跑摘要：`lines`=非空的个数、`valid`=其中能解析成对象的个数、`bad`=差值、`sample`=前三行；空输出时三者为 0 且不算失败 | Chief | `sources.mjs: summarizeProbe` | 单进程 | 不建模：纯函数，由行为测试守 | 变体：把每一行都算成合法；命令 `node tests/sources-invariants.mjs` | 0 | 部分：`tests/create-source-route.mjs` 的 probe 调用 | 守住（单进程） | 7ac0ac1 |
| P15 | 一句话建源拼出的请求体恒为 `{op:'delegate', sentence}`：sentence 去首尾空白，除 `op` 与 `sentence` 不带任何字段（界面不再发 create，也不再拼 name/cmd/trigger） | Chief | `client.js: delegateBody` | 单进程、仅 bundle | 不建模：纯函数，由渲染冒烟守 | 变体：把 op 写成 `add` → P15 红；命令 `node tests/check-sources-panel.mjs` | 0 | 未做：插件尚未重载进运行中的 DSH | 守住（渲染冒烟 + 破坏变体） | 待回填 |
| P16 | 客户端只挡「还没写」（空串/全空白）与「超长（>500 字）」，其余合法性交给宿主；且**本地上限必须等于宿主 `NEW_SOURCE_LIMITS.sentenceMax`** —— 两边各写一个数、改一边忘另一边，会让用户看到「本地让发、宿主报太长」 | Chief | `client.js: sentenceBlocker` / `sources.mjs: NEW_SOURCE_LIMITS` | 单进程、仅 bundle | 不建模：纯函数 + 跨文件常量一致性，由渲染冒烟守 | 变体：本地不再拦空句子 → P16 红；只把宿主上限改成 700 → P16 报「不是同一个数」；命令 `node tests/check-sources-panel.mjs` | 0 | 未做 | 守住（渲染冒烟 + 破坏变体） | 待回填 |
| P17 | 界面用 `tr()` 取的每个文案 key，在 zh / en / 英文兜底三处词典里都存在（少一处只会让非 zh/en 用户看到 `addAskSend` 这种字样，静态看不出来） | Chief | `client.js: SourcesPage / SRC_FALLBACK` | 单进程、仅 bundle | 不建模：文案表按 key 比对 | 变体：英文兜底少一条 → P17 红；命令 `node tests/check-sources-panel.mjs` | 0 | 未做 | 守住（词典交叉比对） | 待回填 |
| P18 | 首页首屏（列表还在 loading 时）就有一句话输入框与发送按钮；添加页、三段式表单、四种触发方式卡片**已从源码里删干净**（删干净比少写更常出错）；输入框是原生 `input` 且有 placeholder，按钮是原生 `button` 且文案非空 | Chief | `client.js: SourcesPage` | 单进程、仅 bundle | 不建模：渲染冒烟走一遍 jsx 树 + 源码残留扫描 | 变体：把输入框 id 改成 `rfx-nope` → P18 红；命令 `node tests/check-sources-panel.mjs` | 0 | 未做：未在运行中的 DSH 里点过 | 守住（渲染冒烟 + 结构断言） | 待回填 |
| P19 | 创建事务的崩溃原子性：`collectors/<name>.sh` 是唯一提交点（**最后**落盘）—— 任意时刻进程被杀，都不会留下「采集器在盘、判定脚本不在」的源 | Chief | `sources.mjs: planSourceFiles / createSource` | 单进程 | L2 | 模型 `docs/verification/create-source/`（现顺序 Atomic breaks、修法顺序守住）；变体：把提交点挪回最前 → P19 报红；命令 `bash docs/verification/create-source/check.sh`、`node tests/sources-invariants.mjs` | 0 | 部分：P19 用真 `SIGKILL` 子进程重放崩溃 | 守住（模型 + 崩溃重放） | 2f49ffd |
| P20 | 无障碍底座（一句话形态）：输入框是原生 `input` 且 `aria-describedby` 指向真实存在的提示 id；投递结果有一个**常驻**的 `role="status"` + `aria-live="polite"` 播报区（idle 时也在）；发送按钮是原生 `button`；树里所有 `aria-labelledby/aria-describedby` 都指向存在的 id；CSS 三条（`:focus-visible`、`prefers-reduced-motion`、触屏 44px）都在 | Chief | `client.js: SourcesPage / SRC_CSS` | 单进程、仅 bundle | 不建模：结构断言（属性写进去了、引用指向存在的 id），不验读屏实际播报 | 变体：播报区去掉 `aria-live` → P20 红；命令 `node tests/check-sources-panel.mjs` | 0 | 未做 | 守住（结构断言 + 破坏变体） | 待回填 |
| P21 | Trigger 页在浅色与深色主题下都读得清：**品牌填充上的文字恒用宿主反向色** `label-primary-inverted`，不写死 `#fff`——dark 下 `brand-primary=#f9fafb`，白字对比度只有 **1.03:1**（隐形）；**错误文字**用「基色 `#e5484d` 62% + 当前主题主文字色 38%」的 `color-mix`，由 `--rfx-err` 承载，两种主题都 ≥4.5:1 | Chief | `client.js: SRC_CSS --rfx-on-brand / --rfx-err / .rfx-btnPrimary / .rfx-saveMsg` | 单进程、仅 bundle | 不建模：静态契约 + 对比度算例，由渲染冒烟守（对比度按宿主 token 快照算，不是观感） | 变体：主按钮 `color` 改回 `#fff` → CASES[10] 红；`--rfx-on-brand` 指向 `#fff` → 红；`.rfx-saveMsg` 退回写死红 → 红（token 定义了没人用）；`--rfx-err` 比例改 100% → 红（浅色 3.91:1）；命令 `node tests/check-sources-panel.mjs`；视觉另跑 `node tests/render-sources-page.mjs`（`dark.html`，token 快照见 `HOST_THEME`） | 0 | 未做：未在真实 DSH 的 dark 主题里逐项核对（快照取自 app.asar 2026-11-24） | 守住（结构断言 + 对比度算例） | d9dcc03 |
| P23 | 一句话被拼成提示词时原句**原样**保留（改写等于替用户改需求），且带 `[建源请求]` 标记与四条硬约束：加载 `reflex-datasource`、`collectors/<name>.sh` 最后落盘、避开 semantic（只记账不叫醒）、双跑验幂等 | Chief | `sources.mjs: buildDelegatePrompt` | 单进程 | 不建模：纯函数 | 变体：提示词不再要求加载 skill → P23 红；命令 `node --test sources.test.mjs` | 0 | 未做 | 守住（纯函数 + 破坏变体） | 待回填 |
| P24 | 一句话的长度边界：空串/全空白被拒；500 字放行、501 字报「太长」（上限与宿主 `sentenceMax` 同一个数） | Chief | `sources.mjs: buildDelegatePrompt / NEW_SOURCE_LIMITS` | 单进程 | 不建模：纯函数 | 变体：上限改 700 → P24 红；命令 `node --test sources.test.mjs` | 0 | 未做 | 守住（纯函数 + 破坏变体） | 待回填 |
| P25 | `delegate` 只负责接线：请求体原样交给注入的 `io.delegate`；宿主没接线时**拒绝**而不是回 `ok:true`（否则界面以为交出去了） | Chief | `sources.mjs: respondToOp` | 单进程 | 不建模：纯逻辑 + 注入 IO | 变体：未接线时假装成功 → P25 红；命令 `node --test sources.test.mjs` | 0 | 未做 | 守住（纯函数 + 破坏变体） | 待回填 |
| P26 | 一句话端到端投递契约：原话经 `wakeL2` 投给 `l1.targetBot`，消息 `role=user`、`source.role=post`、`source.kind=bot`、`senderSessionId` 非空（缺一个正文就不显示、还会吞掉回复）；投不出去回 400 且一个字不写盘；空/超长 400 且不投递 | Chief | `index.js: delegateCreate` / `sources.mjs: respondToOp` | 单进程、假宿主 | 不建模：接线与消息形状，由端到端测试守 | 变体：`source.role` 写成 `request` → P26 红；命令 `node tests/delegate-route.mjs` | 0 | 未做：未在运行中的 DSH 里点过 | 守住（端到端 + 破坏变体） | 待回填 |

## S0：哪些性质建模、哪些不建模（决策留痕）

只有 **P19** 进 TLA+ 建模。判据是这条技能给的 S0 口径「坏了最贵 × 测试最摸不到」：

- P19 坏了最贵：半成品源会静默采集、永远不叫醒，而且同名再也建不了（重名守卫会拒），界面上看不出为什么；
- P19 测试摸不到：`createSource` 的 `try/catch` 回滚只挡「抛异常」，**进程被杀跑不到 catch**。

其余 18 条不建模，替代证据写在各行的「证据等级 / 破坏变体」列里：

- P1–P14：数据形状、输入校验、生成物行为 → 纯函数测试 + 真跑生成脚本的行为测试；
- P15–P18、P20–P21：客户端 bundle 形状、渲染、无障碍底座与主题对比度 → bundle 冒烟 + 渲染冒烟（伪 DOM 走一遍 jsx 树）+ 对比度算例；
- **并发同名创建不建模**：`createSource` 全是同步 fs 调用，同一事件循环里没有 `await` 交错点，
  两个请求不可能同时停在存在性检查与 rename 之间。理由同时写进模型的「不管的部分」。

> 这条决策本身要能被核对：只写「不建模」而不写理由，事后没人能判断当时是真不需要，还是漏了。
> 2026-11-23 的教训就是漏在这里 —— 18 条全写「不建模」，而 P19 恰好是唯一该建模的那条。

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
2. **哪条命令能重跑**：`bash docs/verification/create-source/check.sh`（P19 的 TLC 模型：0/1/2 三态）、
   `node tests/sources-invariants.mjs`（21 条破坏变体，覆盖 P1–P19）、
   `node tests/check-sources-panel.mjs`（11 条：接线 + 请求体 + 本地校验 + 文案完整性 + 渲染冒烟 + 无障碍底座 + 主题对比度）、
   `node tests/create-source-route.mjs`（21 条：路由 → 落盘 → 真跑脚本）、
   `node --test tests/create-source.test.mjs`（16 条，含 P19 崩溃重放）、`node tests/check-client-bundle.mjs`（9 条），
   从干净 shell（`env -i`）一次跑完即 exit 0。
3. **覆盖到哪个 commit、哪里没覆盖**：见各行的 sync commit；未覆盖的是运行期（S4 日志，要重载宿主插件后在
   页面里点一次）与窄屏下的表格几何。
