/**
 * ensureBuilderAgent — provisioning reliability e2e.
 *
 * Reproduces + guards the prod bug: the builder was provisioned with an empty
 * `models` list whenever the live module registry wasn't populated, and the
 * org sentinel then made that broken state permanent. This test process never
 * boots the gateway, so the module registry is empty here too — exactly the
 * prod failure mode. The fix resolves the models list deterministically from
 * `config/providers.json` and repairs builders stuck in the broken state.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BUILDER_AGENT_ID,
	BUILDER_AGENT_SENTINEL,
	ensureBuilderAgent,
} from "../../../auth/builder-provisioning";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/server/src/__tests__/integration/auth → repo root (6 levels up).
const PROVIDERS_JSON = path.resolve(
	HERE,
	"../../../../../../config/providers.json",
);

describe("ensureBuilderAgent — provisioning reliability", () => {
	const sql = getTestDb();
	const CLAUDE_ENV_VARS = [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
	];
	const ZAI_ENV_VARS = ["Z_AI_API_KEY", "ZAI_API_KEY"];
	const prevRegistryPath = process.env.LOBU_PROVIDER_REGISTRY_PATH;
	const prevOpenAI = process.env.OPENAI_API_KEY;
	const prevClaude: Record<string, string | undefined> = {};
	const prevZai: Record<string, string | undefined> = {};

	beforeAll(async () => {
		await cleanupTestDatabase();
		// Provider resolution reads providers.json directly; point it at the
		// repo-root file and give it a system key so `openai` resolves with its
		// declared default model (`gpt-4o`).
		await access(PROVIDERS_JSON); // fail loudly if the path is wrong
		process.env.LOBU_PROVIDER_REGISTRY_PATH = PROVIDERS_JSON;
		process.env.OPENAI_API_KEY = "sk-test-builder-provisioning";
		// Hermetic: clear ambient Claude keys so the openai-pin cases below are
		// deterministic. Claude is now PREFERRED over openai when its key is
		// present (resolveBuilderProviders pins the reliable always-API-key
		// provider first), so a stray ANTHROPIC_API_KEY in the test environment
		// would otherwise flip these expectations from openai/gpt-4o to claude.
		for (const v of CLAUDE_ENV_VARS) {
			prevClaude[v] = process.env[v];
			delete process.env[v];
		}
		for (const v of ZAI_ENV_VARS) {
			prevZai[v] = process.env[v];
			delete process.env[v];
		}
	});

	afterAll(() => {
		if (prevRegistryPath === undefined)
			delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
		else process.env.LOBU_PROVIDER_REGISTRY_PATH = prevRegistryPath;
		if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = prevOpenAI;
		for (const [k, v] of Object.entries(prevClaude)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		for (const [k, v] of Object.entries(prevZai)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	async function readBuilder(orgId: string) {
		const rows = (await sql`
      SELECT models FROM agents
      WHERE organization_id = ${orgId} AND id = ${BUILDER_AGENT_ID} LIMIT 1
    `) as unknown as Array<{
			models: string[] | null;
		}>;
		return rows[0];
	}

	const slugsOf = (models: string[] | null | undefined): string[] =>
		(models ?? []).map((ref) => ref.slice(0, ref.indexOf("/")));

	async function readPointer(orgId: string): Promise<string | null> {
		const rows = (await sql`
      SELECT system_agent_id FROM "organization" WHERE id = ${orgId} LIMIT 1
    `) as unknown as Array<{ system_agent_id: string | null }>;
		return rows[0]?.system_agent_id ?? null;
	}

	it("provisions a builder with a concrete models list even when the module registry is empty", async () => {
		const org = await createTestOrganization({ name: "builder fresh" });
		const res = await ensureBuilderAgent(org.id, sql);

		expect(res.created).toBe(true);
		const b = await readBuilder(org.id);
		expect(b).toBeTruthy();
		expect(Array.isArray(b?.models)).toBe(true);
		expect(b?.models?.length ?? 0).toBeGreaterThan(0);
		expect(slugsOf(b?.models)).toContain("openai");
		// Deterministic default from providers.json (`openai` → its curated
		// defaultModel, currently `gpt-5.6-sol`) at index 0.
		expect(b?.models?.[0]).toBe("openai/gpt-5.6-sol");
		expect(await readPointer(org.id)).toBe(BUILDER_AGENT_ID);
	});

	it("prefers Claude over openai when BOTH system keys are present", async () => {
		// The real-world trap this regression guards: an install carries
		// OPENAI_API_KEY (which can be a ChatGPT/Codex OAuth token that 403s
		// against api.openai.com) AND a real ANTHROPIC_API_KEY. The builder must
		// pin the reliable always-API-key provider (claude), NOT openai/gpt-4o.
		// The prior test only set OPENAI_API_KEY and asserted openai/gpt-4o, so it
		// passed while a co-installed builder was dead on arrival in reality.
		const prev = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-both";
		try {
			const org = await createTestOrganization({ name: "builder both keys" });
			const res = await ensureBuilderAgent(org.id, sql);

			expect(res.created).toBe(true);
			const b = await readBuilder(org.id);
			// openai still lands in the list (its key resolves) but must NOT be the pin.
			expect(slugsOf(b?.models)).toContain("openai");
			// Claude's pin comes from the provider catalog, so adding a current
			// default there must not leave provisioning on a stale code constant.
			expect(b?.models?.[0]).toBe("claude/claude-sonnet-5");
		} finally {
			if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prev;
		}
	});

	it("repairs a builder that was NEVER configured (models NULL), sentinel notwithstanding", async () => {
		const org = await createTestOrganization({ name: "builder broken" });
		// Simulate the prod failure: builder row with models NULL (never
		// configured) and the sentinel already written — the old code skipped on
		// the sentinel and left it broken forever. NOTE: NULL is the broken state;
		// an EMPTY list ([]) is a VALID allow-all policy and is NOT repaired
		// (covered by the dedicated #6 test below).
		await sql`
      INSERT INTO agents (id, organization_id, name, owner_platform, created_at, updated_at)
      VALUES (${BUILDER_AGENT_ID}, ${org.id}, 'Builder', 'external', now(), now())
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
		expect(b?.models?.length ?? 0).toBeGreaterThan(0);
		expect(b?.models?.[0]).toBe("openai/gpt-5.6-sol");
		// Every repaired ref is provider-qualified and concrete (never auto).
		for (const ref of b?.models ?? []) {
			expect(ref.includes("/")).toBe(true);
			expect(ref.split("/").slice(1).join("/")).not.toBe("auto");
		}
	});

	it("provisions a usable builder when ONLY an Anthropic system key is present", async () => {
		// ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN are alternate credentials
		// for the config-driven Claude provider. They must still use that provider's
		// current catalog default rather than a second hardcoded model source.
		// Hermetic: clear EVERY providers.json env var (read from the file so the
		// list can't drift) plus the Claude env vars, then set only Anthropic.
		const raw = JSON.parse(await readFile(PROVIDERS_JSON, "utf-8")) as {
			providers: Array<{ providers?: Array<{ envVarName?: string }> }>;
		};
		const configEnvVars = raw.providers.flatMap((e) =>
			(e.providers ?? []).map((p) => p.envVarName).filter(Boolean),
		) as string[];
		const cleared = [
			...new Set([
				...configEnvVars,
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_AUTH_TOKEN",
				"CLAUDE_CODE_OAUTH_TOKEN",
			]),
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
			expect(slugsOf(b?.models)).toContain("claude");
			expect(b?.models?.[0]).toBe("claude/claude-sonnet-5");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("reconciles a legacy healthy builder: sets pointer + agent_users + sentinel", async () => {
		// A healthy builder row that a partial/legacy create left without a
		// pointer, ownership mapping, or sentinel. The backfill must heal all three.
		const owner = await createTestUser();
		const org = await createTestOrganization({ name: "builder legacy" });
		await sql`
      UPDATE "organization"
      SET metadata = ${JSON.stringify({ personal_org_for_user_id: owner.id })}
      WHERE id = ${org.id}
    `;
		await sql`
      INSERT INTO agents (id, organization_id, name, owner_platform, models, created_at, updated_at)
      VALUES (${BUILDER_AGENT_ID}, ${org.id}, 'Builder', 'external',
        '["openai/gpt-4o"]'::jsonb, now(), now())
    `;

		await ensureBuilderAgent(org.id, sql);

		expect(await readPointer(org.id)).toBe(BUILDER_AGENT_ID);
		const md = (await sql`
      SELECT metadata FROM "organization" WHERE id = ${org.id} LIMIT 1
    `) as unknown as Array<{ metadata: string | null }>;
		expect(
			JSON.parse(md[0]?.metadata ?? "{}")[BUILDER_AGENT_SENTINEL],
		).toBeTruthy();
		const au = (await sql`
      SELECT 1 FROM agent_users
      WHERE organization_id = ${org.id} AND agent_id = ${BUILDER_AGENT_ID}
        AND user_id = ${owner.id}
    `) as unknown as Array<unknown>;
		expect(au.length).toBe(1);
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

	it("heals a healthy builder whose org pointer is NULL (crash between insert and pointer write)", async () => {
		const org = await createTestOrganization({ name: "builder pointerless" });
		await ensureBuilderAgent(org.id, sql); // healthy builder + pointer
		// Simulate a crash that left the row but never wrote the pointer.
		await sql`UPDATE "organization" SET system_agent_id = NULL WHERE id = ${org.id}`;
		expect(await readPointer(org.id)).toBeNull();

		await ensureBuilderAgent(org.id, sql); // fast path must re-set the pointer

		expect(await readPointer(org.id)).toBe(BUILDER_AGENT_ID);
	});

	it("does not clobber a working builder, and never overwrites the models list (idempotent fast path)", async () => {
		const org = await createTestOrganization({ name: "builder idempotent" });
		await ensureBuilderAgent(org.id, sql);
		const before = await readBuilder(org.id);

		const res = await ensureBuilderAgent(org.id, sql);

		expect(res.created).toBe(false);
		const after = await readBuilder(org.id);
		expect(after?.models).toEqual(before?.models);
	});

	it("#6: an EMPTY models list ([]) is a valid allow-all policy and survives provisioning unchanged", async () => {
		// [] means "allow all org + system-key providers" — a deliberate policy,
		// NOT the broken "never configured" (NULL) state. Provisioning must NOT
		// overwrite it back to a system-key list.
		const org = await createTestOrganization({ name: "builder empty-allow" });
		await sql`
      INSERT INTO agents (id, organization_id, name, owner_platform, models, created_at, updated_at)
      VALUES (${BUILDER_AGENT_ID}, ${org.id}, 'Builder', 'external', '[]'::jsonb, now(), now())
    `;

		const res = await ensureBuilderAgent(org.id, sql);

		expect(res.created).toBe(false);
		const b = await readBuilder(org.id);
		// Untouched: still the deliberate empty allow-all list.
		expect(b?.models).toEqual([]);
	});
});
