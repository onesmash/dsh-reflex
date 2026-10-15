window.__ModuleLoader__.load({
	id: "ds-bot-layered-agent",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const react_jsx_runtime = require("react/jsx-runtime");
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region locales
		const NS = "layeredAgent.config";

		const zh = {
			title: "分层智能体",
			description: "选择 L1 语义判定用哪个后端，以及托管 Jev 的端点和模型。",
			backend: "决策后端",
			backendHint: "留空=semif（本地模型，不联网）｜jev=TypeSafe 托管（内容会离开本机）｜jevlocal=本地同款端点",
			jevBaseUrl: "Jev 端点",
			jevBaseUrlHint: "TypeSafe: https://api.typesafe.ai ｜ OpenRouter: https://openrouter.ai/api/v1 ｜ Vercel: https://ai-gateway.vercel.sh/typesafe/v1 ｜ 本地: http://127.0.0.1:30001",
			jevModel: "Jev 模型",
			jevModelHint: "TypeSafe/local: jev-latest ｜ OpenRouter: typesafe/jev-1.13 ｜ Vercel: typesafe-ai/jev。生产环境请钉住具体版本。",
			keyNote: "API key 不在这里配置 —— 它写在凭据文件的 refs 段（键名 JEV_API_KEY），插件按白名单读取，不经聊天也不进本配置文件。三条路线只差 base URL 与模型名：TypeSafe https://api.typesafe.ai + jev-latest；OpenRouter https://openrouter.ai/api/v1 + typesafe/jev-1.13（同一 /v1/systemone 线格式）；Vercel AI Gateway https://ai-gateway.vercel.sh/typesafe/v1 + typesafe-ai/jev。",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "插件未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "保存失败，已保留你的输入。",
			saveError: "保存被拒绝的原因："
		};

		const en = {
			title: "Layered Agent",
			description: "Which backend scores L1 decisions, and the hosted Jev endpoint and model.",
			backend: "Decision backend",
			backendHint: "Blank = semif (local model, no network) | jev = TypeSafe hosted (content leaves this machine) | jevlocal = same wire format on a local endpoint",
			jevBaseUrl: "Jev endpoint",
			jevBaseUrlHint: "TypeSafe: https://api.typesafe.ai | OpenRouter: https://openrouter.ai/api/v1 | Vercel: https://ai-gateway.vercel.sh/typesafe/v1 | local: http://127.0.0.1:30001",
			jevModel: "Jev model",
			jevModelHint: "TypeSafe/local: jev-latest | OpenRouter: typesafe/jev-1.13 | Vercel: typesafe-ai/jev. Pin a version in production.",
			keyNote: "The API key is not set here. It lives in the credentials file's refs section under JEV_API_KEY; the plugin reads it by allowlist, so it never goes through chat or this config file. The three routes differ only in base URL and model name: TypeSafe https://api.typesafe.ai + jev-latest; OpenRouter https://openrouter.ai/api/v1 + typesafe/jev-1.13 (same /v1/systemone wire format); Vercel AI Gateway https://ai-gateway.vercel.sh/typesafe/v1 + typesafe-ai/jev.",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			saveError: "Why the save was refused:"
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
		/**
		 * 桥接本插件配置命名空间的表单到插件页的暂存表单。
		 *
		 * 字段名必须与宿主 Config schema 里声明的键一致（decide.backend 等）——
		 * schema 是"这段配置能被面板服务"的前提，这里只是把它渲染出来。
		 */
		var CardController = class {
			constructor(scope) {
				this.form = new ui.SettingsFormModel(scope, [
					ui.settingsTextField("backend"),
					ui.settingsTextField("jevBaseUrl"),
					ui.settingsTextField("jevModel")
				]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					backend: this.form.field("backend"),
					jevBaseUrl: this.form.field("jevBaseUrl"),
					jevModel: this.form.field("jevModel")
				};
			}
			/** 页面 slot 注入的那一面：快照 + 表单动作。 */
			inject() {
				return { hooks: { card: this.store }, ...this.form.actions() };
			}
			dispose() {
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
					saveError
						? (0, react_jsx_runtime.jsx)("p", { style: { color: "#c0392b", whiteSpace: "pre-wrap" },
							children: t("saveError") + "\n" + saveError })
						: null,
					(0, react_jsx_runtime.jsx)("p", { children: t("keyNote") })
				]
			});
		}
		//#endregion

		//#region index
		/** 本插件配置所在的 profile 行 id（cordis.patch.yml 里那条 `- id:`）。 */
		const ROW_NS = "layered-agent";
		/** 需要的客户端服务。 */
		const inject = ["slots", "locale", "configForms"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "layered-agent: dictionaries");
			const card = new CardController(ctx.configForms.get(ROW_NS));
			ctx.effect(() => () => card.dispose(), "layered-agent: form subscription");
			// whileServed: 宿主服务该行的配置时注册，停止服务时注销 ——
			// 与官方设置页同一套写法, 所以插件被禁用时这一页不会残留。
			ctx.effect(() => ctx.configForms.whileServed([ROW_NS], (served) => {
				if (!served.has(ROW_NS)) return;
				return ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
					name: "plugins.row.config",
					key: "ds-bot-layered-agent#" + ROW_NS,
					locale: NS,
					inject: () => card.inject()
				}, Card));
			}), "layered-agent: config page");
		}
		//#endregion

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
