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
			diagErrorPrefix: "保存出错："
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
			diagErrorPrefix: "Save failed: "
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
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
