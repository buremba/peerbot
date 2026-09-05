/**
 * `entities.create` forwards every contract field the handler honors.
 *
 * The namespace used to rebuild the payload from a hand-written field list, so
 * `domain`, `category`, `platform_type`, `main_market`, `market` and `link` —
 * accepted by `manage_entity` and merged into the row's metadata by
 * `handleCreate` — were silently dropped, and so was `entity_type`, the name
 * the contract itself declares (and the one `entities.list` accepts). The
 * payload now passes straight through; `type` survives as a registered alias
 * for the callers that guess it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { buildClientSDK, type ClientSDK } from "../../../sandbox/client-sdk";
import type { EntityCreateInput } from "../../../sandbox/namespaces/entities";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
	seedSystemEntityTypes,
} from "../../setup/test-fixtures";

const testEnv: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
};

const profile = {
	domain: "acme.example",
	category: "saas",
	platform_type: "b2b",
	main_market: "US",
	market: "DE",
	link: "https://acme.example",
};

describe("ClientSDK entities.create field pass-through", () => {
	let sdk: ClientSDK;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await seedSystemEntityTypes();
		await initWorkspaceProvider();
		const org = await createTestOrganization({
			name: "Passthrough Org",
			slug: "passthrough-sdk",
		});
		const user = await createTestUser({
			email: "passthrough-sdk@test.example.com",
		});
		await addUserToOrganization(user.id, org.id, "owner");
		const ctx: ToolContext = {
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			scopedToOrg: false,
			allowCrossOrg: true,
		};
		sdk = buildClientSDK(ctx, testEnv);
		await sdk.entitySchema.createType({ slug: "vendor", name: "Vendor" });
	});

	it("persists the profile fields the handler accepts", async () => {
		const result = (await sdk.entities.create({
			entity_type: "vendor",
			name: "Passthrough Co",
			...profile,
		})) as { entity: { id: number; entity_type: string } };
		expect(result.entity.entity_type).toBe("vendor");
		// `createEntity` folds the convenience fields into the row's metadata.
		// Assert on the stored row rather than the handler's echo, so this proves
		// persistence and not just an argument round-trip.
		const rows = await getTestDb()`
			SELECT metadata FROM entities WHERE id = ${result.entity.id}`;
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata).toMatchObject(profile);
	});

	it("accepts `type` as an alias for `entity_type`", async () => {
		const result = (await sdk.entities.create({
			type: "vendor",
			name: "Alias Co",
		} as unknown as EntityCreateInput)) as { entity: { entity_type: string } };
		expect(result.entity.entity_type).toBe("vendor");
	});

	it("rejects a field the contract does not accept instead of dropping it", async () => {
		await expect(
			sdk.entities.create({
				entity_type: "vendor",
				name: "Bogus Co",
				identities: [],
			} as unknown as EntityCreateInput),
		).rejects.toThrow(/unknown argument\(s\): identities/);
	});
});
