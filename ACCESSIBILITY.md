# 无障碍声明 / Accessibility

> 这份文件说明 dsh-reflex 的无障碍目标、**已经验证到哪一步**、以及已知的障碍。
> **它不是 WCAG 合规声明**：本项目没有做过完整的合规审计，也不声称达到任何等级。

[English summary ↓](#english-summary)

## 适用范围

dsh-reflex 是一个 DSH 插件，只有一个图形界面：插进 DSH Web GUI 的 **Trigger 页**（数据源列表 + 「添加数据源」三段式表单）。其余部分是命令行脚本（采集器、target、核对脚本），在终端里跑，没有图形界面。

| 有图形界面 | 没有图形界面 |
|---|---|
| DSH Web GUI 里的 Trigger 页（`client.js`） | 采集器 / target / 宿主路由（`index.js`）/ `tests/` 下的脚本 |

采集脚本的输出是给机器看的 JSON，不是给人读的界面，不在本声明的范围内。

## 已经做了什么

下面每一条都能在仓库里核对，不是意向声明。"机器"列由 `tests/check-sources-panel.mjs` 的 P20 断言守住；"人眼"列只能靠看，列在「已知障碍」里。

| 做法 | 在哪 | 怎么核对 |
|---|---|---|
| 表单控件用原生元素：`input` / `select`，四个触发方式是**原生 `radio`**，只上 `accent-color`，不自绘控件 | `client.js: NewSourceForm` | 机器：断言 4 个原生 `radio`、界面上不出现 `role="radio"` |
| 三段各是可命名的区域：`<section aria-labelledby>` 指向段内标题的 `id` | 同上 | 机器：断言三段都在，且引用指向存在的 id |
| 输入框的提示用 `aria-describedby` 关联，不靠视觉位置 | 同上 | 机器：断言名字/命令/关键词/判据四个输入框都挂了提示，且提示 id 存在 |
| 保存失败由**常驻**的 `role="status"` + `aria-live="polite"` 区播报（idle 时也在，读屏才有地方接话） | 同上 | 机器：断言播报区与 `aria-live` |
| 提交被拦下时把焦点送到缺的那一格（不是弹一个提示了事） | `client.js: submit / formBlocker` | 人眼 + 代码：焦点目标由 `formBlocker` 的返回值决定 |
| 键盘焦点可见：输入框、按钮、触发卡片选中态都有 3px `:focus-visible` 环 | `client.js: SRC_CSS` | 机器：断言 CSS 里有 `:focus-visible`（只验规则在，不验视觉） |
| 触摸目标：按钮桌面 32px，`pointer: coarse` 下 44px | 同上 | 机器：断言 CSS 里有 `pointer:coarse` 下的 `min-height:44px` |
| `prefers-reduced-motion: reduce` 时关掉过渡与动画 | 同上 | 机器：断言规则在 |
| 没有拖拽、悬停、双击才能完成的操作；三段 + 摘要是普通 DOM 顺序 | 同上 | 人眼 |
| 图片有 alt 文本；分层图另有纯文本版 | `README.md` | 读 README |

改这些断言的命令：`node tests/check-sources-panel.mjs`（不启动 DSH，用伪 DOM 走一遍 jsx 树）。

## 已知障碍

按影响排，都是**没做过**，不是"觉得没问题"：

1. **没有屏幕阅读器实测。** VoiceOver（macOS）与 NVDA（Windows）都没跑过。上面的 ARIA 只保证"写进去了"，不保证"读出来是对的"——顺序、播报时机、重复朗读都要真听才知道。
2. **没有自动化审计。** axe-core / Lighthouse 都没接进来，仓库也没有 CI。对比度、可访问名称、ARIA 合法性都没有第三方校验。
3. **对比度只量了两处。** 主按钮文字（品牌填充）与保存失败的错误文字，按宿主 light / dark 两套 token 快照算过，两种主题都 ≥4.5:1（`tests/check-sources-panel.mjs` 的 P21 守着）；其余文字（提示、次要标签）没有逐个量，也没有用 axe / Lighthouse 核。
4. **宿主不归本项目管。** 面板跑在 DSH Web GUI 里，宿主的布局、焦点管理、快捷键、主题切换都在本项目控制之外；宿主改版可能让这里的假设失效。
5. **小屏只在静态渲染里看过。** 1440 / 900 / 390 三个宽度用 headless 渲染核对过，但没在运行中的 DSH 里把窗口缩到 560px 以下试过。
6. **键盘顺序没有逐帧记录。** Tab 顺序就是 DOM 顺序，没做过打乱测试，也没有纯键盘走查的日志。
7. **图片只有 alt，没有长描述。** 分层图例外（README 里有纯文本版），唤醒流程图只有一句 alt。

## 支持的环境

- **验证过**：DSH Web GUI（桌面 app 与 web profile，Chromium 内核）里的 Trigger 页；macOS 终端里的命令行脚本。
- **没验证**：Safari、Firefox、移动浏览器、屏幕阅读器、200% 缩放、强制高对比模式、`prefers-contrast`。

## 贡献者期望

- **优先原生控件。** 新增或改表单控件时用原生元素；一定要自绘时，必须给出键盘路径并写 `@supports` 兜底。
- **改界面文案要三处都加**：zh / en / 英文兜底（P17 断言会拦）。
- **别删掉**：`:focus-visible` 焦点环、`prefers-reduced-motion` 规则、触屏 44px 目标、常驻的 `role="status"` 播报区、三段的 `aria-labelledby` 与输入框的 `aria-describedby`。P20 会拦。
- **不要在交互前报错。** 提交后再报缺哪一项，并把焦点送过去。
- **改完跑这三条**（干净 shell 里都能跑）：
  ```
  node tests/check-sources-panel.mjs    # 含 P20 无障碍底座断言
  node tests/sources-invariants.mjs     # 生成物与开关的破坏变体
  node tests/render-add-source.mjs      # 静态渲染，人眼看 1440 / 900 / 390
  ```

## 报告障碍

到 <https://github.com/onesmash/dsh-reflex/issues> 开 issue，标题以 `accessibility:` 开头，写清：

- 哪个界面、哪一步操作；
- 用了什么辅助技术 / 浏览器 / 系统（含版本）；
- 期望发生什么、实际发生什么；
- 能否稳定重现。

没有私有报告渠道。请不要在 issue 里放个人敏感信息。

## 维护

- 维护者：[@onesmash](https://github.com/onesmash)（仓库所有者）。
- 每次改 Trigger 页界面都复核这份文件；「已知障碍」里消掉的条目直接删，不留在列表里。
- 最近审阅：2026-11-24，对照 dsh-reflex 0.6.0。

## English summary

dsh-reflex has exactly one graphical surface: the Trigger page inside the DSH Web GUI. Everything else is command-line.

**Verified** (asserted by `tests/check-sources-panel.mjs`, case P20): native form controls including four native radios rather than custom widgets; `aria-labelledby` on each of the three sections, pointing at ids that exist; `aria-describedby` on the name, command, keyword and criteria inputs; a persistent `role="status"` + `aria-live="polite"` region for save errors; and three CSS rules (a `:focus-visible` ring, 44px targets under `pointer: coarse`, transitions off under `prefers-reduced-motion`). Focus is moved to the missing field when submission is blocked.

**Not verified**: no screen-reader pass (VoiceOver/NVDA), no automated audit (axe/Lighthouse), contrast measured only for the primary-button text and the save-error message, no logged keyboard-only walkthrough, no testing in Safari, Firefox, mobile browsers, zoomed or high-contrast modes. The panel also inherits whatever the host DSH GUI does.

This is an accessibility statement, **not** a claim of WCAG conformance.
