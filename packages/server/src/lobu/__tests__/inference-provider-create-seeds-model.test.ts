/** Route coverage for seeding a catalog default text model at provider create. */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { __resetEncryptionKeyCacheForTests } from "@lobu/core";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { authStash, installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORG = "org-create-seed";
const USER = "u-create-seed";
let savedEncryptionKey: string | undefined;
let savedRegistryPath: string | undefined;

beforeAll(async () => {
	savedEncryptionKey = process.env.ENCRYPTION_KEY;
	savedRegistryPath = process.env.LOBU_PROVIDER_REGISTRY_PATH;
	await ensureDbForGatewayTests();
	process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
	__resetEncryptionKeyCacheForTests();
	// The route resolves the registry via cwd/config/providers.json, which is the
	// REPO root — not packages/server, where the test runs. Point at the real
	// file so the seed reads the same catalog defaults production does.
	process.env.LOBU_PROVIDER_REGISTRY_PATH = new URL(
		"../../../../../config/providers.json",
		import.meta.url,
	).pathname;
}, 60_000);

afterAll(() => {
	if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
	else process.env.ENCRYPTION_KEY = savedEncryptionKey;
	if (savedRegistryPath === undefined)
		delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
	else process.env.LOBU_PROVIDER_REGISTRY_PATH = savedRegistryPath;
	__resetEncryptionKeyCacheForTests();
});

async function seedOrg(): Promise<void> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${USER}, 'Test', 'cs@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
	await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createProvider(body: Record<string, unknown>): Promise<Response> {
	const mod = await import("../agent-routes.js");
	return await mod.agentRoutes.request("/inference-providers", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readCapabilities(slug: string): Promise<unknown> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	const rows = (await sql`
    SELECT capabilities FROM inference_providers
    WHERE organization_id = ${ORG} AND slug = ${slug} AND deleted_at IS NULL
    LIMIT 1
  `) as Array<{ capabilities: unknown }>;
	return rows[0]?.capabilities;
}

describe("POST /inference-providers seeds a routable text model", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg();
		authStash.user = {
			id: USER,
			name: "Test",
			email: "cs@test",
			emailVerified: true,
		};
		authStash.organizationId = ORG;
		authStash.authSource = "session";
		authStash.mcpAuthInfo = null;
	});

	test("a catalog provider created with NO capabilities gets the catalog default model", async () => {
		const res = await createProvider({
			slug: "gemini",
			kind: "gemini",
			apiKey: "AIza-test",
		});
		expect(res.status).toBe(201);

		// Without the seed this remains `{}` and cannot become the org default.
		const capabilities = (await readCapabilities("gemini")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBe("gemini-2.5-pro");
	});

	test("an explicitly requested model is NOT overwritten by the catalog default", async () => {
		const res = await createProvider({
			slug: "gemini",
			kind: "gemini",
			apiKey: "AIza-test",
			capabilities: { text: { model: "gemini-2.5-flash" } },
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("gemini")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBe("gemini-2.5-flash");
	});

	test("a caller-supplied base_url survives seeding", async () => {
		// Seeding must MERGE into the caller's text block, never replace it —
		// dropping a tenant upstream would silently re-point the org at the
		// catalog URL.
		const res = await createProvider({
			slug: "my-upstream",
			kind: "gemini",
			apiKey: "AIza-test",
			capabilities: { text: { base_url: "https://tenant.example.com/v1" } },
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("my-upstream")) as {
			text?: { model?: string; base_url?: string };
		};
		expect(capabilities?.text?.base_url).toBe("https://tenant.example.com/v1");
		expect(capabilities?.text?.model).toBe("gemini-2.5-pro");
	});

	test("an ALIAS slug with no base_url is NOT seeded and does NOT become the org default", async () => {
		// `getModelPolicy` keys its module map by SLUG: "my-gemini" matches no
		// static module, and with no `text.base_url` there is nothing to
		// synthesize either — so the row cannot route. Seeding it would be worse
		// than useless: a text model is the predicate the org-default promotion
		// uses, so an unroutable row would become the default for every
		// allow-all agent in the org.
		const res = await createProvider({
			slug: "my-gemini",
			kind: "gemini",
			apiKey: "AIza-test",
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("my-gemini")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBeUndefined();

		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const rows = (await sql`
      SELECT is_default FROM inference_providers
      WHERE organization_id = ${ORG} AND slug = 'my-gemini' AND deleted_at IS NULL
    `) as Array<{ is_default: boolean }>;
		expect(rows[0]?.is_default).toBe(false);
	});

	test("an alias slug WITH a base_url is seeded — synthesis can route it", async () => {
		const res = await createProvider({
			slug: "my-gemini-2",
			kind: "gemini",
			apiKey: "AIza-test",
			capabilities: { text: { base_url: "https://tenant.example.com/v1" } },
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("my-gemini-2")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBe("gemini-2.5-pro");
	});

	test("an unknown kind with no model is still created (no catalog default to seed)", async () => {
		const res = await createProvider({
			slug: "custom-thing",
			kind: "some-unlisted-endpoint",
			apiKey: "sk-custom",
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("custom-thing")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBeUndefined();
	});
});
