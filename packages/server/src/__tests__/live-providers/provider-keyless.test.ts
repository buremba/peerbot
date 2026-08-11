/**
 * Keyless provider validation — network-gated, but needs NO API keys.
 *
 * The oracle is each provider's own live API, exploited through two facts:
 *   1. An unauthenticated request to the protocol-correct path is rejected
 *      before inference. A 404/405 catches an upstream route that disappeared.
 *      Exact protocol serialization is covered deterministically by the worker
 *      adapter E2E; this network check only detects upstream drift.
 *   2. Some providers serve their model catalog publicly. When the models
 *      endpoint answers 200 with a non-empty list, the configured
 *      defaultModel must be in it — which catches model deprecations (this
 *      check found nvidia's kimi-k2.5 and opencode-zen's
 *      anthropic/claude-sonnet-4 already dead upstream). Auth-gated catalogs
 *      are skipped automatically, so nothing here is hardcoded per provider.
 *
 * Everything is derived from config/providers.json, mirroring production
 * composition: completion path comes from the production adapter protocol;
 * models =
 * `upstreamBaseUrl + modelsEndpoint` (fetchModelsGeneric).
 *
 * Runs as part of `make test-providers-live` (this directory) — so even a
 * zero-key invocation validates every endpoint and every publicly listed
 * defaultModel. Excluded from the default CI gates (needs network).
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SdkCompat } from "@lobu/core";
import { providerCompletionUrl } from "./provider-protocol.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../../..");

interface ProviderEntry {
	displayName: string;
	upstreamBaseUrl: string;
	defaultModel?: string;
	modelsEndpoint?: string;
	sdkCompat?: SdkCompat;
}

const registry = JSON.parse(
	readFileSync(resolve(repoRoot, "config/providers.json"), "utf-8"),
) as { providers: Array<{ id: string; providers?: ProviderEntry[] }> };

const flattened = registry.providers.flatMap((entry) =>
	(entry.providers || []).map((provider) => ({ id: entry.id, provider })),
);

const TIMEOUT_MS = 20_000;
setDefaultTimeout(60_000);

async function probe(
	url: string,
	init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	let body: unknown = await res.text();
	try {
		body = JSON.parse(body as string);
	} catch {
		/* non-JSON is fine for status-only checks */
	}
	return { status: res.status, body };
}

for (const { id, provider } of flattened) {
	const base = provider.upstreamBaseUrl.replace(/\/$/, "");
	const completionUrl = providerCompletionUrl(id, provider);

	describe(`keyless: ${id} (${provider.displayName})`, () => {
		test(
			"completion endpoint exists (route must not 404)",
			async () => {
				const { status } = await probe(completionUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				expect(
					[404, 405].includes(status),
					`${id} completion route ${completionUrl} answered ${status} — ` +
						"the composed URL does not exist upstream",
				).toBe(false);
			},
		);

		test.skipIf(!provider.modelsEndpoint)(
			"models endpoint exists; public catalogs must contain defaultModel",
			async () => {
				const url = `${base}${provider.modelsEndpoint}`;
				const { status, body } = await probe(url);
				expect(
					[404, 405].includes(status),
					`${id} models route ${url} answered ${status} — ` +
						"the composed URL does not exist upstream",
				).toBe(false);

				// Auth-gated catalogs (401/403) tell us nothing more — done.
				if (status !== 200) return;
				const ids = ((body as { data?: Array<{ id?: string }> }).data ?? [])
					.map((m) => m.id)
					.filter((x): x is string => !!x);
				// Some providers answer 200 with an empty list when unauthenticated
				// (e.g. perplexity) — an empty catalog proves nothing, skip.
				if (ids.length === 0 || !provider.defaultModel) return;

				// Mirror resolveModelRef: a leading "<provider-id>/" self-prefix is
				// stripped before the model id goes on the wire. Some providers
				// namespace their public catalog with their own prefix (perplexity
				// lists "perplexity/sonar" for wire id "sonar"), so accept either.
				const wireModel = provider.defaultModel.startsWith(`${id}/`)
					? provider.defaultModel.slice(id.length + 1)
					: provider.defaultModel;
				expect(
					ids.includes(wireModel) || ids.includes(`${id}/${wireModel}`),
					`${id}: defaultModel "${wireModel}" is not in the provider's ` +
						`public catalog (${ids.length} models) — likely deprecated`,
				).toBe(true);
			},
		);
	});
}
