/**
 * `GET /sandboxes` → `providerCatalog` shape contract.
 *
 * The catalog exists so the create form can render a provider's credential
 * fields without hardcoding them. It is display metadata only: it must never
 * carry a credential VALUE, and it must not echo `systemEnvVar` — that names a
 * deployment-wide env var and is operator detail, not something the browser
 * needs in order to draw a form.
 *
 * Drives the REAL mounted route rather than a copy of its projection: a test
 * that re-implements the mapping still passes when the route starts spreading
 * the raw registry field, which is exactly the leak being guarded against.
 * The sandbox store is stubbed so this stays a unit test (no DB); the runtime
 * registry is the real one, so a new provider or field is covered for free.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { authStash, installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();

// The catalog is built from the registry alone, but GET / also lists rows.
// Stub the store so the route runs without a database.
mock.module("../stores/sandbox-store", () => ({
	listSandboxes: async () => [],
	createSandbox: async () => undefined,
	deleteSandbox: async () => undefined,
	setSandboxCredentialName: async () => undefined,
}));
// Spread the real module: other route modules pull further exports from it,
// and a narrow stub breaks their imports rather than this test's.
const realProviderSecrets = await import("../stores/provider-secrets.js");
mock.module("../stores/provider-secrets", () => ({
	...realProviderSecrets,
	readSandboxSecret: async () => null,
	writeSandboxSecret: async () => undefined,
}));

const { sandboxRoutes } = await import("../sandbox-routes.js");
const { listGatewayRuntimeProviderIds } = await import(
	"../../gateway/runtime/index.js"
);

const ALLOWED_FIELD_KEYS = ["key", "label", "required", "secret"].sort();

interface CatalogEntry {
	id: string;
	credentialFields: Record<string, unknown>[];
}

async function fetchProviderCatalog(): Promise<CatalogEntry[]> {
	const res = await sandboxRoutes.request("/", { method: "GET" });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { providerCatalog?: CatalogEntry[] };
	expect(Array.isArray(body.providerCatalog)).toBe(true);
	return body.providerCatalog ?? [];
}

describe("GET /sandboxes providerCatalog contract", () => {
	beforeEach(() => {
		authStash.organizationId = "org-sandbox-catalog";
		authStash.authSource = "session";
	});

	test("exposes every registered runtime provider", async () => {
		const catalog = await fetchProviderCatalog();
		expect(catalog.map((e) => e.id).sort()).toEqual(
			listGatewayRuntimeProviderIds().sort(),
		);
		expect(catalog.length).toBeGreaterThan(0);
	});

	test("emits only display metadata — never systemEnvVar or a credential value", async () => {
		const catalog = await fetchProviderCatalog();
		// Guard the guard: a catalog with no fields would pass vacuously.
		expect(catalog.some((e) => e.credentialFields.length > 0)).toBe(true);

		for (const entry of catalog) {
			for (const field of entry.credentialFields) {
				expect(Object.keys(field).sort()).toEqual(ALLOWED_FIELD_KEYS);
				expect(field).not.toHaveProperty("systemEnvVar");
				expect(field).not.toHaveProperty("value");
			}
		}
	});

	test("keeps the secret flag, so the form still masks token inputs", async () => {
		const catalog = await fetchProviderCatalog();
		const vercel = catalog.find((e) => e.id === "vercel");
		expect(vercel).toBeTruthy();
		const token = vercel?.credentialFields.find((f) => f.key === "token");
		expect(token?.secret).toBe(true);
	});
});
