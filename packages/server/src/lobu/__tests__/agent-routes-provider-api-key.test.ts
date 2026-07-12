/**
 * Resolver-cutover contract for `PUT /:agentId/providers/:providerId/api-key`
 * (issue #1868): the apply-pushed org provider key must land as an
 * `inference_providers` row + row-unique `<slug>-<id>` agent_secrets entry —
 * the same shape `backfill-inference-providers` produces — and must NOT write
 * the legacy `provider:<id>:apiKey` name anymore.
 *
 * Read-path invariants covered here too:
 *   - `readOrgSharedProviderApiKey` (tier 2 of the worker credential chain and
 *     the egress secret-proxy fallback) resolves the NEW shape;
 *   - pre-existing legacy `provider:<id>:apiKey` rows still resolve (read-only
 *     fallback stays until the fleet is converged);
 *   - when both exist (backfilled orgs), the row-unique secret wins — rotations
 *     only ever touch the row secret, so the legacy copy can go stale.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { decrypt, encrypt } from "@lobu/core";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { orgContext } from "../stores/org-context";
import { authStash, installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();

const ORG = "org-provider-key";
const AGENT = "agent-provider-key";

let app: import("hono").Hono;
let sql: ReturnType<typeof import("../../db/client.js").getDb>;
let readOrgSharedProviderApiKey: typeof import("../stores/provider-secrets.js").readOrgSharedProviderApiKey;

beforeAll(async () => {
	await ensureDbForGatewayTests();
	const routes = await import("../agent-routes.js");
	app = routes.agentRoutes;
	const dbClient = await import("../../db/client.js");
	sql = dbClient.getDb();
	({ readOrgSharedProviderApiKey } = await import(
		"../stores/provider-secrets.js"
	));
}, 60_000);

beforeEach(async () => {
	await resetTestDatabase();
	await seedAgentRow(AGENT, { organizationId: ORG });
	// The route's fire-and-forget config-audit event FKs events.created_by →
	// "user".id; seed the actor so the audit insert doesn't spam retry noise.
	await sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
		VALUES ('u1', 'Test', 'u1@t', true, now(), now())
		ON CONFLICT (id) DO NOTHING
	`;
	authStash.user = { id: "u1", name: "T", email: "u1@t", emailVerified: true };
	authStash.organizationId = ORG;
	authStash.authSource = "session";
	authStash.mcpAuthInfo = null;
});

afterAll(async () => {
	const { closeDbSingleton } = await import("../../db/client.js");
	await closeDbSingleton();
});

async function putKey(providerId: string, value: unknown) {
	return app.request(
		`/${AGENT}/providers/${encodeURIComponent(providerId)}/api-key`,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value }),
		},
	);
}

async function providerRows(slug: string) {
	return (await sql`
		SELECT id, slug, kind, api_key_ref, capabilities, deleted_at
		FROM inference_providers
		WHERE organization_id = ${ORG} AND slug = ${slug}
	`) as Array<{
		id: string | number;
		slug: string;
		kind: string;
		api_key_ref: string;
		capabilities: Record<string, unknown>;
		deleted_at: string | null;
	}>;
}

async function secretRows(pattern: string) {
	return (await sql`
		SELECT name, ciphertext FROM agent_secrets
		WHERE organization_id = ${ORG} AND name LIKE ${pattern}
	`) as Array<{ name: string; ciphertext: string }>;
}

describe("PUT /:agentId/providers/:providerId/api-key (resolver cutover)", () => {
	test("creates an inference_providers row + row-unique secret, no legacy row", async () => {
		const res = await putKey("z-ai", "zai-key-1");
		expect(res.status).toBe(200);

		const rows = await providerRows("z-ai");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.kind).toBe("z-ai");
		expect(row.capabilities).toEqual({});
		expect(row.deleted_at).toBeNull();
		expect(row.api_key_ref).toBe(`secret://${ORG}/z-ai-${row.id}`);

		const secrets = await secretRows(`z-ai-${row.id}`);
		expect(secrets).toHaveLength(1);
		expect(decrypt(secrets[0].ciphertext)).toBe("zai-key-1");

		// The legacy writer is gone: no provider:<id>:apiKey row.
		expect(await secretRows("provider:%")).toHaveLength(0);

		// Worker-visible tier-2 read resolves the new shape.
		expect(await readOrgSharedProviderApiKey("z-ai", ORG)).toBe("zai-key-1");
	});

	test("second PUT rotates the ciphertext in place — no duplicate row or secret", async () => {
		expect((await putKey("z-ai", "zai-key-1")).status).toBe(200);
		const [first] = await providerRows("z-ai");

		expect((await putKey("z-ai", "zai-key-2")).status).toBe(200);
		const rows = await providerRows("z-ai");
		expect(rows).toHaveLength(1);
		expect(String(rows[0].id)).toBe(String(first.id));

		const secrets = await secretRows("z-ai-%");
		expect(secrets).toHaveLength(1);
		expect(decrypt(secrets[0].ciphertext)).toBe("zai-key-2");
		expect(await secretRows("provider:%")).toHaveLength(0);
		expect(await readOrgSharedProviderApiKey("z-ai", ORG)).toBe("zai-key-2");
	});

	test("invalid provider slug → 400, nothing written anywhere", async () => {
		const res = await putKey("Not_A-Valid.Slug", "some-key");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("provider id");

		expect(await providerRows("Not_A-Valid.Slug")).toHaveLength(0);
		expect(await secretRows("%")).toHaveLength(0);
	});

	test("404 for an unknown agent is preserved", async () => {
		const res = await app.request(
			"/nope-agent/providers/z-ai/api-key",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "k" }),
			},
		);
		expect(res.status).toBe(404);
	});

	test("pre-existing legacy provider:<id>:apiKey rows still resolve (read-only fallback)", async () => {
		await sql`
			INSERT INTO agent_secrets (organization_id, name, ciphertext)
			VALUES (${ORG}, ${"provider:legacy-prov:apiKey"}, ${encrypt("legacy-value")})
		`;
		expect(await readOrgSharedProviderApiKey("legacy-prov", ORG)).toBe(
			"legacy-value",
		);
	});

	test("row-unique secret outranks a stale legacy row after rotation", async () => {
		// Backfilled org: legacy row exists. A post-cutover rotation touches only
		// the row-unique secret; the read must return the fresh value.
		await sql`
			INSERT INTO agent_secrets (organization_id, name, ciphertext)
			VALUES (${ORG}, ${"provider:z-ai:apiKey"}, ${encrypt("stale-value")})
		`;
		expect((await putKey("z-ai", "fresh-value")).status).toBe(200);
		expect(await readOrgSharedProviderApiKey("z-ai", ORG)).toBe("fresh-value");
		// And the legacy row was NOT rewritten by the new writer.
		const legacy = await secretRows("provider:z-ai:apiKey");
		expect(legacy).toHaveLength(1);
		expect(decrypt(legacy[0].ciphertext)).toBe("stale-value");
	});

	test("two concurrent PUTs for a fresh slug converge on one row", async () => {
		const [a, b] = await Promise.all([
			putKey("openrouter", "k-a"),
			putKey("openrouter", "k-b"),
		]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);

		const rows = await providerRows("openrouter");
		expect(rows).toHaveLength(1);
		const secrets = await secretRows("openrouter-%");
		expect(secrets).toHaveLength(1);
		// One of the two values won; either is fine — but it must decrypt.
		expect(["k-a", "k-b"]).toContain(decrypt(secrets[0].ciphertext));
		expect(await secretRows("provider:%")).toHaveLength(0);
	});
});

describe("readOrgSharedProviderApiKey org scoping (new shape)", () => {
	test("does not leak another org's row-unique secret", async () => {
		expect((await putKey("z-ai", "org-a-key")).status).toBe(200);
		await orgContext.run({ organizationId: "other-org" }, async () => {
			expect(await readOrgSharedProviderApiKey("z-ai", "other-org")).toBeNull();
		});
	});
});
