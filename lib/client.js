window.__ModuleLoader__.load({
	id: "dsh-conversation-log",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsx = require("react/jsx-runtime");
		// 官方图标（平台基线表内）；取不到就用内联 SVG 兜底，绝不因图标炸模块
		let IconDownload = null;
		try {
			IconDownload = require("@deepseek-ai/dsh-client-ui-primitives").IconDownloadOutline16 ?? null;
		} catch (error) {
			IconDownload = null;
		}
		const DownloadGlyph = () => h("svg", {
			viewBox: "0 0 16 16", width: "15", height: "15", fill: "none",
			stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", strokeLinejoin: "round",
			"aria-hidden": "true"
		}, [
			h("path", { key: "a", d: "M8 2.5v7.5" }),
			h("path", { key: "b", d: "M4.8 7.3L8 10.5l3.2-3.2" }),
			h("path", { key: "c", d: "M2.8 13.5h10.4" })
		]);
		const h = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useCallback = react.useCallback;
		const useRef = react.useRef;

		// #region constants
		const NS = "conversationLog";
		const ROUTE_PREFIX = "/ds-convo";
		const STYLE_ID = "dsh-conversation-log/styles";
		// #endregion

		// #region api
		const api = {
			state: () => fetch(ROUTE_PREFIX + "/state").then((r) => r.json()),
			settings: (patch) => fetch(ROUTE_PREFIX + "/settings", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch)
			}).then((r) => r.json()),
			search: (query, limit) => fetch(ROUTE_PREFIX + "/search", {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: query, limit: limit })
			}).then((r) => r.json()),
			save: (sessionId) => fetch(ROUTE_PREFIX + "/save", {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: sessionId ?? "" })
			}).then((r) => r.json()),
			reveal: (target) => fetch(ROUTE_PREFIX + "/reveal", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target })
			}).then((r) => r.json()),
			file: (target) => fetch(ROUTE_PREFIX + "/file?path=" + encodeURIComponent(target)).then((r) => r.text())
		};
		// #endregion

		// #region store
		// 轮询宿主状态；行与面板都从这里读，避免各自为政。
		const store = {
			state: null,
			listeners: new Set(),
			timer: null,
			start() {
				if (this.timer != null) return;
				const poll = () => {
					api.state().then((s) => {
						if (s != null && s.ok) { this.state = s; this.publish(); }
					}).catch(() => {});
				};
				poll();
				this.timer = setInterval(poll, 15000);
			},
			stop() { if (this.timer != null) { clearInterval(this.timer); this.timer = null; } },
			subscribe(listener) {
				this.listeners.add(listener);
				return () => { this.listeners.delete(listener); };
			},
			publish() {
				for (const listener of [...this.listeneners]) {
					try { listener(this.state); } catch (error) { /* ignore */ }
				}
			}
		};
		function useStore() {
			const [state, setState] = useState(() => store.state);
			useEffect(() => store.subscribe((s) => setState(s)), []);
			return state;
		}
		// #endregion

		// #region styles
		const css = `
.clg-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:12px;padding:16px 0;display:flex}
.clg-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}
.clg-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.clg-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.clg-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.clg-switch{width:44px;height:24px;border-radius:12px;border:none;cursor:pointer;position:relative;transition:background .15s;flex:none;padding:0}
.clg-switch[data-on="true"]{background:var(--dsw-alias-state-business-primary)}
.clg-switch[data-on="false"]{background:var(--dsw-alias-border-l2)}
.clg-switchKnob{position:absolute;top:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.clg-switch[data-on="true"] .clg-switchKnob{left:22px}
.clg-switch[data-on="false"] .clg-switchKnob{left:2px}
.clg-panel{flex-direction:column;gap:16px;padding:8px 0 24px;display:flex;max-width:860px}
.clg-searchRow{align-items:center;gap:8px;display:flex}
.clg-input{background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:13px;height:32px;padding:0 10px;flex:1;min-width:0;outline:none}
.clg-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.clg-btn{background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;height:32px;padding:0 12px;white-space:nowrap}
.clg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.clg-btn:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.clg-btnPrimary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}
.clg-hits{flex-direction:column;gap:8px;display:flex}
.clg-hit{background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;flex-direction:column;gap:6px;display:flex}
.clg-hitHead{align-items:baseline;gap:8px;display:flex;flex-wrap:wrap}
.clg-hitTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}
.clg-hitMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.clg-hitSnippet{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.clg-hitActions{gap:8px;display:flex;flex-wrap:wrap}
.clg-link{color:var(--dsw-alias-state-business-primary);cursor:pointer;background:none;border:none;font-size:12px;padding:0;line-height:18px}
.clg-link:hover{text-decoration:underline}
.clg-sectionTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.clg-settingsGrid{grid-template-columns:120px 1fr;gap:10px 12px;align-items:center;display:grid}
.clg-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.clg-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.clg-preview{background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;max-height:420px;overflow:auto;padding:12px 14px;white-space:pre-wrap;word-break:break-all}
.clg-headerBtn{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:28px;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.clg-headerBtn svg{width:15px;height:15px}
.clg-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.clg-headerBtn[data-busy="true"]{color:var(--dsw-alias-state-business-primary)}
.clg-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:24px 0;text-align:center}
`;
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-conversation-log";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		// #endregion

		// #region locale
		const zh = {
			"nav": "对话记录",
			"listAll": "列出全部",
			"rowTitle": "对话记录",
			"rowDesc": "每个会话自动写成可读单文件（Markdown + JSONL），可用一句话让模型找回任意历史对话",
			"statusOn": "已索引 {n} 个会话 · 上次扫描 {t}",
			"statusOff": "已关闭 · 不写新记录",
			"statusNever": "尚未扫描",
			"searchPlaceholder": "一句话描述要找的对话，如：上次做海报设计 / 昨天关于 Verilog 的讨论",
			"search": "检索",
			"saveAll": "立即保存全部",
			"saveCurrent": "保存当前会话",
			"open": "打开会话",
			"view": "查看记录",
			"reveal": "在文件夹中显示",
			"copyPath": "复制路径",
			"copied": "已复制",
			"empty": "没有匹配的对话记录，换个说法试试",
			"noIndex": "还没有任何对话记录",
			"settings": "设置",
			"outDir": "记录目录",
			"interval": "扫描间隔（秒）",
			"contentMode": "内容范围",
			"modeFull": "全量（含思考与工具）",
			"modeText": "仅对话正文",
			"formats": "文件格式",
			"enabled": "启用自动记录",
			"save": "保存",
			"saved": "已保存",
			"scanning": "扫描中…",
			"lastError": "上次错误：{e}",
			"headerSave": "保存本次对话记录",
			"headerSaved": "已保存",
			"loadFailed": "加载失败"
		};
		const en = {
			"nav": "Conversation Log",
			"listAll": "List all",
			"rowTitle": "Conversation log",
			"rowDesc": "Per-session readable files (Markdown + JSONL); recall any past conversation in one sentence",
			"statusOn": "{n} sessions indexed · last scan {t}",
			"statusOff": "Disabled",
			"statusNever": "Not scanned yet",
			"searchPlaceholder": "Describe the conversation, e.g. the poster design one / yesterday's Verilog talk",
			"search": "Search",
			"saveAll": "Save all now",
			"saveCurrent": "Save current session",
			"open": "Open session",
			"view": "View record",
			"reveal": "Show in folder",
			"copyPath": "Copy path",
			"copied": "Copied",
			"empty": "No matching conversation record — try another phrasing",
			"noIndex": "No conversation records yet",
			"settings": "Settings",
			"outDir": "Record directory",
			"interval": "Scan interval (s)",
			"contentMode": "Content",
			"modeFull": "Full (reasoning + tools)",
			"modeText": "Dialogue text only",
			"formats": "Formats",
			"enabled": "Auto-record",
			"save": "Save",
			"saved": "Saved",
			"scanning": "Scanning…",
			"lastError": "Last error: {e}",
			"headerSave": "Save this conversation record",
			"headerSaved": "Saved",
			"loadFailed": "Load failed"
		};
		// #endregion

		// #region components
		function Switch(props) {
			return h("button", {
				type: "button", className: "clg-switch", "data-on": String(props.on === true),
				"aria-label": props.label, onClick: props.onToggle
			}, h("span", { className: "clg-switchKnob" }));
		}

		/** 设置 → 通用 行：开关 + 一行状态。 */
		function ConversationLogRow(props) {
			const t = props.t;
			const state = useStore();
			const settings = state?.settings ?? {};
			const stats = state?.stats ?? {};
			const on = settings.enabled === true;
			const fill = (template, vars) => String(template).replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ""));
			const statusText = on === false ? t("statusOff")
				: (stats.lastScanAt
					? fill(t("statusOn"), { n: String(stats.sessionCount ?? 0), t: new Date(stats.lastScanAt).toLocaleString("zh-CN") })
					: t("statusNever"));
			const toggle = useCallback(() => {
				api.settings({ enabled: on === false }).then((s) => { if (s != null && s.ok) store.state = s; store.publish(); }).catch(() => {});
			}, [on]);
			return h("div", { className: "clg-row" }, [
				h("div", { className: "clg-rowText", key: "text" }, [
					h("div", { className: "clg-title", key: "title" }, t("rowTitle")),
					h("div", { className: "clg-desc", key: "desc" }, t("rowDesc")),
					h("div", { className: "clg-status", key: "status" }, statusText)
				]),
				h(Switch, { key: "switch", on: on, label: t("enabled"), onToggle: toggle })
			]);
		}

		/** 设置页 section：检索 + 记录预览 + 完整设置。 */
		function ConversationLogPanel(props) {
			const t = props.t;
			const openSession = props.openSession;
			const state = useStore();
			const [query, setQuery] = useState("");
			const [hits, setHits] = useState(null);
			const [busy, setBusy] = useState(false);
			const [preview, setPreview] = useState(null); // { name, text }
			const [form, setForm] = useState(null);
			const [savedAt, setSavedAt] = useState(0);
			const settings = state?.settings ?? {};
			const stats = state?.stats ?? {};

			useEffect(() => {
				if (form == null && settings.outDir !== void 0) {
					setForm({
						outDir: settings.outDir ?? "",
						intervalSeconds: settings.intervalSeconds ?? 20,
						contentMode: settings.contentMode ?? "full",
						formats: settings.formats ?? ["md", "jsonl"]
					});
				}
			}, [settings.outDir]);

			const runSearch = useCallback((q) => {
				setBusy(true);
				api.search(q, 10).then((r) => {
					setHits(r != null && r.ok ? r.hits : []);
					setPreview(null);
				}).catch(() => setHits([])).finally(() => setBusy(false));
			}, []);

			const saveSettings = useCallback(() => {
				if (form == null) return;
				api.settings(form).then((s) => {
					if (s != null && s.ok) { store.state = s; store.publish(); setSavedAt(Date.now()); }
				}).catch(() => {});
			}, [form]);

			const view = useCallback((hit) => {
				const target = hit.file || hit.jsonl;
				if (target === "") return;
				api.file(target).then((text) => setPreview({ name: hit.title, text: String(text).slice(0, 20000) })).catch(() => {});
			}, []);

			const copyPath = useCallback((hit) => {
				const target = hit.file || hit.jsonl;
				if (target === "" || navigator.clipboard == null) return;
				navigator.clipboard.writeText(target).then(() => setSavedAt(Date.now()), () => {});
			}, []);

			const children = [];
			// 检索区
			children.push(h("div", { className: "clg-searchRow", key: "search" }, [
				h("input", {
					key: "input", className: "clg-input", value: query, placeholder: t("searchPlaceholder"),
					onChange: (e) => setQuery(e.target.value),
					onKeyDown: (e) => { if (e.key === "Enter") runSearch(query); }
				}),
				h("button", { key: "go", type: "button", className: "clg-btn clg-btnPrimary", disabled: busy, onClick: () => runSearch(query) }, busy ? t("scanning") : t("search")),
				h("button", {
					key: "all", type: "button", className: "clg-btn", disabled: busy,
					onClick: () => { setQuery(""); runSearch(""); }
				}, t("listAll"))
			]));
			// 结果区
			if (hits != null) {
				if (hits.length === 0) {
					children.push(h("div", { className: "clg-empty", key: "empty" }, t("empty")));
				} else {
					const items = hits.map((hit, i) => h("div", { className: "clg-hit", key: hit.id ?? i }, [
						h("div", { className: "clg-hitHead", key: "head" }, [
							h("span", { className: "clg-hitTitle", key: "title" }, hit.title),
							h("span", { className: "clg-hitMeta", key: "meta" }, `${hit.createdAt} · ${hit.turns} 轮 · ${hit.id.slice(0, 8)}`)
						]),
						hit.snippet ? h("div", { className: "clg-hitSnippet", key: "snippet" }, hit.snippet) : null,
						h("div", { className: "clg-hitActions", key: "actions" }, [
							h("button", { key: "open", type: "button", className: "clg-link", onClick: () => { try { openSession(hit.id); } catch (error) { /* ignore */ } } }, t("open")),
							h("button", { key: "view", type: "button", className: "clg-link", onClick: () => view(hit) }, t("view")),
							h("button", { key: "reveal", type: "button", className: "clg-link", onClick: () => api.reveal(hit.file || hit.jsonl) }, t("reveal")),
							h("button", { key: "copy", type: "button", className: "clg-link", onClick: () => copyPath(hit) }, savedAt > 0 && Date.now() - savedAt < 1500 ? t("copied") : t("copyPath"))
						])
					]));
					children.push(h("div", { className: "clg-hits", key: "hits" }, items));
				}
			}
			// 预览区
			if (preview != null) {
				children.push(h("div", { key: "previewWrap" }, [
					h("div", { className: "clg-hitHead", key: "head", style: { marginBottom: 6 } }, [
						h("span", { className: "clg-sectionTitle", key: "name" }, `《${preview.name}》`),
						h("button", { key: "close", type: "button", className: "clg-link", onClick: () => setPreview(null) }, "✕")
					]),
					h("pre", { className: "clg-preview", key: "pre" }, preview.text)
				]));
			}
			// 设置区
			if (form != null) {
				children.push(h("div", { className: "clg-sectionTitle", key: "settingsTitle" }, t("settings")));
				children.push(h("div", { className: "clg-settingsGrid", key: "settings" }, [
					h("label", { className: "clg-label", key: "l1" }, t("enabled")),
					h(Switch, { key: "s1", on: settings.enabled === true, label: t("enabled"), onToggle: () => api.settings({ enabled: settings.enabled !== true }).then((s) => { if (s?.ok) { store.state = s; store.publish(); } }) }),
					h("label", { className: "clg-label", key: "l2" }, t("outDir")),
					h("input", { className: "clg-input", key: "s2", value: form.outDir, onChange: (e) => setForm({ ...form, outDir: e.target.value }) }),
					h("label", { className: "clg-label", key: "l3" }, t("interval")),
					h("input", { className: "clg-input", key: "s3", type: "number", min: 5, max: 600, value: form.intervalSeconds, onChange: (e) => setForm({ ...form, intervalSeconds: Number(e.target.value) || 20 }) }),
					h("label", { className: "clg-label", key: "l4" }, t("contentMode")),
					h("div", { className: "clg-searchRow", key: "s4" }, [
						h("button", {
							key: "full", type: "button", className: "clg-btn",
							style: form.contentMode === "full" ? { borderColor: "var(--dsw-alias-state-business-primary)" } : void 0,
							onClick: () => setForm({ ...form, contentMode: "full" })
						}, t("modeFull")),
						h("button", {
							key: "text", type: "button", className: "clg-btn",
							style: form.contentMode === "text" ? { borderColor: "var(--dsw-alias-state-business-primary)" } : void 0,
							onClick: () => setForm({ ...form, contentMode: "text" })
						}, t("modeText"))
					]),
					h("label", { className: "clg-label", key: "l5" }, t("formats")),
					h("div", { className: "clg-searchRow", key: "s5" }, [
						h("button", {
							key: "md", type: "button", className: "clg-btn",
							style: form.formats.includes("md") ? { borderColor: "var(--dsw-alias-state-business-primary)" } : void 0,
							onClick: () => setForm({ ...form, formats: toggleFormat(form.formats, "md") })
						}, "Markdown"),
						h("button", {
							key: "jsonl", type: "button", className: "clg-btn",
							style: form.formats.includes("jsonl") ? { borderColor: "var(--dsw-alias-state-business-primary)" } : void 0,
							onClick: () => setForm({ ...form, formats: toggleFormat(form.formats, "jsonl") })
						}, "JSONL")
					]),
					h("div", { key: "l6" }),
					h("div", { className: "clg-searchRow", key: "s6" }, [
						h("button", { key: "save", type: "button", className: "clg-btn clg-btnPrimary", onClick: saveSettings }, t("save")),
						h("button", { key: "all", type: "button", className: "clg-btn", onClick: () => api.save("").then((r) => { if (r?.ok) { api.state().then((s) => { if (s?.ok) { store.state = s; store.publish(); } }); } }) }, t("saveAll")),
						h("span", { key: "hint", className: "clg-hint" }, stats.lastScanAt ? `已索引 ${stats.sessionCount ?? 0} 个会话` : t("statusNever"))
					])
				]));
				if (stats.lastError) {
					children.push(h("div", { className: "clg-hint", key: "err" }, String(t("lastError")).replace("{e}", stats.lastError)));
				}
			}
			return h("div", { className: "clg-panel" }, children);
		}

		function toggleFormat(formats, value) {
			const has = formats.includes(value);
			const next = has ? formats.filter((f) => f !== value) : [...formats, value];
			return next.length === 0 ? formats : next;
		}

		/** 会话 Header 右侧：保存本次对话记录。 */
		function SaveRecordButton(props) {
			const t = props.t;
			const sessionId = props.sessionId;
			const [phase, setPhase] = useState("idle"); // idle | busy | done | error
			const timer = useRef(null);
			useEffect(() => () => { if (timer.current != null) clearTimeout(timer.current); }, []);
			const click = useCallback(() => {
				if (sessionId == null || sessionId === "") return;
				setPhase("busy");
				api.save(sessionId).then((r) => {
					setPhase(r != null && r.ok ? "done" : "error");
				}).catch(() => setPhase("error")).finally(() => {
					if (timer.current != null) clearTimeout(timer.current);
					timer.current = setTimeout(() => setPhase("idle"), 1800);
				});
			}, [sessionId]);
			const title = phase === "done" ? t("headerSaved") : phase === "error" ? t("loadFailed") : t("headerSave");
			return h("button", {
				type: "button", className: "clg-headerBtn", "data-busy": String(phase === "busy"),
				title: title, "aria-label": title, onClick: click
			}, phase === "idle"
				? (IconDownload != null ? h(IconDownload, { key: "icon" }) : h(DownloadGlyph, { key: "icon" }))
				: phase === "busy" ? "…" : phase === "done" ? "✓" : "✕");
		}
		// #endregion

		// #region plugin
		const inject = ["slots", "locale", "sessions"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "conversation-log: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => { store.start(); return () => store.stop(); }, "conversation-log: store");
			// 设置 → 通用 行
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "conversation-log",
				order: 20,
				locale: NS,
				inject: () => ({})
			}, ConversationLogRow));
			// 设置页 section：检索面板
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "conversation-log",
				order: 30,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({
					openSession: (id) => {
						try { ctx.sessions.open(id); } catch (error) { /* ignore */ }
					}
				})
			}, (ownerProps) => h(ConversationLogPanel, { ...ownerProps })));
			// 会话 Header 右侧保存按钮
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "conversation-log-save",
				locale: NS,
				inject: () => ({})
			}, SaveRecordButton));
		}
		// #endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
