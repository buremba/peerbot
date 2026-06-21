/**
 * ensureBuilderAgent — provisioning reliability e2e.
 *
 * Reproduces + guards the prod bug: the builder was provisioned with
 * `installed_providers = []` and no model whenever the live module registry
 * wasn't populated, and the org sentinel then made that broken state
 * permanent. This test process never boots the gateway, so the module registry
 * is empty here too — exactly the prod failure mode. The fix resolves
 * providers/model deterministically from `config/providers.json` and repairs
 * builders stuck in the broken state.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BUILDER_AGENT_ID,
	BUILDER_AGENT_SENTINEL,
	ensureBuilderAgent,
} from "../../../auth/builder-provisioning";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/server/src/__tests__/integration/auth → repo root (6 levels up).
const PROVIDERS_JSON = path.resolve(HERE, "../../../../../../config/providers.json");

describe("ensureBuilderAgent — provisioning reliability", () => {
	const sql = getTestDb();
	const prevRegistryPath = process.env.LOBU_PROVIDER_REGISTRY_PATH;
	const prevOpenAI = process.env.OPENAI_API_KEY;

	beforeAll(async () => {
		await cleanupTestDatabase();
		// Provider resolution reads providers.json directly; point it at the
		// repo-root file and give it a system key so `openai` resolves with its
		// declared default model (`gpt-4o`).
		await access(PROVIDERS_JSON); // fail loudly if the path is wrong
		process.env.LOBU_PROVIDER_REGISTRY_PATH = PROVIDERS_JSON;
		process.env.OPENAI_API_KEY = "sk-test-builder-provisioning";
	});

	afterAll(() => {
		if (prevRegistryPath === undefined)
			delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
		else process.env.LOBU_PROVIDER_REGISTRY_PATH = prevRegistryPath;
		if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = prevOpenAI;
	});

	async function readBuilder(orgId: string) {
		const rows = (await sql`
      SELECT installed_providers, model FROM agents
      WHERE organization_id = ${orgId} AND id = ${BUILDER_AGENT_ID} LIMIT 1
    `) as unknown as Array<{
			installed_providers: Array<{ providerId: string }> | null;
			model: string | null;
		}>;
		return rows[0];
	}

	async function readPointer(orgId: string): Promise<string | null> {
		const rows = (await sql`
      SELECT system_agent_id FROM "organization" WHERE id = ${orgId} LIMIT 1
    `) as unknown as Array<{ system_agent_id: string | null }>;
		return rows[0]?.system_agent_id ?? null;
	}

	it("provisions a builder with providers + a pinned model even when the module registry is empty", async () => {
		const org = await createTestOrganization({ name: "builder fresh" });
		const res = await ensureBuilderAgent(org.id, sql);

		expect(res.created).toBe(true);
		const b = await readBuilder(org.id);
		expect(b).toBeTruthy();
		expect(Array.isArray(b?.installed_providers)).toBe(true);
		expect(b?.installed_providers?.length ?? 0).toBeGreaterThan(0);
		expect(
			b?.installed_providers?.some((p) => p.providerId === "openai"),
		).toBe(true);
		// Deterministic default from providers.json (`openai` → `gpt-4o`).
		expect(b?.model).toBe("openai/gpt-4o");
		expect(await readPointer(org.id)).toBe(BUILDER_AGENT_ID);
	});

	it("repairs a builder stuck with empty providers/model (sentinel no longer makes breakage permanent)", async () => {
		const org = await createTestOrganization({ name: "builder broken" });
		// Simulate the prod failure: builder row with no providers/model, and the
		// sentinel already written — the old code skipped on the sentinel and left
		// it broken forever.
		await sql`
      INSERT INTO agents (id, organization_id, name, owner_platform, installed_providers, model, created_at, updated_at)
      VALUES (${BUILDER_AGENT_ID}, ${org.id}, 'Builder', 'external', '[]'::jsonb, NULL, now(), now())
    `;
		await sql`
      UPDATE "organization"
      SET system_agent_id = ${BUILDER_AGENT_ID},
          metadata = ${JSON.stringify({ [BUILDER_AGENT_SENTINEL]: "2026-01-01" })}
      WHERE id = ${org.id}
    `;

		const res = await ensureBuilderAgent(org.id, sql);

		expect(res.created).toBe(false);
		const b = await readBuilder(org.id);
		expect(b?.installed_providers?.length ?? 0).toBeGreaterThan(0);
		expect(b?.model).toBe("openai/gpt-4o");
	});

	it("provisions a usable builder when ONLY an Anthropic system key is present (not in providers.json)", async () => {
		// Anthropic/Claude is the canonical platform key but isn't in
		// providers.json, so this exercises the env-var fallback with an empty
		// registry — the case that would otherwise yield 0 providers / no model.
		const cleared = [
			"OPENAI_API_KEY",
			"GEMINI_API_KEY",
			"Z_AI_API_KEY",
			"GROQ_API_KEY",
			"MISTRAL_API_KEY",
			"DEEPSEEK_API_KEY",
			"COHERE_API_KEY",
			"XAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
		];
		const saved: Record<string, string | undefined> = {};
		for (const v of cleared) {
			saved[v] = process.env[v];
			delete process.env[v];
		}
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-builder";
		try {
			const org = await createTestOrganization({ name: "builder anthropic" });
			const res = await ensureBuilderAgent(org.id, sql);

			expect(res.created).toBe(true);
			const b = await readBuilder(org.id);
			expect(
				b?.installed_providers?.some((p) => p.providerId === "claude"),
			).toBe(true);
			expect(b?.model).toBe("claude/claude-sonnet-4-6");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("does NOT recreate a builder an admin deleted (sentinel set, row absent)", async () => {
		const org = await createTestOrganization({ name: "builder deleted" });
		// Sentinel set + no builder row = admin deleted it; must stay deleted.
		await sql`
      UPDATE "organization"
      SET metadata = ${JSON.stringify({ [BUILDER_AGENT_SENTINEL]: "2026-01-01" })}
      WHERE id = ${org.id}
    `;

		const res = await ensureBuilderAgent(org.id, sql);

		expect(res.created).toBe(false);
		expect(await readBuilder(org.id)).toBeUndefined();
		expect(await readPointer(org.id)).toBeNull();
	});

	it("does not clobber a working builder, and never overwrites the model/providers (idempotent fast path)", async () => {
		const org = await createTestOrganization({ name: "builder idempotent" });
		await ensureBuilderAgent(org.id, sql);
		const before = await readBuilder(org.id);

		const res = await ensureBuilderAgent(org.id, sql);

		expect(res.created).toBe(false);
		const after = await readBuilder(org.id);
		expect(after?.model).toBe(before?.model);
		expect(after?.installed_providers?.length).toBe(
			before?.installed_providers?.length,
		);
	});
});
