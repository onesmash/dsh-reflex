window.__ModuleLoader__.load({
	id: "dsh-reflex",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region locales
		const NS = "dshReflex.config";

		const zh = {
			title: "分层智能体",
			description: "选择 L1 语义判定用哪个后端，以及托管 Jev 的端点和模型。",
			backend: "决策后端",
			backendHint: "留空=semif（本地模型，不联网）｜jev=TypeSafe 托管（内容会离开本机）｜jevlocal=本地同款端点",
			jevBaseUrl: "Jev 端点",
			jevBaseUrlHint: "TypeSafe: https://api.typesafe.ai ｜ OpenRouter: https://openrouter.ai/api ｜ Vercel: https://ai-gateway.vercel.sh/typesafe/v1 ｜ 本地: http://127.0.0.1:30001",
			jevModel: "Jev 模型",
			jevModelHint: "TypeSafe/local: jev-latest ｜ OpenRouter: typesafe/jev-1.13 ｜ Vercel: typesafe-ai/jev。生产环境请钉住具体版本。",
			apiKey: "Jev API key",
			apiKeyHint: "存进 DSH 的凭据存储(只有上行写入, 没有读回路径)。插件从凭据文件的 refs 段按 JEV_API_KEY 读取。",
			apiKeySet: "已设置",
			apiKeyUnset: "未设置",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "插件未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "保存失败，已保留你的输入。",
			saveError: "保存被拒绝的原因：",
			diagNotLanded: "保存未生效 —— 改动没有被接受。",
			diagErrorPrefix: "保存出错：",
			// —— 数据源页面（主列整页） ——
			srcNav: "Trigger",
			srcTitle: "Trigger",
			srcDesc: "采集源就是 L1 的触发来源。这里开关每一路采集：暂停写的是磁盘上的 <name>.paused 标记，采集器下一轮读到，不用改 profile，也不用重启。",
			srcRefresh: "刷新",
			srcLoading: "读取中…",
			srcSummary: "{n} 个采集中 · {m} 个已暂停",
			srcColName: "名称",
			srcColEvery: "间隔",
			srcColToday: "今日",
			srcColLast: "最近成功",
			srcColState: "状态",
			srcColAction: "操作",
			srcPause: "暂停采集",
			srcResume: "恢复采集",
			srcWorking: "处理中…",
			srcStateOn: "采集中",
			srcStateIdle: "无数据",
			srcStatePaused: "已暂停",
			srcStateFailed: "失败",
			srcBuiltinTitle: "内置源",
			srcBuiltinHint: "由 profile 的 l0.sources 控制，改后需重载 DSH。",
			srcBuiltinAct: "profile 控制",
			srcEmpty: "collectors 目录还没有脚本：把 <name>.sh 放进去即启用。",
			srcLoadFail: "读取失败",
			srcRetry: "重试",
			srcFollowing: "跟随全局"
		};

		const en = {
			title: "Layered Agent",
			description: "Which backend scores L1 decisions, and the hosted Jev endpoint and model.",
			backend: "Decision backend",
			backendHint: "Blank = semif (local model, no network) | jev = TypeSafe hosted (content leaves this machine) | jevlocal = same wire format on a local endpoint",
			jevBaseUrl: "Jev endpoint",
			jevBaseUrlHint: "TypeSafe: https://api.typesafe.ai | OpenRouter: https://openrouter.ai/api | Vercel: https://ai-gateway.vercel.sh/typesafe/v1 | local: http://127.0.0.1:30001",
			jevModel: "Jev model",
			jevModelHint: "TypeSafe/local: jev-latest | OpenRouter: typesafe/jev-1.13 | Vercel: typesafe-ai/jev. Pin a version in production.",
			apiKey: "Jev API key",
			apiKeyHint: "Stored in DSH's credential store (write-only: no read path returns it). The plugin reads it from the credentials file's refs section under JEV_API_KEY.",
			apiKeySet: "Set",
			apiKeyUnset: "Not set",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			saveError: "Why the save was refused:",
			diagNotLanded: "Save did not take effect — the change was not accepted.",
			diagErrorPrefix: "Save failed: ",
			// —— sources page (global main panel) ——
			srcNav: "Trigger",
			srcTitle: "Trigger",
			srcDesc: "Collectors are what trigger L1. Each switch writes <name>.paused on disk, which the collector reads on its next round — no profile edit, no restart.",
			srcRefresh: "Refresh",
			srcLoading: "Loading…",
			srcSummary: "{n} collecting · {m} paused",
			srcColName: "Name",
			srcColEvery: "Every",
			srcColToday: "Today",
			srcColLast: "Last success",
			srcColState: "State",
			srcColAction: "Action",
			srcPause: "Pause",
			srcResume: "Resume",
			srcWorking: "Working…",
			srcStateOn: "Collecting",
			srcStateIdle: "No data",
			srcStatePaused: "Paused",
			srcStateFailed: "Failed",
			srcBuiltinTitle: "Built-in sources",
			srcBuiltinHint: "Controlled by the profile's l0.sources; reload DSH after changing them.",
			srcBuiltinAct: "Profile-controlled",
			srcEmpty: "No scripts in collectors yet — drop a <name>.sh there to enable one.",
			srcLoadFail: "Read failed",
			srcRetry: "Retry",
			srcFollowing: "Follows global"
		};

		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		//#endregion

		//#region card
		/** 密钥在宿主凭据域里的引用名。插件读的是凭据文件 refs 段的同名键。 */
		const API_KEY_REF = "JEV_API_KEY";
		/** 只写控件在表单里暂存用的字段名。 */
		const API_KEY_FIELD = "apiKey";

		/**
		 * 桥接本插件配置命名空间的表单到插件页的暂存表单。
		 *
		 * 字段名必须与宿主 Config schema 里声明的键一致（decide.backend 等）——
		 * schema 是"这段配置能被面板服务"的前提，这里只是把它渲染出来。
		 *
		 * 密钥走另一条路：它**不在 Config schema 里**，而是通过凭据域写入
		 * （`credentials.set` 单向上行，没有任何读回路径）。插件侧从凭据文件的
		 * refs 段按同名键读取，两边对得上。
		 */
		var CardController = class {
			constructor(scope, ctx) {
				this.ctx = ctx;
				// 诊断文案必须跟随界面语言 —— 原来这两句是中文硬编码,
				// 英文界面下会中英混排。
				this.t = (ctx && ctx.locale && typeof ctx.locale.bind === "function")
					? ctx.locale.bind(NS)
					: (key) => key;
				this.credential = { ref: "", configured: false, writable: true };
				this.form = new ui.SettingsFormModel(scope, [
					// ⚠️ 字段名就是【配置根下的路径】, 必须与宿主 Config schema 的顶层键一致。
					//    嵌套(decide.backend)会让表单写出 path:["backend"] 而校验失败。
					ui.settingsTextField("backend"),
					ui.settingsTextField("jevBaseUrl"),
					ui.settingsTextField("jevModel")
				], [{ field: API_KEY_FIELD, write: (text) => this.writeKey(text) }]);
				// 把 scope.mutate 包起来记录真实失败原因。
				// 为什么: 上游 save() 里 `catch (_error) { this.failed = true }` 把异常丢了,
				// 而且 `if (!landed) { this.failed = true; return }` 连异常都没有 ——
				// 两种失败在界面上是同一句话, desktop 版又没有开发者工具可查。
				this.diag = "";
				const inner = scope.mutate.bind(scope);
				const self = this;
				scope.mutate = async function (ops, revision) {
					try {
						const ok = await inner(ops, revision);
						if (!ok) {
							// 只说人话 —— 原来把 writable/revision/ops 的原始 JSON 也摊在
							// 界面上, 用户看不懂, 而真正的原因早已被上游吞掉(见上面的注释)。
							self.diag = self.t("diagNotLanded");
						}
						return ok;
					} catch (error) {
						self.diag = self.t("diagErrorPrefix")
							+ (error && error.message ? error.message : String(error));
						throw error;
					}
				};
				this.store = this.form.bind(() => this.projection());
				this.unsubscribe = scope.subscribe(() => { this.readCredential(); });
				this.readCredential();
			}
			projection() {
				return {
					...this.form.shell(),
					backend: this.form.field("backend"),
					jevBaseUrl: this.form.field("jevBaseUrl"),
					jevModel: this.form.field("jevModel"),
					apiKey: this.form.field(API_KEY_FIELD),
					apiKeyConfigured: this.credential.configured,
					apiKeyWritable: this.credential.writable,
					scopeWritable: this.form.shell().writable,
					diag: this.diag
				};
			}
			/** 问凭据域：这个引用现在配了没有、能不能写。回复只带状态，不带值。 */
			async readCredential() {
				const ref = API_KEY_REF;
				const response = await this.ctx.remote.credentials.describe([ref]);
				if (!response || !response.ok) return;
				const view = response.value ? response.value[ref] : undefined;
				const next = {
					ref,
					configured: view ? view.configured === true : false,
					writable: view ? view.writable !== false : true
				};
				if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
				this.credential = next;
				this.store.set(this.projection());
			}
			/** 写入暂存的密钥，再回读"宿主是否已持有"。 */
			async writeKey(value) {
				await this.ctx.remote.credentials.set(API_KEY_REF, value);
				await this.readCredential();
				return this.credential.configured;
			}
			/** 页面 slot 注入的那一面：快照 + 表单动作。 */
			inject() {
				return { hooks: { card: this.store }, ...this.form.actions() };
			}
			dispose() {
				this.unsubscribe();
				this.form.dispose();
			}
		};

		/**
		 * 配置卡片。
		 * `view` 由插件页决定：'summary' 画一行摘要（组合包卡片用），否则画表单。
		 */
		function Card(props) {
			const { t } = props;
			const state = props.useCard((snapshot) => snapshot);
			// 保存失败时把【真实原因】显出来。
			// 为什么需要: 上游 SettingsFormModel 的 save() 是
			//   try { ... } catch (_error) { this.failed = true }
			// —— 异常被丢弃, 只留一个布尔, 界面只显示一句笼统的"保存失败"。
			// 在 desktop 版里没有开发者工具可以看, 于是失败原因完全不可达。
			// 这里包一层把 message 抓出来渲染, 否则只能靠猜。
			const [saveError, setSaveError] = react.useState("");
			const save = async () => {
				setSaveError("");
				try {
					await props.save();
				} catch (error) {
					setSaveError(error && error.message ? error.message : String(error));
				}
			};
			if (props.view === "summary") return t("description");
			const disabled = !state.writable;
			// 只在【真有问题】时显示诊断: 不可写(保存按钮会静默失效), 或 mutate 报错。
			// 原来无条件显示 "writable=... | scopeWritable=..." —— 那是排查期的残留:
			// 正常用户看到一行红色技术文字只是噪音, 而且它硬编码英文、不跟随界面语言。
			const diagBits = [];
			if (!state.writable) diagBits.push(t("readOnly"));
			if (state.diag) diagBits.push(state.diag);
			const diagLine = diagBits.length
				? (0, react_jsx_runtime.jsx)("p", {
					style: { color: "#c0392b", whiteSpace: "pre-wrap", fontSize: "12px" },
					children: diagBits.join("\n")
				})
				: null;
			const text = (id, key, label, hint) =>
				(0, react_jsx_runtime.jsx)(ui.SettingsValueField, {
					id,
					label,
					hint,
					overriddenLabel: t("overridden"),
					resetLabel: t("reset"),
					disabled,
					...state[key],
					onEdit: (v) => props.edit(key, v),
					onReset: () => props.resetField(key)
				});
			return (0, react_jsx_runtime.jsxs)(ui.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: save,
				onDiscard: props.discard,
				children: [
					text("layered-decide-backend", "backend", t("backend"), t("backendHint")),
					text("layered-decide-baseurl", "jevBaseUrl", t("jevBaseUrl"), t("jevBaseUrlHint")),
					text("layered-decide-model", "jevModel", t("jevModel"), t("jevModelHint")),
					(0, react_jsx_runtime.jsx)(ui.SettingsSecretField, {
						id: "layered-decide-apikey",
						label: t("apiKey"),
						hint: t("apiKeyHint"),
						disabled: !state.apiKeyWritable,
						text: state.apiKey ? state.apiKey.text : "",
						configured: state.apiKeyConfigured,
						stateLabel: state.apiKeyConfigured ? t("apiKeySet") : t("apiKeyUnset"),
						onEdit: (v) => props.edit(API_KEY_FIELD, v)
					}),
					saveError
						? (0, react_jsx_runtime.jsx)("p", { style: { color: "#c0392b", whiteSpace: "pre-wrap" },
							children: t("saveError") + "\n" + saveError })
						: null,
					diagLine
				]
			});
		}
		//#endregion

		//#region sources page
		/**
		 * 数据源页面：侧栏一行入口 + 主列整页。
		 *
		 * 为什么是整页而不是弹层：弹层锚在侧栏底部，宽度被侧栏挤到 560px，十行源要横向缩，
		 * 点到别处还会消失。宿主有 root 级 keyed `main` 槽（Plugins 页同款）：侧栏入口点一下
		 * 由侧栏自己调 `selectPanel(id)`，主列换成这一页；入口 id 与 main 的 key 必须相同，
		 * 否则点了没反应 —— 由 tests/check-sources-panel.mjs 守这条。
		 */
		const SRC_ROUTE = "api/reflex";
		const SRC_PANEL_ID = "reflex-sources";
		/** 一次面板请求。统一成 {ok:true,...} 或抛错，调用方只处理一种失败形态。 */
		async function reflexCall(op, extra) {
			const res = await fetch(SRC_ROUTE, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op, ...(extra || {}) })
			});
			let body = null;
			try { body = await res.json(); } catch (e) { /* 非 JSON = 宿主没挂上路由 */ }
			if (!res.ok || !body || body.ok !== true) {
				const why = body && body.error ? body.error : "HTTP " + res.status;
				throw new Error(why);
			}
			return body;
		}
		function everyLabel(ms, t) {
			if (!Number.isFinite(ms) || ms <= 0) return t("srcFollowing");
			if (ms % 3600000 === 0) return ms / 3600000 + " h";
			if (ms % 60000 === 0) return ms / 60000 + " min";
			return Math.round(ms / 1000) + " s";
		}
		function clockLabel(ts) {
			if (!Number.isFinite(ts) || ts <= 0) return "—";
			const d = new Date(ts);
			const hh = String(d.getHours()).padStart(2, "0");
			const mm = String(d.getMinutes()).padStart(2, "0");
			return hh + ":" + mm;
		}
		/** 状态四态：只有失败用红；暂停是用户的选择，保持中性。 */
		function stateOf(row, t) {
			if (row.paused) return { text: t("srcStatePaused"), color: "var(--dsw-alias-label-secondary,#9ca3af)" };
			if (row.failed) return { text: t("srcStateFailed"), color: "#c0392b" };
			if (!row.factsToday) return { text: t("srcStateIdle"), color: "var(--dsw-alias-label-secondary,#9ca3af)" };
			return { text: t("srcStateOn"), color: "#2f855a" };
		}
		/** 侧栏图标：闪电 —— trigger 的通用符号（Zapier 那类自动化工具里 trigger 就是它）。 */
		function TriggerIcon(props) {
			const size = props && props.size ? props.size : 16;
			return react_jsx_runtime.jsx("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", focusable: "false",
				children: react_jsx_runtime.jsx("path", {
					d: "M9.1 1.9 3.9 8.6h3.3l-.5 5.5 5.4-6.9H8.6z",
					stroke: "currentColor", strokeWidth: "1.3", strokeLinejoin: "round"
				}, "b")
			});
		}
		/**
		 * 词典缺失时的英文兜底。
		 * DSH 支持的语言比本插件登记的多（这里只有 zh/en）；若直接取 key，
		 * 切到日语/法语时页面会显示 "srcTitle" 这种字样 —— 宁可回退英文。
		 */
		const SRC_FALLBACK = {
			srcNav: "Trigger", srcTitle: "Trigger",
			srcDesc: "Collectors are what trigger L1. Each switch writes <name>.paused on disk, which the collector reads on its next round — no profile edit, no restart.",
			srcRefresh: "Refresh", srcLoading: "Loading…", srcSummary: "{n} collecting · {m} paused",
			srcColName: "Name", srcColEvery: "Every", srcColToday: "Today", srcColLast: "Last success",
			srcColState: "State", srcColAction: "Action",
			srcPause: "Pause", srcResume: "Resume", srcWorking: "Working…",
			srcStateOn: "Collecting", srcStateIdle: "No data", srcStatePaused: "Paused", srcStateFailed: "Failed",
			srcBuiltinTitle: "Built-in sources",
			srcBuiltinHint: "Controlled by the profile's l0.sources; reload DSH after changing them.",
			srcBuiltinAct: "Profile-controlled",
			srcEmpty: "No scripts in collectors yet — drop a <name>.sh there to enable one.",
			srcLoadFail: "Read failed", srcRetry: "Retry", srcFollowing: "Follows global"
		};
		/** 取一条文案：当前语言没有就回退英文，再没有才回 key。 */
		function srcText(t, key) {
			const value = typeof t === "function" ? t(key) : key;
			return !value || value === key ? (SRC_FALLBACK[key] || key) : value;
		}
		/** 页面样式。作为 <style> 元素渲染在组件里，卸载即移除，不写 document.head。 */
		const SRC_CSS = [
			".rfx-page{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;box-sizing:border-box;padding:0 clamp(24px,4vw,48px);color:var(--dsw-alias-label-primary,#111)}",
			".rfx-inner{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;max-width:960px;margin:0 auto}",
			".rfx-head{flex:none;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:calc(var(--dsh-frame-top-clearance,48px) + 4px) 0 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)}",
			".rfx-title{margin:0;font-size:18px;font-weight:600;line-height:1.3}",
			".rfx-desc{margin:5px 0 0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b7280)}",
			".rfx-body{flex:1;min-height:0;overflow:auto;padding:0 0 40px}",
			".rfx-bar{display:flex;align-items:center;gap:10px;padding:12px 0 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}",
			".rfx-table{width:100%;border-collapse:collapse;font-size:13px}",
			".rfx-th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e5e5);white-space:nowrap}",
			".rfx-td{padding:11px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#f0f0f0);vertical-align:middle}",
			".rfx-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}",
			".rfx-muted{color:var(--dsw-alias-label-secondary,#9ca3af)}",
			".rfx-num{font-variant-numeric:tabular-nums}",
			".rfx-dot{display:inline-block;width:7px;height:7px;border-radius:999px;margin-right:6px;vertical-align:1px}",
			".rfx-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:transparent;color:inherit;border-radius:var(--dsw-radius-sm,8px);padding:4px 12px;min-height:28px;font:inherit;font-size:12px;cursor:pointer}",
			".rfx-btn:disabled{opacity:.5;cursor:default}",
			".rfx-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}",
			".rfx-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0;padding:10px 12px;border-radius:var(--dsw-radius-md,10px);border:1px solid rgba(192,57,43,.35);background:rgba(192,57,43,.06);color:#c0392b;font-size:13px}",
			".rfx-sec{margin-top:30px}",
			".rfx-secTitle{margin:0;font-size:13px;font-weight:600}",
			".rfx-secHint{margin:3px 0 4px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}"
		].join("\n");
		function SourcesPage(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const tr = (k) => srcText(t, k);
			const [view, setView] = react.useState({ phase: "loading", data: null, error: "" });
			const [busy, setBusy] = react.useState("");
			const load = react.useCallback(async () => {
				setView((prev) => ({ phase: prev.data ? "ready" : "loading", data: prev.data, error: "" }));
				try {
					setView({ phase: "ready", data: await reflexCall("list"), error: "" });
				} catch (e) {
					setView({ phase: "error", data: null, error: e && e.message ? e.message : String(e) });
				}
			}, []);
			react.useEffect(() => { void load(); }, [load]);
			const toggle = async (row) => {
				setBusy(row.name);
				try {
					setView({ phase: "ready", data: await reflexCall(row.paused ? "resume" : "pause", { name: row.name }), error: "" });
				} catch (e) {
					setView((prev) => ({ ...prev, error: e && e.message ? e.message : String(e) }));
				} finally { setBusy(""); }
			};
			const data = view.data;
			const rows = (data && data.sources) || [];
			const builtin = (data && data.builtin) || [];
			const pausedCount = rows.filter((r) => r.paused).length;
			const summary = tr("srcSummary")
				.replace("{n}", String(rows.length - pausedCount))
				.replace("{m}", String(pausedCount));
			const rowNode = (r) => {
				const st = stateOf(r, tr);
				return react_jsx_runtime.jsxs("tr", { children: [
					react_jsx_runtime.jsx("td", { className: "rfx-td", children: react_jsx_runtime.jsx("span", { className: "rfx-name", children: r.name }) }, "n"),
					react_jsx_runtime.jsx("td", { className: "rfx-td rfx-muted", children: everyLabel(r.intervalMs, tr) }, "e"),
					react_jsx_runtime.jsx("td", { className: "rfx-td rfx-num", children: String(r.factsToday || 0) }, "t"),
					react_jsx_runtime.jsx("td", { className: "rfx-td rfx-num rfx-muted", children: clockLabel(r.lastFactAt) }, "l"),
					react_jsx_runtime.jsx("td", { className: "rfx-td", children: react_jsx_runtime.jsxs("span", { children: [
						react_jsx_runtime.jsx("span", { className: "rfx-dot", style: { background: st.color } }, "d"),
						st.text
					] }) }, "s"),
					react_jsx_runtime.jsx("td", { className: "rfx-td", children: react_jsx_runtime.jsx("button", {
						type: "button", className: "rfx-btn", disabled: busy === r.name,
						onClick: () => void toggle(r),
						children: busy === r.name ? tr("srcWorking") : (r.paused ? tr("srcResume") : tr("srcPause"))
					}) }, "a")
				] }, r.name);
			};
			return react_jsx_runtime.jsxs("div", { className: "rfx-page", children: [
				react_jsx_runtime.jsx("style", { children: SRC_CSS }, "css"),
				react_jsx_runtime.jsxs("div", { className: "rfx-inner", children: [
					react_jsx_runtime.jsxs("header", { className: "rfx-head", children: [
						react_jsx_runtime.jsxs("div", { children: [
							react_jsx_runtime.jsx("h1", { className: "rfx-title", children: tr("srcTitle") }),
							react_jsx_runtime.jsx("p", { className: "rfx-desc", children: tr("srcDesc") })
						] }),
						react_jsx_runtime.jsx("button", { type: "button", className: "rfx-btn", onClick: () => void load(), children: tr("srcRefresh") })
					] }),
					react_jsx_runtime.jsxs("div", { className: "rfx-body", children: [
						react_jsx_runtime.jsx("div", { className: "rfx-bar", children: data ? summary : tr("srcLoading") }),
						view.error ? react_jsx_runtime.jsxs("div", { className: "rfx-error", children: [
							react_jsx_runtime.jsx("span", { children: tr("srcLoadFail") + "：" + view.error }),
							react_jsx_runtime.jsx("button", { type: "button", className: "rfx-btn", onClick: () => void load(), children: tr("srcRetry") })
						] }) : null,
						data && rows.length === 0 && !view.error
							? react_jsx_runtime.jsx("p", { className: "rfx-muted", children: tr("srcEmpty") })
							: null,
						rows.length > 0 ? react_jsx_runtime.jsxs("table", { className: "rfx-table", children: [
							react_jsx_runtime.jsx("thead", { children: react_jsx_runtime.jsxs("tr", { children: [
								react_jsx_runtime.jsx("th", { className: "rfx-th", children: tr("srcColName") }),
								react_jsx_runtime.jsx("th", { className: "rfx-th", children: tr("srcColEvery") }),
								react_jsx_runtime.jsx("th", { className: "rfx-th", children: tr("srcColToday") }),
								react_jsx_runtime.jsx("th", { className: "rfx-th", children: tr("srcColLast") }),
								react_jsx_runtime.jsx("th", { className: "rfx-th", children: tr("srcColState") }),
								react_jsx_runtime.jsx("th", { className: "rfx-th", children: tr("srcColAction") })
							] }) }),
							react_jsx_runtime.jsx("tbody", { children: rows.map(rowNode) })
						] }) : null,
						builtin.length > 0 ? react_jsx_runtime.jsxs("section", { className: "rfx-sec", children: [
							react_jsx_runtime.jsx("h2", { className: "rfx-secTitle", children: tr("srcBuiltinTitle") }),
							react_jsx_runtime.jsx("p", { className: "rfx-secHint", children: tr("srcBuiltinHint") }),
							react_jsx_runtime.jsx("table", { className: "rfx-table", children: react_jsx_runtime.jsx("tbody", { children: builtin.map((b) => react_jsx_runtime.jsxs("tr", { children: [
								react_jsx_runtime.jsx("td", { className: "rfx-td", children: react_jsx_runtime.jsx("span", { className: "rfx-name", children: b.name }) }),
								react_jsx_runtime.jsx("td", { className: "rfx-td rfx-muted", children: b.enabled ? tr("srcStateOn") : tr("srcStatePaused") }),
								react_jsx_runtime.jsx("td", { className: "rfx-td rfx-muted", children: tr("srcBuiltinAct") })
							] }, b.name)) }) })
						] }) : null
					] })
				] })
			] });
		}
		//#endregion

		//#region index
		/** 本插件配置所在的 profile 行 id（cordis.patch.yml 里那条 `- id:`）。 */
		const ROW_NS = "dsh-reflex";
		/** 需要的客户端服务。 */
		// ⚠️ "remote" 与 "remote.credentials" 是必需的, 不是可选的。
		//    Cordis 里访问未声明的服务会抛 "cannot get property X without inject" ——
		//    而 CardController 构造时就会调 readCredential() 访问 ctx.remote,
		//    所以漏声明会让【整个配置卡片渲染失败】, 界面上什么都没有,
		//    也不会有任何错误提示(desktop 版没 console 时完全不可见)。
		//    官方 web-search 同样声明了这两个(settings-web-search 的 client.js)。
		const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			// 注册词典 —— 签名是 register(namespace, lang, dict), 三个参数。
			// 原来写成 register(NS, { zh, en })(把字典对象当成了 lang), 所以两份词典
			// 从未注册进去: 界面取不到词条, 只能回退到兜底文案 —— 表现为"多语言没生效"。
			// 写法对齐官方实现见 ds-bot/client.js 的 installLocale。
			// 注意 effect 必须【双箭头】: 单箭头时返回值会被当作 dispose 立刻执行。
			ctx.effect(() => {
				const offs = [];
				for (const [lang, dict] of [["zh", zh], ["en", en]]) {
					try {
						const off = ctx.locale.register(NS, lang, dict);
						if (typeof off === "function") offs.push(off);
					} catch (e) { /* locale 服务不可用时静默降级, 不拖垮宿主 */ }
				}
				return () => { for (const off of offs) { try { off(); } catch (e) { /* 忽略 */ } } };
			}, "dsh-reflex: dictionaries");
			const card = new CardController(ctx.configForms.get(ROW_NS), ctx);
			ctx.effect(() => () => card.dispose(), "dsh-reflex: form subscription");
			// whileServed: 宿主服务该行的配置时注册，停止服务时注销 ——
			// 与官方设置页同一套写法, 所以插件被禁用时这一页不会残留。
			// 数据源是主列整页，不是弹层：main 槽的 keyed 页 + sidebar.panellist 入口
			// （Plugins 页同款）。侧栏自己调 selectPanel(id)，所以两个 id 必须相同 ——
			// 不一致就是点了没反应，而界面上没有任何报错。
			ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: SRC_PANEL_ID,
				locale: NS
			}, SourcesPage)), "dsh-reflex: sources page");
			ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: SRC_PANEL_ID,
				order: 10,
				label: () => tr("srcNav"),
				locale: NS
			}, TriggerIcon)), "dsh-reflex: trigger nav");
			ctx.effect(() => ctx.configForms.whileServed([ROW_NS], (served) => {
				if (!served.has(ROW_NS)) return;
				return ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
					name: "plugins.row.config",
					key: "dsh-reflex#" + ROW_NS,
					locale: NS,
					inject: () => card.inject()
				}, Card));
			}), "dsh-reflex: config page");
		}
		//#endregion

		exports.NS = NS;
		exports.reflexCall = reflexCall;
		exports.SourcesPage = SourcesPage;
		exports.TriggerIcon = TriggerIcon;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
