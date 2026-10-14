import { describe, expect, it } from "vitest";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"google-generative-ai"> = {
	id: "gemini-4-argon-contributor",
	name: "Gemini 4 Argon Contributor",
	api: "google-generative-ai",
	provider: "opencode-go",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	thinkingLevelMap: { low: "low", high: "high" },
	input: ["text"],
	cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 65536,
};

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

describe("OpenCode Go Google API dispatch", () => {
	it.each(["stream", "streamSimple"] as const)("routes %s to Google without a network request", async (method) => {
		const provider = opencodeGoProvider();
		let captured = false;
		const result = await provider[method](model, context, {
			apiKey: "test",
			sessionId: "test-conversation",
			onPayload: () => {
				captured = true;
				throw new Error("payload captured");
			},
		}).result();

		expect(captured).toBe(true);
		expect(result.errorMessage).toContain("payload captured");
	});
});
