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
			srcDesc: "采集源负责抓数据；判定（L1）决定什么情况叫醒你。这里开关每一路采集：暂停写的是磁盘上的 <name>.paused 标记，采集器下一轮读到，不用改 profile，也不用重启。",
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
			srcFollowing: "跟随全局",
			srcAdd: "添加数据源",
			srcAddBack: "返回列表",
			addDesc: "三段式：采什么 → 多久 → 何时叫醒。填完点创建，脚本落盘即生效。",
			addGive: "采什么",
			addGiveHint: "一条命令，它的输出就是数据：每行一个 JSON 对象。去重、首跑建水位、失败标记都由这一层包好。",
			addName: "名称",
			addNameHint: "会变成 collectors/<name>.sh 的文件名，也是 targets 里的源名。",
			addNameRule: "a-z 0-9 . _ -",
			addOptional: "选填",
			addInterval: "采集间隔",
			addProbeHint: "15 秒超时 · 只读输出，不写盘",
			addWritesTitle: "会写入",
			addTriggerLegend: "叫醒条件",
			unitMin: "分钟",
			unitHour: "小时",
			unitSec: "秒",
			addAbout: "一句话用途",
			addAboutHint: "选填。写进脚本头与 schema，方便以后自己看懂。",
			addCmd: "采集命令",
			addCmdHint: "例：curl -s https://example.com/api | jq -c '.[]'。可用 $REFLEX_HOME 定位状态文件。",
			addProbe: "试跑",
			addProbing: "试跑中…",
			addProbeLines: "输出 {lines} 行，其中 {valid} 行是合法 JSON",
			addProbeEmpty: "命令没有输出（退出 0 + 空输出 = 本轮无新数据）",
			addProbeTimeout: "跑了 15 秒还没结束，已被杀掉",
			addProbeRc: "退出码 {code}（非 0 会被记成 failed，没找到数据请接 || true）",
			addProbeStderr: "stderr 末行：",
			addWhen: "多久采一次",
			addWhenHint: "采集间隔。落盘即生效（热发现）：不用改 profile，也不用重启。",
			addTrigger: "什么时候叫醒我",
			addTriggerHint: "决定要不要生成 targets/<name>.sh。不命中就一个字都不输出。",
			addModeAll: "任何新条目",
			addModeAllHint: "每有一条新数据就叫醒。源本身只产出值得看的东西时选这个。",
			addModeMatch: "命中关键词",
			addModeMatchHint: "内容里出现任意一个关键词才叫。适合盯人名、公司名、事件词。",
			addModeSemantic: "语义判据（先影子）",
			addModeSemanticHint: "写一句判据，本地模型逐条打分。先只记账不叫醒，攒够样本再拟合阈值。",
			addModeOff: "只采集，不叫醒",
			addModeOffHint: "只进 L0 事实层，留给 L2 自己查。",
			addKeywords: "关键词",
			addKeywordsHint: "逗号 / 顿号 / 换行分隔，命中任意一个即可",
			addCriteria: "判据",
			addCriteriaHint: "一句话。措辞一变分数会整体位移，所以先影子。",
			addPreview: "将要做的事",
			addFiles: "会写 collectors/{name}.sh 与两个配置；TRIGGER 不是「只采集」时再写 targets/{name}.sh 与它的配置。",
			addCreate: "创建",
			addCreating: "创建中…",
			addCancel: "取消",
			addNeedName: "先给这个源起个名字",
			addNeedCmd: "还没有采集命令",
			addNeedKeywords: "「命中关键词」至少写一个词",
			addNeedCriteria: "「语义判据」需要一句话",
			addNeedReload: "宿主里的插件还是旧版（不认识 create）：重启 DSH 之后这个入口才能真的写盘。",
			createdOk: "已创建 {name}：开始采集，首跑只建水位（不发存量）。",
			// 一句话建源（2026-11-25 起界面只剩这一个入口）
			addAskTitle: "一句话加监控",
			addAskPlaceholder: "例：盯着 arxiv cs.SE 有新论文就叫我",
			addAskSend: "交给 Chief",
			addAskSending: "投递中…",
			addAskSent: "已交给 {target}：它去写采集器并自验，建好后列表里会出现这一行（它正忙时会排队）。",
			addAskHint: "不用填字段：原话会原样交给 Chief，由它按 reflex-datasource 写采集器并跑一遍验证。",
			addAskNeedSentence: "先写一句话：监控什么、什么情况叫你。",
			addAskTooLong: "那句话太长了（上限 500 字），拆成两个监控更清楚。",
			addAskReload: "宿主里的插件还是旧版（不认识 delegate）：重启 DSH 之后这个按钮才真的把话交给 Chief。",
			// 逐行判定调优
			tuneBtn: "调优",
			tuneTitle: "调这个源的判定：阈值与判据（交给 Chief 按 reflex-tuning 执行）",
			tuneNoTarget: "这个源只采集、不判定，没有可调的东西",
			tuneRunning: "投递中…",
			tuneSent: "已把 {name} 的判定调优请求交给 {target}",
			tuneReload: "宿主里的插件还是旧版（不认识 tune）：重启 DSH 之后这个按钮才生效。",
			srcNew: "新"
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
			srcDesc: "Collectors gather data; judgement (L1) decides what wakes you. Each switch writes <name>.paused on disk, which the collector reads on its next round — no profile edit, no restart.",
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
			srcFollowing: "Follows global",
			srcAdd: "Add data source",
			srcAddBack: "Back to list",
			addDesc: "Three stages: feed, every, wake. Create writes the scripts; they apply straight from disk.",
			addGive: "What it feeds",
			addGiveHint: "One command; its output is the data, one JSON object per line. Dedup, first-run watermark and failure marking are handled here.",
			addName: "Name",
			addNameHint: "Becomes the file name collectors/<name>.sh and the source name in targets.",
			addNameRule: "a-z 0-9 . _ -",
			addOptional: "optional",
			addInterval: "Interval",
			addProbeHint: "15s timeout · reads output, writes nothing",
			addWritesTitle: "Writes",
			addTriggerLegend: "Wake condition",
			unitMin: "min",
			unitHour: "h",
			unitSec: "s",
			addAbout: "One-line purpose",
			addAboutHint: "Optional. Written into the script header and the schema.",
			addCmd: "Collect command",
			addCmdHint: "e.g. curl -s https://example.com/api | jq -c '.[]'. $REFLEX_HOME points at the state directory.",
			addProbe: "Try it",
			addProbing: "Running…",
			addProbeLines: "{lines} lines, {valid} of them valid JSON",
			addProbeEmpty: "The command printed nothing (exit 0 + empty output = nothing new this round)",
			addProbeTimeout: "Still running after 15s, so it was killed",
			addProbeRc: "Exit code {code} (non-zero is recorded as failed; append || true when empty is normal)",
			addProbeStderr: "Last stderr line: ",
			addWhen: "How often it runs",
			addWhenHint: "Collection interval. Applies from disk (hot discovery): no profile edit, no restart.",
			addTrigger: "When to wake you",
			addTriggerHint: "Decides whether targets/<name>.sh is written. No hit means no output at all.",
			addModeAll: "Any new item",
			addModeAllHint: "Wake on every new fact. Use it when the source only emits things worth seeing.",
			addModeMatch: "Keyword hit",
			addModeMatchHint: "Wake only when the content contains one of the keywords.",
			addModeSemantic: "Semantic criterion (shadow first)",
			addModeSemanticHint: "One criterion; the local model scores each item. Shadow mode only records — fit a threshold later.",
			addModeOff: "Collect only",
			addModeOffHint: "Facts land in L0 for L2 to look up; nothing wakes.",
			addKeywords: "Keywords",
			addKeywordsHint: "Separated by commas or newlines; any hit wakes",
			addCriteria: "Criterion",
			addCriteriaHint: "One sentence. Wording shifts scores, so shadow first.",
			addPreview: "What will happen",
			addFiles: "Writes collectors/{name}.sh plus two config files; unless TRIGGER is collect-only, also targets/{name}.sh and its config.",
			addCreate: "Create",
			addCreating: "Creating…",
			addCancel: "Cancel",
			addNeedName: "Give this source a name first",
			addNeedCmd: "No collect command yet",
			addNeedKeywords: "Keyword mode needs at least one keyword",
			addNeedCriteria: "Semantic mode needs one sentence",
			addNeedReload: "The loaded plugin is older than this page (it does not know create). Restart DSH, then this button writes files.",
			createdOk: "Created {name}: collecting now; the first run only builds the watermark (no backlog).",
			// one-line creation (the only entry point since 2026-11-25)
			addAskTitle: "Add a monitor in one line",
			addAskPlaceholder: "e.g. tell me when arxiv cs.SE has a new paper",
			addAskSend: "Send to Chief",
			addAskSending: "Sending…",
			addAskSent: "Handed to {target}: it writes the collector and verifies it; the row shows up here once created (it queues while busy).",
			addAskHint: "No fields: your words go to Chief verbatim, and it follows reflex-datasource to write the collector and verify it.",
			addAskNeedSentence: "Write one line: what to watch, and when to tell you.",
			addAskTooLong: "That line is too long (max 500 characters); two smaller monitors are clearer.",
			addAskReload: "The loaded plugin is older than this page (it does not know delegate). Restart DSH, then this button really hands the line to Chief.",
			// per-row judgement tuning
			tuneBtn: "Tune",
			tuneTitle: "Tune this source's judgement (threshold / criteria); Chief runs it via reflex-tuning",
			tuneNoTarget: "This source only collects and never judges; nothing to tune",
			tuneRunning: "Sending…",
			tuneSent: "Judgement tuning request for {name} handed to {target}",
			tuneReload: "The loaded plugin is older than this page (it does not know tune). Restart DSH, then this button works.",
			srcNew: "new"
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
		/**
		 * 上一次成功的 list 结果。
		 * 数据源页每次挂载都会重跑 load()，没有这份缓存，用户点开侧栏要先看一屏空白、
		 * 再等一个网络来回；有它，首帧直接铺上次的表，新数据在后台补上。
		 */
		let listCache = null;
		/** 一次成功的返回同时写进缓存 —— 缓存只有这一个写入口，不和界面各走一条路。 */
		const rememberList = (data) => { listCache = data; return data; };
		/**
		 * 预热：插件加载时先取一次，这样第一次点开侧栏也不必等网络。
		 * 失败静默 —— 真正打开页面时 load() 还会再试一次并把原因显示出来，
		 * 预热失败不该拖垮插件加载。
		 */
		void (async () => {
			try { rememberList(await reflexCall("list")); } catch (e) { /* 预热失败留给页面去报 */ }
		})();
		function everyLabel(ms, t) {
			const tr = typeof t === "function" ? t : (k) => k;
			if (!Number.isFinite(ms) || ms <= 0) return tr("srcFollowing");
			if (ms % 3600000 === 0) return ms / 3600000 + " " + tr("unitHour");
			if (ms % 60000 === 0) return ms / 60000 + " " + tr("unitMin");
			return Math.round(ms / 1000) + " " + tr("unitSec");
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
			srcDesc: "Collectors gather data; judgement (L1) decides what wakes you. Each switch writes <name>.paused on disk, which the collector reads on its next round — no profile edit, no restart.",
			srcRefresh: "Refresh", srcLoading: "Loading…", srcSummary: "{n} collecting · {m} paused",
			srcColName: "Name", srcColEvery: "Every", srcColToday: "Today", srcColLast: "Last success",
			srcColState: "State", srcColAction: "Action",
			srcPause: "Pause", srcResume: "Resume", srcWorking: "Working…",
			srcStateOn: "Collecting", srcStateIdle: "No data", srcStatePaused: "Paused", srcStateFailed: "Failed",
			srcBuiltinTitle: "Built-in sources",
			srcBuiltinHint: "Controlled by the profile's l0.sources; reload DSH after changing them.",
			srcBuiltinAct: "Profile-controlled",
			srcEmpty: "No scripts in collectors yet — drop a <name>.sh there to enable one.",
			srcLoadFail: "Read failed", srcRetry: "Retry", srcFollowing: "Follows global",
srcAdd: "Add data source",
srcAddBack: "Back to list",
addDesc: "Three stages: feed, every, wake. Create writes the scripts; they apply straight from disk.",
addGive: "What it feeds",
addGiveHint: "One command; its output is the data, one JSON object per line. Dedup, first-run watermark and failure marking are handled here.",
addName: "Name",
addNameHint: "Becomes the file name collectors/<name>.sh and the source name in targets.",
addNameRule: "a-z 0-9 . _ -",
addOptional: "optional",
addInterval: "Interval",
addProbeHint: "15s timeout · reads output, writes nothing",
addWritesTitle: "Writes",
addTriggerLegend: "Wake condition",
unitMin: "min",
unitHour: "h",
unitSec: "s",
addAbout: "One-line purpose",
addAboutHint: "Optional. Written into the script header and the schema.",
addCmd: "Collect command",
addCmdHint: "e.g. curl -s https://example.com/api | jq -c '.[]'. $REFLEX_HOME points at the state directory.",
addProbe: "Try it",
addProbing: "Running…",
addProbeLines: "{lines} lines, {valid} of them valid JSON",
addProbeEmpty: "The command printed nothing (exit 0 + empty output = nothing new this round)",
addProbeTimeout: "Still running after 15s, so it was killed",
			addProbeRc: "Exit code {code} (non-zero is recorded as failed; append || true when empty is normal)",
addProbeStderr: "Last stderr line: ",
addWhen: "How often it runs",
addWhenHint: "Collection interval. Applies from disk (hot discovery): no profile edit, no restart.",
addTrigger: "When to wake you",
addTriggerHint: "Decides whether targets/<name>.sh is written. No hit means no output at all.",
addModeAll: "Any new item",
addModeAllHint: "Wake on every new fact. Use it when the source only emits things worth seeing.",
addModeMatch: "Keyword hit",
addModeMatchHint: "Wake only when the content contains one of the keywords.",
addModeSemantic: "Semantic criterion (shadow first)",
addModeSemanticHint: "One criterion; the local model scores each item. Shadow mode only records — fit a threshold later.",
addModeOff: "Collect only",
addModeOffHint: "Facts land in L0 for L2 to look up; nothing wakes.",
addKeywords: "Keywords",
addKeywordsHint: "Separated by commas or newlines; any hit wakes",
addCriteria: "Criterion",
addCriteriaHint: "One sentence. Wording shifts scores, so shadow first.",
addPreview: "What will happen",
addFiles: "Writes collectors/{name}.sh plus two config files; unless TRIGGER is collect-only, also targets/{name}.sh and its config.",
addCreate: "Create",
addCreating: "Creating…",
addCancel: "Cancel",
addNeedName: "Give this source a name first",
addNeedCmd: "No collect command yet",
addNeedKeywords: "Keyword mode needs at least one keyword",
addNeedCriteria: "Semantic mode needs one sentence",
			addNeedReload: "The loaded plugin is older than this page (it does not know create). Restart DSH, then this button writes files.",
createdOk: "Created {name}: collecting now; the first run only builds the watermark (no backlog).",
addAskTitle: "Add a monitor in one line",
addAskPlaceholder: "e.g. tell me when arxiv cs.SE has a new paper",
addAskSend: "Send to Chief",
addAskSending: "Sending…",
addAskSent: "Handed to {target}: it writes the collector and verifies it; the row shows up here once created (it queues while busy).",
addAskHint: "No fields: your words go to Chief verbatim, and it follows reflex-datasource to write the collector and verify it.",
addAskNeedSentence: "Write one line: what to watch, and when to tell you.",
addAskTooLong: "That line is too long (max 500 characters); two smaller monitors are clearer.",
addAskReload: "The loaded plugin is older than this page (it does not know delegate). Restart DSH, then this button really hands the line to Chief.",
tuneBtn: "Tune",
tuneTitle: "Tune this source's judgement (threshold / criteria); Chief runs it via reflex-tuning",
tuneNoTarget: "This source only collects and never judges; nothing to tune",
tuneRunning: "Sending…",
tuneSent: "Judgement tuning request for {name} handed to {target}",
tuneReload: "The loaded plugin is older than this page (it does not know tune). Restart DSH, then this button works.",
srcNew: "new"
		};
		/** 取一条文案：当前语言没有就回退英文，再没有才回 key。 */
		function srcText(t, key) {
			const value = typeof t === "function" ? t(key) : key;
			return !value || value === key ? (SRC_FALLBACK[key] || key) : value;
		}
		/** 页面样式。作为 <style> 元素渲染在组件里，卸载即移除，不写 document.head。 */
		const SRC_CSS = `.rfx-page{--rfx-line:var(--dsw-alias-border-l1,#ececec);--rfx-line2:var(--dsw-alias-border-l2,#dedede);--rfx-ink2:var(--dsw-alias-label-secondary,#6b7280);--rfx-ink3:var(--dsw-alias-label-tertiary,#9ca3af);--rfx-brand:var(--dsw-alias-brand-primary,#4d6bfe);--rfx-on-brand:var(--dsw-alias-label-primary-inverted,#fff);--rfx-err:color-mix(in srgb,#e5484d 62%,var(--dsw-alias-label-primary,#111));--rfx-panel:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));--rfx-card:var(--dsw-alias-bg-layer-1,transparent);display:flex;flex-direction:column;flex:1;min-height:0;height:100%;box-sizing:border-box;padding:0 clamp(20px,3.2vw,40px);color:var(--dsw-alias-label-primary,#111);container-type:inline-size}
.rfx-inner{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;max-width:1080px;margin:0 auto}
.rfx-head{flex:none;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:calc(var(--dsh-frame-top-clearance,44px) + 4px) 0 14px;border-bottom:1px solid var(--rfx-line)}
.rfx-title{margin:0;font-size:18px;font-weight:600;line-height:1.3;text-wrap:balance}
.rfx-desc{margin:5px 0 0;font-size:12.5px;line-height:1.55;color:var(--rfx-ink2);text-wrap:pretty}
.rfx-headActions{display:flex;align-items:center;gap:8px;flex:none}
.rfx-body{flex:1;min-height:0;overflow:auto;padding:0 0 8px}
.rfx-ask{margin:16px 0 4px;padding:14px;border:1px solid var(--rfx-line);border-radius:var(--dsw-radius-md,10px);background:var(--rfx-panel)}
.rfx-askTitle{margin:0 0 9px;font-size:13px;font-weight:600}
.rfx-askRow{display:flex;align-items:center;gap:8px}
.rfx-input{box-sizing:border-box;width:100%;font:inherit;font-size:13px;padding:8px 10px;min-height:36px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--rfx-line2);background:var(--rfx-card);color:inherit;transition:border-color 140ms ease,box-shadow 140ms ease}
.rfx-input::placeholder{color:var(--rfx-ink3)}
.rfx-input:focus-visible{outline:none;border-color:var(--rfx-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--rfx-brand) 16%,transparent)}
.rfx-askInput{flex:1;min-width:0}
.rfx-hint{margin:7px 0 0;font-size:11.5px;line-height:1.55;color:var(--rfx-ink2);text-wrap:pretty}
.rfx-saveMsg{font-size:12px;line-height:1.45;color:var(--rfx-err)}
.rfx-saveMsg:empty{display:none}.rfx-saveMsg--ok{color:var(--rfx-ink2)}
.rfx-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;flex:none;border:1px solid var(--rfx-line2);background:var(--rfx-card);color:inherit;border-radius:var(--dsw-radius-sm,8px);padding:0 12px;min-height:32px;font:inherit;font-size:12.5px;cursor:pointer;transition:background-color 140ms ease,border-color 140ms ease,transform 120ms ease,color 140ms ease}
.rfx-btn:hover:not(:disabled){background:var(--rfx-panel);border-color:var(--rfx-ink3)}
.rfx-btn:active:not(:disabled){transform:translateY(1px)}
.rfx-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--rfx-brand) 22%,transparent)}
.rfx-btn:disabled{opacity:.5;cursor:default}
.rfx-askSend{min-width:104px}
.rfx-btnPrimary{border-color:var(--rfx-brand);background:var(--rfx-brand);color:var(--rfx-on-brand)}
.rfx-btnPrimary:hover:not(:disabled){background:color-mix(in srgb,var(--rfx-brand) 88%,#000);border-color:color-mix(in srgb,var(--rfx-brand) 88%,#000);color:var(--rfx-on-brand)}
.rfx-bar{display:flex;align-items:center;gap:10px;padding:12px 0 4px;font-size:12px;color:var(--rfx-ink2)}
.rfx-table{width:100%;border-collapse:collapse;font-size:13px}
.rfx-th{text-align:left;font-weight:600;color:var(--rfx-ink2);padding:8px 10px;border-bottom:1px solid var(--rfx-line2);white-space:nowrap}
.rfx-td{padding:11px 10px;border-bottom:1px solid var(--rfx-line);vertical-align:middle}
.rfx-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.rfx-nameRow{display:inline-flex;align-items:center;gap:8px}
.rfx-muted{color:var(--rfx-ink3)}
.rfx-num{font-variant-numeric:tabular-nums}
.rfx-dot{display:inline-block;width:7px;height:7px;border-radius:999px;margin-right:6px;vertical-align:1px}
.rfx-sec{margin-top:30px}
.rfx-secTitle{margin:0;font-size:13px;font-weight:600}
.rfx-secHint{margin:3px 0 4px;font-size:12px;color:var(--rfx-ink2)}
.rfx-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0;padding:10px 12px;border-radius:var(--dsw-radius-md,10px);border:1px solid rgba(192,57,43,.35);background:rgba(192,57,43,.06);color:var(--rfx-err);font-size:13px}
.rfx-rowBtns{display:inline-flex;align-items:center;gap:6px}.rfx-tune{min-width:52px}.rfx-tuneMsg{margin:8px 0 0}
@container (max-width:560px){.rfx-askRow{flex-wrap:wrap}.rfx-askSend{width:100%}}
@media (max-width:640px){.rfx-head{flex-wrap:wrap;align-items:flex-start}.rfx-askRow{flex-wrap:wrap}.rfx-askSend{width:100%}}
@container (max-width:560px){.rfx-sources .rfx-th,.rfx-sources .rfx-td{padding-left:6px;padding-right:6px}.rfx-sources thead th:nth-child(3),.rfx-sources thead th:nth-child(4),.rfx-sources tbody td:nth-child(3),.rfx-sources tbody td:nth-child(4){display:none}.rfx-sources .rfx-btn{padding:0 8px;font-size:12px}.rfx-sources .rfx-name{word-break:break-all}.rfx-sources .rfx-th:last-child,.rfx-sources .rfx-td:last-child{white-space:nowrap}}
@media (pointer:coarse){.rfx-btn{min-height:44px}.rfx-input{min-height:44px}}
@media (prefers-reduced-motion:reduce){.rfx-page *{transition:none!important;animation:none!important}}
`;
		/**
		 * 一句话 → 请求体。纯函数：界面到底发了什么，测试可以直接调一次看到。
		 *
		 * 2026-11-25 起界面只剩一个输入框：用户说一句，宿主把原话拼成提示词投给 Chief，
		 * 由它按 reflex-datasource 落盘。这里只做 trim，绝不"帮用户改写需求"——
		 * 改写过的原话，建出来的就是另一个监控。
		 */
		function delegateBody(sentence) {
			return { op: "delegate", sentence: String(sentence || "").trim() };
		}
		/**
		 * 逐行「L1 调优」→ 请求体。只发一个源名：有没有这个源、有没有 L1 由宿主判
		 * （只有宿主手里有 collectors/targets 两个目录）。
		 */
		function tuneBody(name) {
			return { op: "tune", name: String(name || "").trim() };
		}
		/** 本地只挡「还没写」和「长得离谱」；其余交给宿主，错了它给准话。上限与宿主同一个数。 */
		const SENTENCE_MAX = 500;
		/** @returns {string} 对应的文案 key；空串 = 可以发 */
		function sentenceBlocker(sentence) {
			const s = String(sentence || "").trim();
			if (!s) return "addAskNeedSentence";
			if (s.length > SENTENCE_MAX) return "addAskTooLong";
			return "";
		}
		function SourcesPage(props) {
			const t = typeof props.t === "function" ? props.t : (k) => k;
			const tr = (k) => srcText(t, k);
			// 首帧就用缓存：useState 只认第一次传进去的值，所以这里不是「每次渲染都新建」的浪费，
			// 而是「挂载时把上次的表直接铺出来」。写成惰性初始化（传函数）在宿主与测试桩里语义不一致，不划算。
			const [view, setView] = react.useState(listCache
				? { phase: "ready", data: listCache, error: "" }
				: { phase: "loading", data: null, error: "" });
			const [apiMs, setApiMs] = react.useState(0);
			const [busy, setBusy] = react.useState("");
			// 一句话建源：输入框里是用户原话，send 是这条请求的投递状态。
			// 三个状态必须都看得见：投递中 / 已交给 Chief / 没投出去。少一个就会出现
			// 「点了没反应」这种最坏的观感 —— 用户不知道是坏了还是在排队。
			const [ask, setAsk] = react.useState("");
			const [send, setSend] = react.useState({ phase: "idle", error: "", target: "" });
			// 逐行调优：调哪个源、投递结果。按钮就在行里，失败原因必须回到同一个源上，
			// 不能只在页面顶部飘一句「投递失败」——用户不知道是哪一行。
			const [tuning, setTuning] = react.useState("");
			const [tuneMsg, setTuneMsg] = react.useState({ phase: "idle", name: "", error: "", target: "" });
			const load = react.useCallback(async () => {
				setView((prev) => ({ phase: prev.data ? "ready" : "loading", data: prev.data, error: "" }));
				const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
				try {
					const data = rememberList(await reflexCall("list"));
					const ms = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - t0);
					setApiMs(ms);
					setView({ phase: "ready", data, error: "" });
				} catch (e) {
					setView({ phase: "error", data: null, error: e && e.message ? e.message : String(e) });
				}
			}, []);
			react.useEffect(() => { void load(); }, [load]);
			const toggle = async (row) => {
				setBusy(row.name);
				try {
					setView({ phase: "ready", data: rememberList(await reflexCall(row.paused ? "resume" : "pause", { name: row.name })), error: "" });
				} catch (e) {
					setView((prev) => ({ ...prev, error: e && e.message ? e.message : String(e) }));
				} finally { setBusy(""); }
			};
			const onAsk = (event) => setAsk(event && event.target ? event.target.value : "");
			const sendAsk = async () => {
				const blocker = sentenceBlocker(ask);
				if (blocker) { setSend({ phase: "error", error: tr(blocker), target: "" }); return; }
				setSend({ phase: "running", error: "", target: "" });
				try {
					const sent = await reflexCall("delegate", delegateBody(ask));
					setSend({ phase: "ok", error: "", target: sent && sent.target ? sent.target : "Chief" });
					setAsk("");
				} catch (e) {
					const why = e && e.message ? e.message : String(e);
					// 宿主还是旧版插件时会回 "unknown op: delegate"：这句话对人没用，换成该做的事
					setSend({ phase: "error", error: /unknown op/.test(why) ? tr("addAskReload") : why, target: "" });
				}
			};

			const tuneRow = async (row) => {
				setTuning(row.name);
				setTuneMsg({ phase: "running", name: row.name, error: "", target: "" });
				try {
					const r = await reflexCall("tune", tuneBody(row.name));
					setTuneMsg({ phase: "ok", name: row.name, error: "", target: (r && r.target) || "Chief" });
				} catch (e) {
					const why = e && e.message ? e.message : String(e);
					// 宿主还是旧版插件时会回 "unknown op: tune"：这句话对人没用，换成该做的事
					setTuneMsg({ phase: "error", name: row.name, error: /unknown op/.test(why) ? tr("tuneReload") : why, target: "" });
				} finally { setTuning(""); }
			};

			// ---------- 列表 ----------
			const data = view.data;
			const rows = (data && data.sources) || [];
			const builtin = (data && data.builtin) || [];
			const pausedCount = rows.filter((r) => r.paused).length;
			const summary = tr("srcSummary")
				.replace("{n}", String(rows.length - pausedCount))
				.replace("{m}", String(pausedCount));
			const stateOfRow = (row) => stateOf(row, tr);
			const rowNode = (r) => {
				const st = stateOfRow(r);
				return react_jsx_runtime.jsxs("tr", { children: [
					react_jsx_runtime.jsx("td", { className: "rfx-td", children: react_jsx_runtime.jsxs("span", { className: "rfx-nameRow", children: [
						react_jsx_runtime.jsx("span", { className: "rfx-name", children: r.name })
					] }) }, "n"),
					react_jsx_runtime.jsx("td", { className: "rfx-td rfx-muted", children: everyLabel(r.intervalMs, tr) }, "e"),
					react_jsx_runtime.jsx("td", { className: "rfx-td rfx-num", children: String(r.factsToday || 0) }, "t"),
					react_jsx_runtime.jsx("td", { className: "rfx-td rfx-num rfx-muted", children: clockLabel(r.lastFactAt) }, "l"),
					react_jsx_runtime.jsx("td", { className: "rfx-td", children: react_jsx_runtime.jsxs("span", { children: [
						react_jsx_runtime.jsx("span", { className: "rfx-dot", style: { background: st.color } }, "d"),
						st.text
					] }) }, "s"),
					react_jsx_runtime.jsx("td", { className: "rfx-td", children: react_jsx_runtime.jsxs("span", { className: "rfx-rowBtns", children: [
						react_jsx_runtime.jsx("button", {
							type: "button", className: "rfx-btn rfx-tune",
							disabled: !r.hasTarget || tuning === r.name,
							title: r.hasTarget ? tr("tuneTitle") : tr("tuneNoTarget"),
							onClick: () => void tuneRow(r),
							children: tuning === r.name ? tr("tuneRunning") : tr("tuneBtn")
						}),
						react_jsx_runtime.jsx("button", {
						type: "button", className: "rfx-btn", disabled: busy === r.name,
						onClick: () => void toggle(r),
						children: busy === r.name ? tr("srcWorking") : (r.paused ? tr("srcResume") : tr("srcPause"))
						})
					] }) }, "a")
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
						react_jsx_runtime.jsxs("div", { className: "rfx-headActions", children: [
							react_jsx_runtime.jsx("button", { type: "button", className: "rfx-btn", onClick: () => void load(), children: tr("srcRefresh") })
						] })
					] }),
					react_jsx_runtime.jsxs("div", { className: "rfx-body", children: [
						react_jsx_runtime.jsxs("section", { className: "rfx-ask", "aria-labelledby": "rfx-ask-title", children: [
							react_jsx_runtime.jsx("h2", { className: "rfx-askTitle", id: "rfx-ask-title", children: tr("addAskTitle") }),
							react_jsx_runtime.jsxs("div", { className: "rfx-askRow", children: [
								react_jsx_runtime.jsx("input", {
									id: "rfx-ask", type: "text", className: "rfx-input rfx-askInput",
									placeholder: tr("addAskPlaceholder"),
									value: ask, maxLength: SENTENCE_MAX,
									"aria-describedby": "rfx-ask-hint",
									onChange: onAsk,
									onKeyDown: (event) => { if (event && event.key === "Enter") void sendAsk(); }
								}),
								react_jsx_runtime.jsx("button", {
									type: "button", className: "rfx-btn rfx-btnPrimary rfx-askSend",
									disabled: send.phase === "running",
									onClick: () => void sendAsk(),
									children: send.phase === "running" ? tr("addAskSending") : tr("addAskSend")
								})
							] }),
							react_jsx_runtime.jsx("p", { className: "rfx-hint", id: "rfx-ask-hint", children: tr("addAskHint") }),
							react_jsx_runtime.jsx("div", {
								className: send.phase === "ok" ? "rfx-saveMsg rfx-saveMsg--ok" : "rfx-saveMsg",
								role: "status", "aria-live": "polite",
								children: send.phase === "error" ? send.error
									: send.phase === "ok" ? tr("addAskSent").replace("{target}", send.target || "Chief")
										: send.phase === "running" ? tr("addAskSending") : ""
							})
						] }),
						tuneMsg.phase === "idle" ? null : react_jsx_runtime.jsx("div", {
							className: (tuneMsg.phase === "ok" ? "rfx-saveMsg rfx-tuneMsg rfx-saveMsg--ok" : "rfx-saveMsg rfx-tuneMsg"),
							role: "status", "aria-live": "polite",
							children: tuneMsg.phase === "error" ? tuneMsg.error
								: tuneMsg.phase === "running" ? tuneMsg.name + " · " + tr("tuneRunning")
									: tr("tuneSent").split("{name}").join(tuneMsg.name).split("{target}").join(tuneMsg.target || "Chief")
						}),
						react_jsx_runtime.jsx("div", { className: "rfx-bar", children: data ? summary + (apiMs > 150 ? " · " + apiMs + " ms" : "") : tr("srcLoading") }),
						view.error ? react_jsx_runtime.jsxs("div", { className: "rfx-error", children: [
							react_jsx_runtime.jsx("span", { children: tr("srcLoadFail") + "：" + view.error }),
							react_jsx_runtime.jsx("button", { type: "button", className: "rfx-btn", onClick: () => void load(), children: tr("srcRetry") })
						] }) : null,
						data && rows.length === 0 && !view.error
							? react_jsx_runtime.jsx("p", { className: "rfx-muted", children: tr("srcEmpty") })
							: null,
						rows.length > 0 ? react_jsx_runtime.jsxs("table", { className: "rfx-table rfx-sources", children: [
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
				label: () => srcText(t, "srcNav"),
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
		exports.delegateBody = delegateBody;
		exports.sentenceBlocker = sentenceBlocker;
		exports.SRC_CSS = SRC_CSS;
		exports.zh = zh;
		exports.en = en;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
