/**
 * Codex Usage Extension
 *
 * Displays ChatGPT/Codex subscription usage beside the active model in the footer.
 * Only shows while the selected model uses the built-in `openai-codex` provider.
 *
 * Usage: pi -e ./codex-usage.ts
 * Then run /codex-usage to refresh manually.
 *
 * Note: This uses a ChatGPT backend usage endpoint that may change without notice.
 */

import { type ExtensionAPI, type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const STATUS_KEY = "codex-usage";

type UsageWindow = {
	usedPercent?: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
};

type UsageSnapshot = {
	planType?: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
};

type UsageResult = { ok: true; snapshot: UsageSnapshot } | { ok: false; message: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseWindow(value: unknown): UsageWindow | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		usedPercent: asNumber(record.used_percent),
		limitWindowSeconds: asNumber(record.limit_window_seconds),
		resetAfterSeconds: asNumber(record.reset_after_seconds),
		resetAt: asNumber(record.reset_at),
	};
}

function parseUsage(value: unknown): UsageSnapshot | undefined {
	const record = asRecord(value);
	const rateLimit = asRecord(record?.rate_limit);
	if (!rateLimit) return undefined;

	return {
		planType: typeof record?.plan_type === "string" ? record.plan_type : undefined,
		primary: parseWindow(rateLimit.primary_window),
		secondary: parseWindow(rateLimit.secondary_window),
	};
}

function formatResetDate(timestamp: number): string | undefined {
	const date = new Date(timestamp);
	if (Number.isNaN(date.valueOf())) return undefined;
	return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function getResetText(window: UsageWindow): string | undefined {
	if (window.resetAt !== undefined) {
		const timestamp = window.resetAt > 1_000_000_000_000 ? window.resetAt : window.resetAt * 1000;
		return formatResetDate(timestamp);
	}
	if (window.resetAfterSeconds !== undefined) {
		return formatResetDate(Date.now() + window.resetAfterSeconds * 1000);
	}
	return undefined;
}

function getRemainingPercent(window: UsageWindow): number | undefined {
	if (window.usedPercent === undefined) return undefined;
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function getWindowLabel(window: UsageWindow, fallback: string): string {
	if (window.limitWindowSeconds !== undefined) {
		if (window.limitWindowSeconds <= 6 * 60 * 60) return "5h";
		if (window.limitWindowSeconds >= 3 * 24 * 60 * 60) return "weekly";
	}
	return fallback;
}

function formatWindow(window: UsageWindow | undefined, fallbackLabel: string): string | undefined {
	if (!window) return undefined;
	const label = getWindowLabel(window, fallbackLabel);
	const remaining = getRemainingPercent(window);
	const percent = remaining === undefined ? "?" : `${Math.round(remaining)}%`;
	const reset = getResetText(window);
	return `${label}:${percent}${reset ? `/${reset}` : ""}`;
}

function formatStatus(snapshot: UsageSnapshot): string {
	const windows = [formatWindow(snapshot.primary, "5h"), formatWindow(snapshot.secondary, "weekly")].filter(
		(value): value is string => value !== undefined,
	);
	return windows.length > 0 ? `Codex ${windows.join(" ")}` : "Codex: unavailable";
}

function formatDetails(snapshot: UsageSnapshot): string {
	const windows = [formatWindow(snapshot.primary, "5h"), formatWindow(snapshot.secondary, "weekly")].filter(
		(value): value is string => value !== undefined,
	);
	const plan = snapshot.planType ? ` (${snapshot.planType})` : "";
	return windows.length > 0 ? `Codex usage${plan}: ${windows.join("; ")}.` : `Codex usage${plan}: unavailable.`;
}

async function fetchUsage(ctx: ExtensionContext): Promise<UsageResult> {
	try {
		const credential = readStoredCredential("openai-codex");
		if (!credential || credential.type !== "oauth") {
			return { ok: false, message: "No stored OpenAI Codex OAuth credentials. Run /login first." };
		}

		const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
		const accessToken = auth?.auth.apiKey;
		const refreshedCredential = readStoredCredential("openai-codex");
		const accountId =
			refreshedCredential?.type === "oauth" && typeof refreshedCredential.accountId === "string"
				? refreshedCredential.accountId
				: undefined;
		if (!accessToken || !accountId) {
			return { ok: false, message: "Codex OAuth credentials are missing accountId. Log in again with /login." };
		}

		const response = await fetch(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			return { ok: false, message: `Usage endpoint returned HTTP ${response.status}.` };
		}

		const payload: unknown = await response.json();
		const snapshot = parseUsage(payload);
		return snapshot ? { ok: true, snapshot } : { ok: false, message: "Usage response format was not recognized." };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Failed to query Codex usage: ${message}` };
	}
}

export default function (pi: ExtensionAPI) {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshInFlight: Promise<UsageResult> | undefined;
	let lastStatusText: string | undefined;

	const isCodexModel = (ctx: ExtensionContext): boolean => ctx.model?.provider === "openai-codex";

	const updateDisplay = (ctx: ExtensionContext, text: string | undefined): void => {
		// Keep /reload compatible with pi processes started before setFooterStatus existed.
		if (typeof ctx.ui.setFooterStatus === "function") {
			ctx.ui.setFooterStatus(STATUS_KEY, text);
		} else {
			ctx.ui.setStatus(STATUS_KEY, text);
		}
	};

	const stopPolling = (ctx: ExtensionContext): void => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		lastStatusText = undefined;
		updateDisplay(ctx, undefined);
	};

	const refresh = async (ctx: ExtensionContext, notify: boolean): Promise<void> => {
		try {
			if (!isCodexModel(ctx)) {
				updateDisplay(ctx, undefined);
				return;
			}
			if (!refreshInFlight) {
				refreshInFlight = fetchUsage(ctx).finally(() => {
					refreshInFlight = undefined;
				});
			}
			const result = await refreshInFlight;

			if (!isCodexModel(ctx)) return;
			if (result.ok) {
				lastStatusText = formatStatus(result.snapshot);
				updateDisplay(ctx, lastStatusText);
				if (notify) ctx.ui.notify(formatDetails(result.snapshot), "info");
			} else {
				updateDisplay(ctx, lastStatusText);
				if (notify) ctx.ui.notify(result.message, "error");
			}
		} catch {
			updateDisplay(ctx, lastStatusText);
		}
	};

	const startPolling = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || !isCodexModel(ctx)) {
			stopPolling(ctx);
			return;
		}
		if (refreshTimer) clearInterval(refreshTimer);
		void refresh(ctx, false);
		refreshTimer = setInterval(() => {
			void refresh(ctx, false);
		}, REFRESH_INTERVAL_MS);
	};

	pi.registerCommand("codex-usage", {
		description: "Refresh and display ChatGPT/Codex subscription usage",
		handler: async (_args, ctx) => {
			if (!isCodexModel(ctx)) {
				stopPolling(ctx);
				ctx.ui.notify("The current model is not using the built-in OpenAI Codex provider.", "info");
				return;
			}
			await refresh(ctx, true);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		startPolling(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		startPolling(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopPolling(ctx);
	});
}
