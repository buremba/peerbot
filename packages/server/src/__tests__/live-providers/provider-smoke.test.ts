/**
 * Live provider smoke test — opt-in, key-gated, replaces the manual pass.
 *
 * The internal plumbing (config parsing, proxy wiring, composed URLs) is
 * covered deterministically by provider-registry-contract.test.ts. What none
 * of that can tell you is the thing that breaks out from under you in prod:
 * "does provider X actually answer today?" — a model gets deprecated, an
 * endpoint moves, an auth scheme changes upstream.
 *
 * This suite walks EVERY provider in config/providers.json and, for each one
 * whose API key is present in the environment, performs a real round-trip:
 *   1. list models            — validates auth + the models endpoint
 *      (skipped for providers with no model-listing surface: z-ai, elevenlabs)
 *   2. chat completion        — validates the OpenAI-compatible chat surface
 *   3. tool-calling (lenient) — validates the agent's primary capability,
 *                               warn-only since model support varies
 *
 * Providers with no key in env are cleanly skipped (describe.skipIf), so the
 * suite grows coverage automatically as keys are added to CI secrets. It does
 * NOT run in the default unit/integration/e2e gates — invoke it explicitly via
 * `make test-providers-live` (or `bun test` on this path).
 *
 * URL construction mirrors production exactly:
 *   - models: ApiKeyProviderModule.fetchModelsGeneric / fetchGeminiModels
 *   - chat:   `${upstreamBaseUrl}/chat/completions` — the worker's OpenAI SDK
 *     appends that path verbatim to its baseURL and the proxy forwards
 *     `upstreamBaseUrl + path` (validated keyless
 *     against the live APIs by provider-keyless.test.ts in this directory)
 * so a passing smoke means the real worker path works, not just some URL.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
// packages/server/src/__tests__/live-providers -> repo root is five levels up.
const repoRoot = resolve(thisDir, "../../../../..");

interface ProviderEntry {
	displayName: string;
	envVarName: string;
	upstreamBaseUrl: string;
	defaultModel?: string;
	modelsEndpoint?: string;
}

const registry = JSON.parse(
	readFileSync(resolve(repoRoot, "config/providers.json"), "utf-8"),
) as { providers: Array<{ id: string; providers?: ProviderEntry[] }> };

const flattened = registry.providers.flatMap((entry) =>
	(entry.providers || []).map((provider) => ({ id: entry.id, provider })),
);

/**
 * Chat models for providers whose registry entry has no defaultModel.
 * Mirrors DEFAULT_PROVIDER_MODELS in agent-worker/src/openclaw/model-resolver.ts
 * (not importable here — agent-worker is not a dependency of server).
 * elevenlabs is voice-only and deliberately absent: with no model, the chat
 * and tool tests below no-op for it.
 */
const FALLBACK_CHAT_MODELS: Record<string, string> = {
	"z-ai": "glm-4.7",
};

/** Resolve the API key for a provider from env (with known aliases). */
function resolveKey(id: string, envVarName: string): string | undefined {
	const direct = process.env[envVarName];
	if (direct) return direct;
	// Historical alias: the memory-loop e2e harness uses ZAI_API_KEY, while the
	// registry declares Z_AI_API_KEY. Accept both so one key covers z-ai.
	if (id === "z-ai") return process.env.ZAI_API_KEY;
	return undefined;
}

const TIMEOUT_MS = 30_000;
setDefaultTimeout(60_000);

async function fetchJson(
	url: string,
	init: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* keep raw text for the error message */
	}
	return { status: res.status, body };
}

/** List model ids, mirroring the module's two model-fetching paths. */
async function listModels(
	id: string,
	p: ProviderEntry,
	key: string,
): Promise<string[]> {
	if (id === "gemini") {
		// Mirrors fetchGeminiModels: native models endpoint, key-in-query auth.
		const url = new URL(
			"https://generativelanguage.googleapis.com/v1beta/models",
		);
		url.searchParams.set("key", key);
		const { status, body } = await fetchJson(url.toString(), { method: "GET" });
		expect(
			status,
			`gemini /models returned ${status}: ${JSON.stringify(body)}`,
		).toBe(200);
		const models = (body as { models?: Array<{ name?: string }> }).models ?? [];
		return models
			.map((m) => m.name?.replace(/^models\//, "").trim())
			.filter((x): x is string => !!x);
	}

	const url = `${p.upstreamBaseUrl.replace(/\/$/, "")}${p.modelsEndpoint}`;
	const { status, body } = await fetchJson(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${key}` },
	});
	expect(
		status,
		`${id} models endpoint returned ${status}: ${JSON.stringify(body)}`,
	).toBe(200);
	const data = (body as { data?: Array<{ id?: string }> }).data ?? [];
	return data.map((m) => m.id?.trim()).filter((x): x is string => !!x);
}

const activeIds = flattened
	.filter(({ id, provider }) => resolveKey(id, provider.envVarName))
	.map(({ id }) => id);
if (activeIds.length === 0) {
	console.warn(
		"[live-providers] no provider keys in env — every provider skipped. " +
			"Set e.g. OPENAI_API_KEY to exercise the live smoke.",
	);
} else {
	console.info(`[live-providers] exercising: ${activeIds.join(", ")}`);
}

for (const { id, provider } of flattened) {
	const key = resolveKey(id, provider.envVarName);
	const canListModels = id === "gemini" || !!provider.modelsEndpoint;

	describe.skipIf(!key)(`live: ${id} (${provider.displayName})`, () => {
		let discoveredModels: string[] = [];

		test.skipIf(!canListModels)("lists models (auth + endpoint)", async () => {
			discoveredModels = await listModels(id, provider, key!);
			expect(
				discoveredModels.length,
				`${id} returned an empty model list`,
			).toBeGreaterThan(0);
		});

		const chatModel = (): string | undefined =>
			provider.defaultModel ?? FALLBACK_CHAT_MODELS[id] ?? discoveredModels[0];
		const chatUrl = `${provider.upstreamBaseUrl.replace(/\/$/, "")}/chat/completions`;

		test("answers a chat completion", async () => {
			const model = chatModel();
			if (!model) {
				console.warn(`[live-providers] ${id}: no chat model — skipping`);
				return;
			}
			const { status, body } = await fetchJson(chatUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: `Bearer ${key}`,
				},
				body: JSON.stringify({
					model,
					messages: [
						{
							role: "user",
							content: "Reply with exactly the single word: pong",
						},
					],
					// Generous cap, not a target: reasoning-default models (gemini-2.5-*)
					// spend "thinking" tokens from this budget before emitting text — at
					// 16 they hit finish_reason=length with zero visible output.
					max_tokens: 1024,
					stream: false,
				}),
			});
			expect(
				status,
				`${id} chat returned ${status}: ${JSON.stringify(body)}`,
			).toBe(200);
			const content = (
				body as { choices?: Array<{ message?: { content?: string } }> }
			).choices?.[0]?.message?.content;
			expect(
				typeof content === "string" && content.trim().length > 0,
				`${id} chat returned no assistant text: ${JSON.stringify(body)}`,
			).toBe(true);
		});

		test("attempts a tool call (lenient — warn-only)", async () => {
			const model = chatModel();
			if (!model) return;
			const { status, body } = await fetchJson(chatUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: `Bearer ${key}`,
				},
				body: JSON.stringify({
					model,
					messages: [
						{
							role: "user",
							content: "What is the weather in Paris? Use the tool.",
						},
					],
					tools: [
						{
							type: "function",
							function: {
								name: "get_weather",
								description: "Get the current weather for a city",
								parameters: {
									type: "object",
									properties: { city: { type: "string" } },
									required: ["city"],
								},
							},
						},
					],
					tool_choice: "auto",
					max_tokens: 1024,
					stream: false,
				}),
			});

			// Tool support varies by provider/model. A non-200 here usually means
			// the provider rejected the optional `tools` payload, not that chat is
			// broken (the chat test above is the hard auth/path assertion).
			if (status !== 200) {
				console.warn(
					`[live-providers] ${id} (${model}) rejected tool_calls with ${status}: ` +
						JSON.stringify(body),
				);
				return;
			}
			const toolCalls = (
				body as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> }
			).choices?.[0]?.message?.tool_calls;
			if (!toolCalls?.length) {
				console.warn(
					`[live-providers] ${id} (${model}) returned no tool_calls — ` +
						"model may not support function calling.",
				);
			}
		});
	});
}
