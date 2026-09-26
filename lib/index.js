// dsh-conversation-log — host half.
//
// 每会话单文件（Markdown + JSONL）自动落盘 + 索引 + 模糊召回。
// 读取走官方 sessionQuery 服务（live 优先、版本归一），自身绝不改写会话日志。
// 所有注册都包在 try/catch 内：插件自身故障不允许影响插件树其余部分。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-conversation-log";
// 静态注入声明：ctx.<name> 能直接访问的服务必须在这里列出来（漏列 = 访问即抛错）。
export const inject = ["commands", "sessionQuery", "tools"];

const TAG = "[conversation-log]";
const ROUTE_PREFIX = "/ds-convo";
const SETTINGS_FILE = "conversation-log-settings.json";
const INDEX_SCHEMA = "dsh-conversation-log/index/v1";
const TZ = "Asia/Shanghai";

const DEFAULTS = {
	enabled: true,
	intervalSeconds: 20,
	contentMode: "full", // full | text
	formats: ["md", "jsonl"],
	maxArgChars: 600,
	maxResultChars: 1600,
	outDir: ""
};

// #region 基础工具

function log(...args) {
	try { console.log(TAG, ...args); } catch { /* ignore */ }
}
function logError(...args) {
	try { console.error(TAG, ...args); } catch { /* ignore */ }
}

function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === "string" && env.trim() !== "") return path.resolve(env);
	return path.join(os.homedir(), ".dsh");
}

function resolveDefaultOutDir() {
	// 通用默认：当前用户目录优先，DSH_HOME 兜底。部署方可在补丁 config 或
	// 设置里用 outDir 钉到任意位置。
	const candidates = [
		path.join(os.homedir(), "Documents", "dsh-conversations"),
		path.join(dshHome(), "conversation-logs")
	];
	for (const dir of candidates) {
		try {
			if (fs.existsSync(path.dirname(dir))) return dir;
		} catch { /* keep trying */ }
	}
	return candidates[candidates.length - 1];
}

function fmtTime(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", hour12: false
		}).format(new Date(ms)).replace(/\//g, "-");
	} catch { return new Date(ms).toISOString(); }
}

function fmtStamp(ms) {
	// 文件名用：2026-09-26_14-32
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown";
	try {
		const d = new Date(ms);
		const p = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
	} catch { return "unknown"; }
}

function sanitizeName(raw, fallback) {
	let s = String(raw ?? "").normalize("NFC");
	// ASCII 与中文/全角标点里不适合进文件名的都换空格
	s = s.replace(/[<>:"/\\|?*\u0000-\u001f“”‘’《》【】「」]/g, " ").replace(/\s+/g, " ").trim();
	s = s.replace(/^[.\s]+/, "").trim();
	if (s === "") s = fallback;
	if (s.length > 40) s = s.slice(0, 40).trim();
	return s;
}

function id8(id) {
	const s = String(id ?? "");
	const m = s.match(/[0-9a-f]{8}/i);
	return m ? m[0] : s.slice(0, 8);
}

function truncate(text, max) {
	const s = String(text ?? "");
	if (s.length <= max) return s;
	return s.slice(0, max) + `\n… [已截断，共 ${s.length} 字符]`;
}

function writeFileAtomic(file, content) {
	const tmp = file + ".tmp";
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, file);
}

// #endregion

// #region 事件解析（v0 chunk 增量 / v3 整合消息双形态兼容）

function blockText(block) {
	if (block == null) return "";
	if (typeof block === "string") return block;
	if (typeof block.text === "string") return block.text;
	return "";
}

function extractContentParts(content) {
	// → { texts: [], thinkings: [], images: n, files: n }
	const parts = { texts: [], thinkings: [], images: 0, files: 0 };
	if (!Array.isArray(content)) return parts;
	for (const block of content) {
		if (block == null || typeof block !== "object") continue;
		if (block.type === "text") parts.texts.push(blockText(block));
		else if (block.type === "reasoning" || block.type === "thinking") parts.thinkings.push(blockText(block));
		else if (block.type === "image") parts.images += 1;
		else if (block.type === "file") parts.files += 1;
	}
	return parts;
}

function toolResultText(message) {
	// tool/result: data.message.content[] → 展平为文本
	const out = [];
	const content = message?.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block == null || typeof block !== "object") continue;
			if (block.type === "tool-result" && Array.isArray(block.content)) {
				for (const inner of block.content) {
					if (inner?.type === "text") out.push(blockText(inner));
					else if (typeof inner?.text === "string") out.push(inner.text);
				}
			} else if (typeof block.text === "string") out.push(block.text);
		}
	}
	return out.join("\n").trim();
}

function isHumanUserMessage(data) {
	// user/message 不都是人发的：AGENTS.md 指令（agent-instructions）与插件运行时
	// 快照（plugin）也是 role:"user"。记录只收真人消息（user）与中途插话（steering）。
	const kind = data?.source?.kind;
	return kind === void 0 || kind === "user" || kind === "steering";
}

function renderEntries(events, mode) {
	const full = mode !== "text";
	const entries = [];
	let turn = 0;
	const pendingTools = new Map(); // callId → entry
	const chunks = new Map(); // `${turn}:${step}` → {text, thinking, time, seq}
	const flushChunk = (key) => {
		const acc = chunks.get(key);
		if (acc == null) return;
		chunks.delete(key);
		if (acc.text.trim() === "" && acc.thinking.trim() === "") return;
		entries.push({
			kind: "assistant", turn: acc.turn, step: acc.step, time: acc.time, seq: acc.seq,
			text: acc.text.trim(), thinking: full ? acc.thinking.trim() : ""
		});
	};
	for (const ev of events) {
		if (ev == null || typeof ev !== "object") continue;
		const data = ev.data ?? {};
		switch (ev.type) {
			case "turn/start": {
				for (const key of [...chunks.keys()]) flushChunk(key);
				turn = typeof data.turn === "number" ? data.turn : turn + 1;
				break;
			}
			case "user/message": {
				for (const key of [...chunks.keys()]) flushChunk(key);
				if (!isHumanUserMessage(data)) break;
				const parts = extractContentParts(data.content);
				let text = parts.texts.join("\n").trim();
				const tags = [];
				if (parts.images > 0) tags.push(`[图片 ×${parts.images}]`);
				if (parts.files > 0) tags.push(`[文件 ×${parts.files}]`);
				if (tags.length > 0) text = (text + "\n" + tags.join(" ")).trim();
				if (text !== "") entries.push({ kind: "user", turn, time: ev.time, seq: ev.seq, text });
				break;
			}
			case "assistant/message": {
				for (const key of [...chunks.keys()]) flushChunk(key);
				const msg = data.message ?? {};
				const parts = extractContentParts(msg.content);
				const text = parts.texts.join("\n").trim();
				const thinking = parts.thinkings.join("\n").trim();
				if (text !== "" || thinking !== "") {
					entries.push({
						kind: "assistant", turn: typeof data.turn === "number" ? data.turn : turn,
						step: data.step,
						time: ev.time, seq: ev.seq, text, thinking: full ? thinking : ""
					});
				}
				break;
			}
			case "assistant/chunk": {
				const chunk = data.chunk ?? {};
				const key = `${typeof data.turn === "number" ? data.turn : turn}:${data.step ?? 0}`;
				let acc = chunks.get(key);
				if (acc == null) {
					acc = { turn: typeof data.turn === "number" ? data.turn : turn, step: data.step, time: ev.time, seq: ev.seq, text: "", thinking: "" };
					chunks.set(key, acc);
				}
				if (chunk.type === "text") acc.text += blockText(chunk);
				else if (chunk.type === "reasoning" || chunk.type === "thinking") acc.thinking += blockText(chunk);
				break;
			}
			case "tool/call": {
				for (const key of [...chunks.keys()]) flushChunk(key);
				const callId = String(data.callId ?? "");
				let args = "";
				try { args = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {}); } catch { args = ""; }
				const entry = {
					kind: "tool", turn: typeof data.turn === "number" ? data.turn : turn,
					step: data.step,
					time: ev.time, seq: ev.seq, name: String(data.name ?? "tool"), args, result: "", error: ""
				};
				if (callId !== "") pendingTools.set(callId, entry);
				entries.push(entry);
				break;
			}
			case "tool/result": {
				const callId = String(data.message?.source?.callId ?? "");
				const text = toolResultText(data.message);
				let entry = callId !== "" ? pendingTools.get(callId) : void 0;
				if (entry == null) {
					// 无 callId 时按 turn+step 找最近一个未匹配结果的工具条目
					const turnNo = typeof data.turn === "number" ? data.turn : turn;
					const stepNo = data.step;
					for (let i = entries.length - 1; i >= 0; i--) {
						const candidate = entries[i];
						if (candidate.kind !== "tool" || candidate.result !== "" || candidate.error !== "") continue;
						if (candidate.turn === turnNo && (stepNo === void 0 || candidate.step === stepNo)) { entry = candidate; break; }
					}
				}
				if (entry != null) {
					entry.result = text;
					entry.resultTime = ev.time;
					const isError = data.isError === true || data.error != null
						|| /^(error|failed|exception)\b/i.test(text);
					if (isError) entry.error = text.slice(0, 200);
					if (callId !== "") pendingTools.delete(callId);
				}
				break;
			}
			case "step/end": {
				for (const key of [...chunks.keys()]) flushChunk(key);
				break;
			}
			default:
				break;
		}
	}
	for (const key of [...chunks.keys()]) flushChunk(key);
	// 合并同一 step 内相邻的助手消息（v3 每个 step 发一条，拆开读很碎）
	const merged = [];
	for (const entry of entries) {
		const prev = merged[merged.length - 1];
		if (entry.kind === "assistant" && prev != null && prev.kind === "assistant"
			&& prev.turn === entry.turn && prev.step === entry.step) {
			prev.text = (prev.text + "\n" + entry.text).trim();
			if (entry.thinking !== "") prev.thinking = (prev.thinking + "\n" + entry.thinking).trim();
			continue;
		}
		merged.push(entry);
	}
	return merged;
}

// #endregion

// #region 渲染

function renderMarkdown(session, entries, opts) {
	const { title, createdAt, cwd, agentPreset } = session;
	const lines = [];
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`| 会话 | 创建时间 | 最近活动 | 轮次 | 消息 | 工具调用 | 工作区 |`);
	lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
	const userN = entries.filter((e) => e.kind === "user").length;
	const asstN = entries.filter((e) => e.kind === "assistant").length;
	const toolN = entries.filter((e) => e.kind === "tool").length;
	const last = entries.length > 0 ? entries[entries.length - 1].time : createdAt;
	const turns = entries.reduce((m, e) => Math.max(m, e.turn ?? 0), 0);
	lines.push(`| \`${session.id}\` | ${fmtTime(createdAt)} | ${fmtTime(last)} | ${turns} | ${userN} 用户 / ${asstN} 助手 | ${toolN} | \`${cwd ?? "-"}\` |`);
	if (agentPreset) lines.push("");
	lines.push("");
	lines.push(`> 本文件由 dsh-conversation-log 自动生成于 ${fmtTime(Date.now())}，内容为会话日志的可读镜像；原始数据仍在 DSH 会话存储中。`);
	lines.push("");
	lines.push("---");
	let lastTurn = -1;
	for (const entry of entries) {
		if (entry.turn !== lastTurn) {
			lastTurn = entry.turn;
			lines.push("");
			lines.push(`## 第 ${entry.turn} 轮 · ${fmtTime(entry.time).slice(5)}`);
		}
		lines.push("");
		if (entry.kind === "user") {
			lines.push(`**用户** · ${fmtTime(entry.time).slice(11)}`);
			lines.push("");
			lines.push(entry.text);
		} else if (entry.kind === "assistant") {
			lines.push(`**助手** · ${fmtTime(entry.time).slice(11)}`);
			lines.push("");
			if (entry.thinking !== "") {
				lines.push("<details><summary>思考</summary>");
				lines.push("");
				lines.push(entry.thinking);
				lines.push("");
				lines.push("</details>");
				lines.push("");
			}
			lines.push(entry.text);
		} else if (entry.kind === "tool") {
			lines.push(`**工具 \`${entry.name}\`** · ${fmtTime(entry.time).slice(11)}${entry.error ? " · 失败" : ""}`);
			lines.push("");
			if (entry.args !== "") {
				lines.push("```json");
				lines.push(truncate(entry.args, opts.maxArgChars));
				lines.push("```");
			}
			if (entry.result !== "") {
				lines.push("");
				lines.push("**结果**");
				lines.push("");
				lines.push("```");
				lines.push(truncate(entry.result, opts.maxResultChars));
				lines.push("```");
			}
		}
		lines.push("");
		lines.push("---");
	}
	return lines.join("\n") + "\n";
}

function renderJsonl(session, entries) {
	const lines = [JSON.stringify({
		type: "session", schema: INDEX_SCHEMA, id: session.id, title: session.title,
		createdAt: session.createdAt, cwd: session.cwd, agentPreset: session.agentPreset
	})];
	for (const entry of entries) {
		lines.push(JSON.stringify({
			seq: entry.seq, time: entry.time, kind: entry.kind, turn: entry.turn,
			text: entry.text ?? "", thinking: entry.thinking ?? "",
			tool: entry.kind === "tool" ? {
				name: entry.name, args: entry.args, result: entry.result, error: entry.error
			} : void 0
		}));
	}
	return lines.join("\n") + "\n";
}

// #endregion

// #region 关键词与检索

const STOPWORDS = new Set(["的", "了", "是", "我", "你", "他", "她", "它", "们", "在", "和", "就", "不", "有", "也", "还", "要", "会", "着", "过", "吧", "呢", "吗", "啊", "这个", "那个", "一下", "什么", "怎么", "帮", "帮忙", "找", "查", "看", "对话", "会话", "记录"]);

function tokenize(text) {
	const s = String(text ?? "").toLowerCase();
	const tokens = [];
	const cjk = s.match(/[\u4e00-\u9fff]+/g) ?? [];
	for (const run of cjk) {
		if (run.length === 1) { tokens.push(run); continue; }
		for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
	}
	const latin = s.match(/[a-z0-9_][a-z0-9_.+-]*/g) ?? [];
	for (const w of latin) if (w.length >= 2) tokens.push(w);
	return tokens.filter((t) => !STOPWORDS.has(t));
}

function buildKeywords(entries) {
	const counts = new Map();
	for (const entry of entries) {
		if (entry.kind !== "user") continue;
		for (const token of tokenize(entry.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([t]) => t);
}

function parseTimeExpr(query) {
	const now = new Date();
	const day = 86400000;
	const cn = (offset) => {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0);
		return { from: d.getTime(), to: d.getTime() + day - 1 };
	};
	const q = String(query ?? "");
	if (/今天|今日|today/i.test(q)) return cn(0);
	if (/昨天|昨日|yesterday/i.test(q)) return cn(-1);
	if (/前天|前日/i.test(q)) return cn(-2);
	if (/本周|这周|这个周|this week/i.test(q)) {
		const dow = (now.getDay() + 6) % 7; // 周一=0
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
		return { from: d.getTime(), to: now.getTime() };
	}
	if (/上周|上星期|last week/i.test(q)) {
		const dow = (now.getDay() + 6) % 7;
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 7);
		return { from: start.getTime(), to: start.getTime() + 7 * day - 1 };
	}
	if (/这个月|本月|this month/i.test(q)) {
		const d = new Date(now.getFullYear(), now.getMonth(), 1);
		return { from: d.getTime(), to: now.getTime() };
	}
	if (/上个月|上月|last month/i.test(q)) {
		const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
		const e = new Date(now.getFullYear(), now.getMonth(), 1);
		return { from: d.getTime(), to: e.getTime() - 1 };
	}
	const m = q.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
	if (m) {
		const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
		return { from: d.getTime(), to: d.getTime() + day - 1 };
	}
	const m2 = q.match(/(\d{1,2})月\s*(\d{1,2})[日号]?/);
	if (m2) {
		const d = new Date(now.getFullYear(), Number(m2[1]) - 1, Number(m2[2]));
		return { from: d.getTime(), to: d.getTime() + day - 1 };
	}
	const m3 = q.match(/(\d+)\s*(天|日)前/);
	if (m3) return cn(-Number(m3[1]));
	const m4 = q.match(/(\d+)\s*(周|星期)前/);
	if (m4) {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 * Number(m4[1]));
		return { from: d.getTime(), to: d.getTime() + day - 1 };
	}
	return null;
}

function searchIndex(index, query, limit) {
	const q = String(query ?? "").trim();
	// 空查询 = 列出最近（设置页「列出全部」走这条）
	if (q === "") {
		return [...(index.sessions ?? [])]
			.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
			.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
	}
	const qLower = q.toLowerCase();
	const qTokens = tokenize(q);
	const timeRange = parseTimeExpr(q);
	const now = Date.now();
	const hits = [];
	for (const entry of index.sessions ?? []) {
		let score = 0;
		const title = String(entry.title ?? "").toLowerCase();
		if (title.includes(qLower) && qLower.length >= 2) score += 60;
		const titleTokens = new Set(tokenize(entry.title));
		let overlap = 0;
		for (const token of qTokens) if (titleTokens.has(token)) overlap += 1;
		score += Math.min(overlap, 8) * 12;
		const kw = new Set(entry.keywords ?? []);
		let kwHits = 0;
		for (const token of qTokens) if (kw.has(token)) kwHits += 1;
		score += Math.min(kwHits, 12) * 4;
		if (timeRange != null) {
			const created = Number(entry.createdAt ?? 0);
			const updated = Number(entry.updatedAt ?? 0);
			if ((created >= timeRange.from && created <= timeRange.to) || (updated >= timeRange.from && updated <= timeRange.to)) score += 40;
		}
		const age = Math.max(0, now - Number(entry.updatedAt ?? now));
		score += Math.max(0, 8 - age / (30 * 86400000));
		if (score <= 0) continue;
		hits.push({ score, entry });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, Math.max(1, Math.min(Number(limit) || 5, 20))).map((h) => h.entry);
}

// #endregion

// #region 插件主体

function loadSettingsFile() {
	try {
		const file = path.join(dshHome(), SETTINGS_FILE);
		if (!fs.existsSync(file)) return {};
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return raw != null && typeof raw === "object" ? raw : {};
	} catch (error) {
		logError("settings file unreadable:", error?.message ?? error);
		return {};
	}
}

function saveSettingsFile(settings) {
	try {
		fs.mkdirSync(dshHome(), { recursive: true });
		writeFileAtomic(path.join(dshHome(), SETTINGS_FILE), JSON.stringify(settings, null, 2));
	} catch (error) {
		logError("settings file unwritable:", error?.message ?? error);
	}
}

function applyInner(ctx, config) {
	const patchConfig = (config != null && typeof config === "object") ? config : {};
	const fileSettings = loadSettingsFile();
	const settings = {
		...DEFAULTS,
		...pick(patchConfig, Object.keys(DEFAULTS)),
		...pick(fileSettings, Object.keys(DEFAULTS))
	};
	if (typeof settings.outDir !== "string" || settings.outDir.trim() === "") settings.outDir = resolveDefaultOutDir();
	settings.outDir = path.resolve(settings.outDir);
	if (!Array.isArray(settings.formats) || settings.formats.length === 0) settings.formats = ["md", "jsonl"];
	settings.formats = settings.formats.filter((f) => f === "md" || f === "jsonl");
	settings.intervalSeconds = clampInt(settings.intervalSeconds, 5, 600, 20);
	if (settings.contentMode !== "text") settings.contentMode = "full";
	settings.enabled = settings.enabled !== false;

	const state = {
		settings,
		fingerprints: new Map(), // id → "size:mtimeMs"（非 live 会话）
		contentFps: new Map(),   // id → "events数:末条seq:末条time"（live 会话）
		index: { schema: INDEX_SCHEMA, updatedAt: 0, sessions: [] },
		lastScanAt: 0,
		lastError: "",
		scanning: false,
		savedCount: 0
	};

	// ---- 路径助手 ----
	const outDir = () => state.settings.outDir;
	const indexPath = () => path.join(outDir(), "index.json");

	function loadIndex() {
		try {
			if (!fs.existsSync(indexPath())) return;
			const raw = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
			if (raw != null && typeof raw === "object" && Array.isArray(raw.sessions)) {
				state.index = { schema: INDEX_SCHEMA, updatedAt: Number(raw.updatedAt) || 0, sessions: raw.sessions };
			}
		} catch (error) {
			logError("index unreadable:", error?.message ?? error);
		}
	}

	function saveIndex() {
		try {
			fs.mkdirSync(outDir(), { recursive: true });
			state.index.updatedAt = Date.now();
			writeFileAtomic(indexPath(), JSON.stringify(state.index, null, 2));
		} catch (error) {
			logError("index unwritable:", error?.message ?? error);
		}
	}

	// ---- 会话发现（fs 走查 + sessionQuery 列表取并集）----
	function discoverFromFs() {
		const found = new Map();
		const root = path.join(dshHome(), "sessions");
		let groups;
		try { groups = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
		for (const group of groups) {
			if (!group.isDirectory()) continue;
			const groupDir = path.join(root, group.name);
			let entries;
			try { entries = fs.readdirSync(groupDir, { withFileTypes: true }); } catch { continue; }
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const sessionDir = path.join(groupDir, entry.name);
				const logFile = pickLogFile(sessionDir);
				if (logFile == null) continue;
				try {
					const stat = fs.statSync(logFile);
					found.set(entry.name, { id: entry.name, path: logFile, size: stat.size, mtimeMs: stat.mtimeMs });
				} catch { /* skip */ }
			}
		}
		return found;
	}

	function pickLogFile(sessionDir) {
		let files;
		try { files = fs.readdirSync(sessionDir); } catch { return null; }
		const logs = files.filter((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f));
		if (logs.length === 0) return null;
		const rank = (f) => {
			const m = f.match(/\.v(\d+)\./);
			return m ? Number(m[1]) : 0;
		};
		logs.sort((a, b) => rank(b) - rank(a));
		return path.join(sessionDir, logs[0]);
	}

	async function discoverIds() {
		const ids = new Set(discoverFromFs().keys());
		const live = new Set();
		try {
			const records = await ctx.sessionQuery.listSessions();
			for (const record of records ?? []) {
				const id = record?.header?.id;
				if (typeof id === "string" && id !== "") {
					ids.add(id);
					// live 会话的事件可能在内存里没落盘，必须走内容级指纹
					if (record.live === true) live.add(id);
				}
			}
		} catch (error) {
			logError("listSessions failed:", error?.message ?? error);
		}
		return { ids, live };
	}

	async function readSession(sessionId) {
		try {
			const log = await ctx.sessionQuery.readSession(sessionId);
			const header = log?.session ?? log?.header ?? {};
			const events = Array.isArray(log?.events) ? log.events : [];
			return { header, events };
		} catch (error) {
			logError(`readSession ${id8(sessionId)} failed:`, error?.message ?? error);
			return null;
		}
	}

	// ---- 单会话导出 ----
	function titleOf(events) {
		let title = "";
		for (const ev of events) {
			if (ev?.type === "session/title" && typeof ev.data?.title === "string" && ev.data.title.trim() !== "") {
				title = ev.data.title.trim();
			}
		}
		return title;
	}

	async function exportSession(sessionId, fsInfo, preloaded) {
		const read = preloaded ?? (await readSession(sessionId));
		if (read == null) return null;
		const { header, events } = read;
		if (events.length === 0) return null;
		const title = titleOf(events) || firstUserText(events).slice(0, 30) || "未命名对话";
		const createdAt = Number(header?.createdAt) || firstEventTime(events);
		const session = {
			id: String(header?.id ?? sessionId),
			title,
			createdAt,
			cwd: String(header?.cwd ?? ""),
			agentPreset: String(header?.agentPreset ?? "")
		};
		const entries = renderEntries(events, state.settings.contentMode);
		if (entries.length === 0) return null;
		const stamp = fmtStamp(createdAt);
		const base = `${stamp}_${sanitizeName(title, "未命名对话")}_${id8(session.id)}`;
		const written = { file: "", jsonl: "" };
		try {
			fs.mkdirSync(outDir(), { recursive: true });
			if (state.settings.formats.includes("md")) {
				const file = path.join(outDir(), base + ".md");
				writeFileAtomic(file, renderMarkdown(session, entries, state.settings));
				written.file = file;
			}
			if (state.settings.formats.includes("jsonl")) {
				const file = path.join(outDir(), base + ".jsonl");
				writeFileAtomic(file, renderJsonl(session, entries));
				written.jsonl = file;
			}
		} catch (error) {
			state.lastError = `write failed for ${id8(session.id)}: ${error?.message ?? error}`;
			logError(state.lastError);
			return null;
		}
		// 更新索引
		const lastTime = entries.length > 0 ? Number(entries[entries.length - 1].time) || createdAt : createdAt;
		const turns = entries.reduce((m, e) => Math.max(m, e.turn ?? 0), 0);
		const snippet = firstUserText(events).slice(0, 80);
		const indexEntry = {
			id: session.id, title, createdAt, updatedAt: lastTime, turns,
			cwd: session.cwd, file: written.file, jsonl: written.jsonl,
			keywords: buildKeywords(entries), snippet
		};
		const at = state.index.sessions.findIndex((e) => e.id === session.id);
		if (at >= 0) state.index.sessions[at] = indexEntry;
		else state.index.sessions.push(indexEntry);
		state.savedCount += 1;
		return indexEntry;
	}

	// ---- 扫描主循环 ----
	async function scanOnce() {
		if (state.scanning) return;
		state.scanning = true;
		try {
			if (!state.settings.enabled) { state.lastScanAt = Date.now(); return; }
			const fsMap = discoverFromFs();
			const { ids, live } = await discoverIds();
			let changed = 0;
			for (const id of ids) {
				const info = fsMap.get(id);
				if (live.has(id)) {
					// live 会话：listSessions 标记的活动会话。事件可能只在内存里，
					// fs stat 感知不到；readSession 对 live 返回内存快照（不解 zstd，成本低），
					// 用内容指纹判断是否真变了，没变就什么都不写。
					const read = await readSession(id);
					if (read == null) continue;
					const fp = contentFingerprint(read.events);
					if (state.contentFps.get(id) === fp) continue;
					state.contentFps.set(id, fp);
					const result = await exportSession(id, info, read);
					if (result != null) changed += 1;
					continue;
				}
				const fp = info != null ? `${info.size}:${info.mtimeMs}` : "live";
				if (state.fingerprints.get(id) === fp) continue;
				const before = state.fingerprints.get(id);
				state.fingerprints.set(id, fp);
				const result = await exportSession(id, info);
				if (result != null) changed += 1;
				else if (before === void 0) state.fingerprints.delete(id); // 读失败，下次重试
			}
			if (changed > 0) saveIndex();
			state.lastScanAt = Date.now();
			state.lastError = "";
		} catch (error) {
			state.lastError = error?.message ?? String(error);
			logError("scan failed:", state.lastError);
		} finally {
			state.scanning = false;
		}
	}

	// ---- 对外动作 ----
	async function actionSave(sessionId) {
		await scanOnce();
		const id = String(sessionId ?? "").trim();
		if (id === "") return { ok: true, scanned: true, savedCount: state.savedCount };
		const entry = state.index.sessions.find((e) => e.id === id || id8(e.id) === id);
		if (entry == null) return { ok: false, error: `没有找到会话 ${id8(id) || "(空)"} 的记录；请确认 id 或先运行一次扫描。` };
		return { ok: true, entry };
	}

	function publicState() {
		return {
			ok: true,
			settings: { ...state.settings },
			stats: {
				sessionCount: state.index.sessions.length,
				savedCount: state.savedCount,
				lastScanAt: state.lastScanAt,
				lastError: state.lastError,
				scanning: state.scanning
			},
			outDir: outDir()
		};
	}

	function updateSettings(patch) {
		const next = { ...state.settings };
		if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
		if (patch.intervalSeconds != null) next.intervalSeconds = clampInt(patch.intervalSeconds, 5, 600, 20);
		if (patch.contentMode === "text" || patch.contentMode === "full") next.contentMode = patch.contentMode;
		if (Array.isArray(patch.formats)) {
			const formats = patch.formats.filter((f) => f === "md" || f === "jsonl");
			if (formats.length > 0) next.formats = formats;
		}
		if (typeof patch.outDir === "string" && patch.outDir.trim() !== "") {
			const dir = path.resolve(patch.outDir.trim());
			try { fs.mkdirSync(dir, { recursive: true }); next.outDir = dir; }
			catch (error) { return { ok: false, error: `目录不可用：${error?.message ?? error}` }; }
		}
		state.settings = next;
		saveSettingsFile(pick(next, Object.keys(DEFAULTS)));
		reschedule();
		return { ok: true, state: publicState() };
	}

	// ---- 注册：模型工具 ----
	try {
		ctx.effect(function* () {
			const tools = ctx.tools;
			if (tools == null || typeof tools.register !== "function") return;
			yield tools.register(defineTool({
			name: "conversation_recall",
			description: "用一句自然语言找回过去的对话。当用户用模糊表述指认某个历史对话（如“上次做海报设计的对话”“昨天关于 Verilog 的讨论”“前天让我查文献的那次”）却没有给出 session id 时，调用本工具。返回匹配会话的标题、时间、轮次和记录文件路径；随后可以读取对应的 .md 文件内容，或把路径告知用户。query 直接传用户原话或从中提取的关键词。",
			timeoutMs: 2e4,
			isConcurrencySafe: () => true,
			parameters: {
				query: { type: "string", required: true, description: "用户的原话或关键词，例如“做海报设计”“昨天的对话”。" },
				limit: { type: "number", description: "返回候选数量，默认 5，最大 20。" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						hits: {
							type: "array", required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string", required: true },
									title: { type: "string", required: true },
									createdAt: { type: "string", required: true },
									updatedAt: { type: "string", required: true },
									turns: { type: "number", required: true },
									snippet: { type: "string", required: true },
									file: { type: "string", required: true },
									jsonl: { type: "string", required: true }
								}
							}
						},
						message: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{ type: "text", text: renderRecallText(value) }]
			},
			async execute(args) {
				await scanOnce();
				const hits = searchIndex(state.index, String(args.query ?? ""), args.limit);
				const payload = {
					ok: true,
					hits: hits.map((e) => ({
						id: e.id, title: e.title,
						createdAt: fmtTime(e.createdAt), updatedAt: fmtTime(e.updatedAt),
						turns: e.turns ?? 0, snippet: e.snippet ?? "",
						file: e.file ?? "", jsonl: e.jsonl ?? ""
					})),
					message: hits.length === 0
						? "没有匹配的对话记录。可以换个说法（时间、主题、项目名），或让用户用 /conversations 列出全部。"
						: `找到 ${hits.length} 个候选对话，按匹配度排序。记录文件在 file 字段，可直接读取。`
				};
				return payload;
			}
		}));
	}, "conversation-log: tool");
	} catch (error) {
		logError("tool registration failed:", error?.message ?? error);
	}

	function renderRecallText(value) {
		if (value == null || value.hits == null || value.hits.length === 0) return value?.message ?? "没有匹配。";
		const lines = [value.message, ""];
		for (const [i, hit] of value.hits.entries()) {
			lines.push(`${i + 1}. 《${hit.title}》 · ${hit.createdAt} · ${hit.turns} 轮`);
			if (hit.snippet !== "") lines.push(`   ${hit.snippet}`);
			lines.push(`   记录：${hit.file || "(未生成)"}`);
		}
		return lines.join("\n");
	}

	// ---- 注册：斜杠命令 ----
	try {
		ctx.effect(function* () {
			yield ctx.commands.register({
			name: "conversations",
			description: "检索或列出对话记录（dsh-conversation-log）。用法：/conversations [关键词]",
			handler: async (invocation) => {
				const query = String(invocation?.rawInput ?? "").replace(/^\s*\/?conversations\s*/, "").trim();
				await scanOnce();
				const list = query === ""
					? [...state.index.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 10)
					: searchIndex(state.index, query, 10);
				if (list.length === 0) {
					return { kind: "success", text: query === "" ? "还没有任何对话记录。稍等一会或检查插件开关。" : `没有匹配“${query}”的对话记录。` };
				}
				const lines = [query === "" ? `最近 ${list.length} 个对话记录：` : `匹配“${query}”的 ${list.length} 个对话记录：`, ""];
				for (const [i, e] of list.entries()) {
					lines.push(`${i + 1}. 《${e.title}》 · ${fmtTime(e.createdAt)} · ${e.turns ?? 0} 轮 · ${id8(e.id)}`);
					if (e.snippet) lines.push(`   ${e.snippet}`);
				}
				lines.push("", `记录目录：${outDir()}`);
				return { kind: "success", text: lines.join("\n") };
			}
		});
		yield ctx.commands.register({
			name: "save-conversation",
			description: "立即把当前（或 --id 指定）会话写成对话记录文件",
			handler: async (invocation) => {
				const raw = String(invocation?.rawInput ?? "");
				const idMatch = raw.match(/--id[=\s]+([0-9a-f-]+)/i);
				const sessionId = idMatch ? idMatch[1] : String(invocation?.agent?.session?.id ?? "");
				if (sessionId === "") return { kind: "error", text: "没有当前会话，请用 /save-conversation --id <会话id>。" };
				const result = await actionSave(sessionId);
				if (!result.ok) return { kind: "error", text: result.error };
				const lines = [`已保存《${result.entry.title}》`];
				if (result.entry.file) lines.push(`Markdown：${result.entry.file}`);
				if (result.entry.jsonl) lines.push(`JSONL：${result.entry.jsonl}`);
				return { kind: "success", text: lines.join("\n") };
			}
		});
		}, "conversation-log: commands");
	} catch (error) {
		logError("command registration failed:", error?.message ?? error);
	}

	// ---- 注册：HTTP 路由（客户端桥）----
	try {
		ctx.inject(["webServer"], (hostCtx) => {
		const disposers = [];
		const sameOrigin = (req) => {
			const origin = req.headers.origin;
			if (typeof origin !== "string" || origin === "") return true;
			try { return new URL(origin).host === req.headers.host; } catch { return false; }
		};
		const sendJson = (res, code, body) => {
			const text = JSON.stringify(body);
			res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
			res.end(text);
		};
		const readBody = (req) => new Promise((resolve) => {
			let raw = "";
			req.on("data", (chunk) => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
			req.on("end", () => {
				try { resolve(raw === "" ? {} : JSON.parse(raw)); } catch { resolve({}); }
			});
			req.on("error", () => resolve({}));
		});
		disposers.push(hostCtx.webServer.register({
			kind: "exact", path: `${ROUTE_PREFIX}/state`,
			handler: (req, res) => {
				if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return; }
				sendJson(res, 200, publicState());
			}
		}));
		disposers.push(hostCtx.webServer.register({
			kind: "exact", path: `${ROUTE_PREFIX}/settings`,
			handler: async (req, res) => {
				if (req.method !== "POST" || !sameOrigin(req)) { res.writeHead(req.method === "POST" ? 403 : 405); res.end(); return; }
				const body = await readBody(req);
				const result = updateSettings(body);
				sendJson(res, result.ok ? 200 : 400, result.ok ? result.state : { ok: false, error: result.error });
			}
		}));
		disposers.push(hostCtx.webServer.register({
			kind: "exact", path: `${ROUTE_PREFIX}/search`,
			handler: async (req, res) => {
				if (req.method !== "POST" || !sameOrigin(req)) { res.writeHead(req.method === "POST" ? 403 : 405); res.end(); return; }
				const body = await readBody(req);
				await scanOnce();
				const hits = searchIndex(state.index, String(body.query ?? ""), body.limit).map((e) => ({
					id: e.id, title: e.title, createdAt: fmtTime(e.createdAt), updatedAt: fmtTime(e.updatedAt),
					turns: e.turns ?? 0, snippet: e.snippet ?? "", file: e.file ?? "", jsonl: e.jsonl ?? "", cwd: e.cwd ?? ""
				}));
				sendJson(res, 200, { ok: true, hits, outDir: outDir() });
			}
		}));
		disposers.push(hostCtx.webServer.register({
			kind: "exact", path: `${ROUTE_PREFIX}/save`,
			handler: async (req, res) => {
				if (req.method !== "POST" || !sameOrigin(req)) { res.writeHead(req.method === "POST" ? 403 : 405); res.end(); return; }
				const body = await readBody(req);
				const result = await actionSave(String(body.sessionId ?? ""));
				if (!result.ok) { sendJson(res, 404, { ok: false, error: result.error }); return; }
				sendJson(res, 200, { ok: true, scanned: result.scanned === true, savedCount: result.savedCount ?? state.savedCount, ...publicState() });
			}
		}));
		disposers.push(hostCtx.webServer.register({
			kind: "exact", path: `${ROUTE_PREFIX}/file`,
			handler: (req, res) => {
				if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return; }
				let target;
				try { target = path.resolve(String(new URL(req.url, "http://127.0.0.1").searchParams.get("path") ?? "")); }
				catch { sendJson(res, 400, { ok: false, error: "path 缺失或非法。" }); return; }
				const root = outDir();
				if (!target.startsWith(root + path.sep)) {
					sendJson(res, 400, { ok: false, error: "只允许读取记录目录内的文件。" });
					return;
				}
				try {
					const content = fs.readFileSync(target, "utf8");
					res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
					res.end(content);
				} catch (error) {
					sendJson(res, 404, { ok: false, error: `读取失败：${error?.message ?? error}` });
				}
			}
		}));
		disposers.push(hostCtx.webServer.register({
			kind: "exact", path: `${ROUTE_PREFIX}/reveal`,
			handler: async (req, res) => {
				if (req.method !== "POST" || !sameOrigin(req)) { res.writeHead(req.method === "POST" ? 403 : 405); res.end(); return; }
				const body = await readBody(req);
				const target = path.resolve(String(body.path ?? ""));
				const root = outDir();
				if (!target.startsWith(root + path.sep) && target !== root) {
					sendJson(res, 400, { ok: false, error: "只允许打开记录目录内的文件。" });
					return;
				}
				if (process.platform !== "win32" || !fs.existsSync(target)) {
					sendJson(res, 404, { ok: false, error: "文件不存在或平台不支持。" });
					return;
				}
				execFile("explorer.exe", ["/select," + target], (error) => {
					if (error != null) {
						execFile("explorer.exe", [root], () => sendJson(res, 200, { ok: true }));
						return;
					}
					sendJson(res, 200, { ok: true });
				});
			}
		}));
		return () => { for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } } };
		});
	} catch (error) {
		logError("route registration failed:", error?.message ?? error);
	}

	// ---- 扫描定时器 ----
	let timer = null;
	function reschedule() {
		if (timer != null) { clearInterval(timer); timer = null; }
		if (!state.settings.enabled) return;
		timer = setInterval(() => { scanOnce().catch(() => {}); }, state.settings.intervalSeconds * 1000);
		if (typeof timer.unref === "function") timer.unref();
	}
	try {
		ctx.effect(() => {
			loadIndex();
			reschedule();
			scanOnce().catch(() => {});
			return () => { if (timer != null) { clearInterval(timer); timer = null; } };
		}, "conversation-log: scanner");
	} catch (error) {
		logError("scanner start failed:", error?.message ?? error);
	}

	log(`ready — outDir=${outDir()} interval=${state.settings.intervalSeconds}s mode=${state.settings.contentMode} formats=${state.settings.formats.join("+")}`);
}

function contentFingerprint(events) {
	const last = events.length > 0 ? events[events.length - 1] : null;
	return `${events.length}:${last?.seq ?? ""}:${last?.time ?? ""}`;
}

function pick(source, keys) {
	const out = {};
	for (const key of keys) if (source?.[key] !== void 0) out[key] = source[key];
	return out;
}

function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function firstUserText(events) {
	for (const ev of events) {
		if (ev?.type === "user/message" && isHumanUserMessage(ev.data)) {
			const parts = extractContentParts(ev.data?.content);
			const text = parts.texts.join(" ").trim();
			if (text !== "") return text;
		}
	}
	return "";
}

function firstEventTime(events) {
	for (const ev of events) if (typeof ev?.time === "number") return ev.time;
	return Date.now();
}

export function apply(ctx, config) {
	try {
		applyInner(ctx, config);
	} catch (error) {
		logError("activation failed (plugin stays inert):", error?.message ?? error);
	}
}
