/**
 * Usage Extension
 *
 * Global token usage heatmap across all local pi sessions,
 * inspired by codex's /usage command.
 *
 * Command:
 *   /usage    GitHub-style heatmap of daily token usage
 *
 * Data source: all session JSONL files under <agent dir>/sessions/.
 * Counts all usage-bearing entries (assistant messages, toolResult,
 * branch_summary, compaction), including all branch entries (no dedup),
 * matching /session semantics.
 *
 * Results are cached in <agent dir>/usage-cache.json keyed by file
 * mtime+size, so repeated queries only re-parse changed session files.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ============================================================================
// Types
// ============================================================================

interface FileAggregate {
	mtime: number;
	size: number;
	tokens: number;
	byDay: Record<string, number>;
	firstTs: number | undefined;
}

interface UsageCache {
	version: number;
	files: Record<string, FileAggregate>;
}

const CACHE_VERSION = 2;

interface GlobalAggregate {
	tokens: number;
	byDay: Map<string, number>;
	sessionCount: number;
	firstTs: number | undefined;
}

interface UsageEntryLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
}

// ============================================================================
// Paths
// ============================================================================

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return expandTilde(envDir);
	return join(homedir(), ".pi", "agent");
}

function getSessionsDir(): string {
	const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (envDir) return expandTilde(envDir);
	return join(getAgentDir(), "sessions");
}

function getCachePath(): string {
	return join(getAgentDir(), "usage-cache.json");
}

// ============================================================================
// Parsing
// ============================================================================

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function totalTokens(usage: UsageEntryLike): number {
	return asNumber(usage.input) + asNumber(usage.output) + asNumber(usage.cacheRead) + asNumber(usage.cacheWrite);
}

function dayKey(ts: number): string {
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

function entryTimestamp(entry: { timestamp?: unknown }, messageTs: unknown): number {
	if (typeof messageTs === "number" && Number.isFinite(messageTs)) return messageTs;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return NaN;
}

function addToFileAggregate(agg: FileAggregate, usage: UsageEntryLike, ts: number): void {
	const tokens = totalTokens(usage);
	if (tokens === 0) return;

	agg.tokens += tokens;

	if (Number.isFinite(ts)) {
		const day = dayKey(ts);
		agg.byDay[day] = (agg.byDay[day] ?? 0) + tokens;
		if (agg.firstTs === undefined || ts < agg.firstTs) agg.firstTs = ts;
	}
}

function parseSessionContent(content: string): FileAggregate {
	const agg: FileAggregate = {
		mtime: 0,
		size: 0,
		tokens: 0,
		byDay: {},
		firstTs: undefined,
	};

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		if (entry.type === "message") {
			const message = entry.message as Record<string, unknown> | undefined;
			if (!message) continue;
			if (message.role === "assistant" && message.usage) {
				addToFileAggregate(agg, message.usage as UsageEntryLike, entryTimestamp(entry, message.timestamp));
			} else if (message.role === "toolResult" && message.usage) {
				addToFileAggregate(agg, message.usage as UsageEntryLike, entryTimestamp(entry, message.timestamp));
			}
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addToFileAggregate(agg, entry.usage as UsageEntryLike, entryTimestamp(entry, undefined));
		}
	}

	return agg;
}

// ============================================================================
// Cache + scan
// ============================================================================

async function loadCache(): Promise<UsageCache> {
	try {
		const raw = await readFile(getCachePath(), "utf8");
		const parsed = JSON.parse(raw) as UsageCache;
		if (parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === "object") {
			return parsed;
		}
	} catch {
		// Missing or corrupt cache: rebuild from scratch.
	}
	return { version: CACHE_VERSION, files: {} };
}

async function saveCache(cache: UsageCache): Promise<void> {
	try {
		await writeFile(getCachePath(), JSON.stringify(cache), "utf8");
	} catch {
		// Cache is best-effort; never fail the command over it.
	}
}

async function listSessionFiles(): Promise<string[]> {
	const sessionsDir = getSessionsDir();
	let projectDirs: string[];
	try {
		projectDirs = await readdir(sessionsDir);
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const dir of projectDirs) {
		const dirPath = join(sessionsDir, dir);
		let entries: string[];
		try {
			entries = await readdir(dirPath);
		} catch {
			continue;
		}
		for (const file of entries) {
			if (file.endsWith(".jsonl")) files.push(join(dirPath, file));
		}
	}
	return files;
}

async function collectUsage(): Promise<GlobalAggregate> {
	const cache = await loadCache();
	const files = await listSessionFiles();
	const seen = new Set<string>();

	const global: GlobalAggregate = {
		tokens: 0,
		byDay: new Map(),
		sessionCount: 0,
		firstTs: undefined,
	};

	for (const file of files) {
		seen.add(file);
		let fileAgg: FileAggregate | undefined;

		try {
			const st = await stat(file);
			const cached = cache.files[file];
			if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
				fileAgg = cached;
			} else {
				const content = await readFile(file, "utf8");
				fileAgg = parseSessionContent(content);
				fileAgg.mtime = st.mtimeMs;
				fileAgg.size = st.size;
				cache.files[file] = fileAgg;
			}
		} catch {
			// Unreadable file: skip it.
			continue;
		}

		global.sessionCount++;
		global.tokens += fileAgg.tokens;
		for (const [day, tokens] of Object.entries(fileAgg.byDay)) {
			global.byDay.set(day, (global.byDay.get(day) ?? 0) + tokens);
		}
		if (fileAgg.firstTs !== undefined) {
			if (global.firstTs === undefined || fileAgg.firstTs < global.firstTs) {
				global.firstTs = fileAgg.firstTs;
			}
		}
	}

	// Prune cache entries for deleted session files.
	for (const key of Object.keys(cache.files)) {
		if (!seen.has(key)) delete cache.files[key];
	}
	await saveCache(cache);

	return global;
}

// ============================================================================
// Heatmap rendering
// ============================================================================

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
// GitHub-style heatmap greens, darkest to brightest.
const HEAT_COLORS = ["#0e4429", "#006d32", "#26a641", "#39d353"];

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fg24(color: string, text: string): string {
	const r = parseInt(color.slice(1, 3), 16);
	const g = parseInt(color.slice(3, 5), 16);
	const b = parseInt(color.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function startOfWeek(date: Date): Date {
	const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	d.setDate(d.getDate() - d.getDay()); // Sunday-based week
	return d;
}

function addDays(date: Date, days: number): Date {
	const d = new Date(date);
	d.setDate(d.getDate() + days);
	return d;
}

function computeStreak(byDay: Map<string, number>): { current: number; best: number } {
	let best = 0;
	let run = 0;
	let prev: Date | undefined;

	const days = Array.from(byDay.keys()).sort();
	for (const key of days) {
		const date = new Date(`${key}T00:00:00`);
		if (prev && date.getTime() - prev.getTime() === 86_400_000) {
			run++;
		} else {
			run = 1;
		}
		if (run > best) best = run;
		prev = date;
	}

	// Current streak: consecutive active days ending today.
	let current = 0;
	const cursor = new Date();
	cursor.setHours(0, 0, 0, 0);
	while (byDay.has(dayKey(cursor.getTime()))) {
		current++;
		cursor.setDate(cursor.getDate() - 1);
	}

	return { current, best };
}

function renderDailyReport(agg: GlobalAggregate, terminalWidth: number): string {
	const byDay = agg.byDay;
	const lines: string[] = [];

	// Header stats.
	let peakDay: string | undefined;
	let peakTokens = 0;
	for (const [day, tokens] of byDay) {
		if (tokens > peakTokens) {
			peakTokens = tokens;
			peakDay = day;
		}
	}
	const streak = computeStreak(byDay);

	// Grid geometry: columns are weeks, capped by terminal width.
	// Row label " Su " = 4 chars, each cell 2 chars.
	const maxWeeks = Math.max(12, Math.min(53, Math.floor((terminalWidth - 4) / 2)));
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const lastWeekStart = startOfWeek(today);
	const weeks: Date[] = [];
	for (let i = maxWeeks - 1; i >= 0; i--) {
		weeks.push(addDays(lastWeekStart, -7 * i));
	}

	lines.push(`${BOLD}Token activity${RESET} ${DIM}· last ${weeks.length} weeks · ${agg.sessionCount} sessions${
		agg.firstTs !== undefined ? ` · since ${dayKey(agg.firstTs)}` : ""
	}${RESET}`);
	const peakText = peakDay ? `${formatTokens(peakTokens)} (${peakDay})` : "-";
	lines.push(
		`${DIM}Lifetime${RESET} ${formatTokens(agg.tokens)} ${DIM}·${RESET} ${DIM}Peak${RESET} ${peakText} ${DIM}·${RESET} ${DIM}Streak${RESET} ${streak.current}d (best ${streak.best}d)`,
	);
	lines.push("");

	// Month header: write the label at the column where the month changes.
	// Grid cells are 2 chars wide, labels are up to 3 chars and may extend
	// into the following column's space (months are ~4.3 weeks apart).
	const headerChars: string[] = new Array(weeks.length * 2).fill(" ");
	let lastMonth = -1;
	weeks.forEach((weekStart, i) => {
		const month = weekStart.getMonth();
		if (month !== lastMonth) {
			const label = MONTH_LABELS[month].slice(0, 3);
			for (let j = 0; j < label.length && i * 2 + j < headerChars.length; j++) {
				headerChars[i * 2 + j] = label[j];
			}
			lastMonth = month;
		}
	});
	lines.push(`${DIM}${" ".repeat(4)}${headerChars.join("").trimEnd()}${RESET}`);

	// Rows: one per weekday.
	for (let dow = 0; dow < 7; dow++) {
		let row = ` ${DAY_LABELS[dow]} `;
		for (const weekStart of weeks) {
			const day = addDays(weekStart, dow);
			const key = dayKey(day.getTime());
			const tokens = byDay.get(key) ?? 0;
			if (day.getTime() > today.getTime()) {
				row += "  ";
			} else if (tokens === 0) {
				row += `${DIM}·${RESET} `;
			} else {
				const ratio = peakTokens > 0 ? tokens / peakTokens : 0;
				const level = ratio > 2 / 3 ? 3 : ratio > 1 / 3 ? 2 : 1;
				row += `${fg24(HEAT_COLORS[level], "■")} `;
			}
		}
		lines.push(row);
	}

	// Legend.
	const legendCells = [
		`${DIM}·${RESET}`,
		fg24(HEAT_COLORS[1], "■"),
		fg24(HEAT_COLORS[2], "■"),
		fg24(HEAT_COLORS[3], "■"),
	];
	lines.push("");
	lines.push(`  ${DIM}Less${RESET} ${legendCells.join(" ")} ${DIM}More${RESET}`);

	return lines.join("\n");
}

// ============================================================================
// Extension entry
// ============================================================================

const CUSTOM_TYPE = "usage-report";

export default function usageExtension(pi: ExtensionAPI) {
	// Render usage reports as plain preformatted text (preserves ANSI colors
	// and heatmap alignment). Without this, the default renderer would treat
	// the content as markdown inside a box.
	pi.registerMessageRenderer(CUSTOM_TYPE, (message) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(content, 0, 0);
	});

	pi.registerCommand("usage", {
		description: "Show a heatmap of daily token usage across all sessions",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("usage", "Scanning sessions...");
			let report: string;
			try {
				const agg = await collectUsage();
				const width = process.stdout.columns || 80;
				report = renderDailyReport(agg, width);
			} catch (error) {
				ctx.ui.setStatus("usage", "");
				ctx.ui.notify(`usage: failed to scan sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			ctx.ui.setStatus("usage", "");
			pi.sendMessage({ customType: CUSTOM_TYPE, content: report, display: true });
		},
	});
}
