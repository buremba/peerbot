/**
 * The public-org REST carve-out at `MultiTenantProvider.resolveAuth` used to be
 * reachable only by a JSON POST that named a tool.
 * A `GET /api/{org}/runs` carried no tool name, so it was refused even though
 * `POST /api/{org}/manage_operations {"action":"list_runs"}` served the same
 * rows anonymously — same data, two doors, opposite answers.
 *
 * These tests pin both transport gates: which requests `mcpAuth` admits and
 * which registered tools the generic REST dispatcher may execute.
 */

import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { mcpAuth } from "../../auth/middleware";
import { REST_TOOL_GET_ROUTES } from "../../http/rest-tool-routes";
import type { Env } from "../../index";
import { restToolProxy } from "../../rest-api";
import { initWorkspaceProvider } from "../../workspace";
import { clearMultiTenantCachesForTests } from "../../workspace/multi-tenant-caches";
import { cleanupTestDatabase } from "../setup/test-db";
import { createTestOrganization } from "../setup/test-fixtures";

const testEnv: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

/**
 * Mirrors production route registration: the declared proxies come from the
 * table, and an undeclared sibling (`/agents`) is mounted alongside so the
 * "declared vs merely public-org" distinction is actually under test.
 */
function buildApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	const reached = (c: { json: (v: unknown) => Response }) =>
		c.json({ reachedHandler: true });

	app.use("/*", async (_c, next) => next());
	for (const route of REST_TOOL_GET_ROUTES) {
		app.get(route.routePath, mcpAuth, reached);
	}
	app.get("/api/:orgSlug/agents", mcpAuth, reached);
	app.post("/api/:orgSlug/:toolName", mcpAuth, reached);
	app.get("*", (c) => c.json({ catchAll: true }, 404));
	return app;
}

describe("public-org REST transport parity", () => {
	let app: Hono<{ Bindings: Env }>;
	let publicSlug: string;
	let privateSlug: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		clearMultiTenantCachesForTests();
		await initWorkspaceProvider();
		app = buildApp();
		publicSlug = (
			await createTestOrganization({
				name: "Public Transport Org",
				visibility: "public",
			})
		).slug;
		privateSlug = (
			await createTestOrganization({
				name: "Private Transport Org",
				visibility: "private",
			})
		).slug;
	});

	async function anonymousGet(path: string): Promise<number> {
		const res = await app.request(path, { method: "GET" }, testEnv);
		return res.status;
	}

	async function anonymousToolPost(
		orgSlug: string,
		tool: string,
		body: unknown
	): Promise<number> {
		const res = await app.request(
			`/api/${orgSlug}/${tool}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
			testEnv
		);
		return res.status;
	}

	it("admits an anonymous GET to every declared proxy on a public org", async () => {
		for (const route of REST_TOOL_GET_ROUTES) {
			const path = route.routePath
				.replace(":orgSlug", publicSlug)
				.replace(":id", "1");
			expect({ path, status: await anonymousGet(path) }).toEqual({
				path,
				status: 200,
			});
		}
	});

	it("gives the REST door the same answer the tool door already gave", async () => {
		for (const route of REST_TOOL_GET_ROUTES) {
			const restStatus = await anonymousGet(
				route.routePath.replace(":orgSlug", publicSlug).replace(":id", "1")
			);
			const toolStatus = await anonymousToolPost(publicSlug, route.tool, {
				action: route.action,
			});
			expect({ route: route.routePath, restStatus }).toEqual({
				route: route.routePath,
				restStatus: toolStatus,
			});
		}
	});

	it("still refuses an undeclared GET on the same public org", async () => {
		// `manage_agents.list` is public-readable, but `/agents` is a hand-rolled
		// handler returning a superset of the tool payload. Declaring it would
		// claim a public-readability its response does not honour.
		expect(await anonymousGet(`/api/${publicSlug}/agents`)).toBe(401);
	});

	it("refuses a declared GET on a private org", async () => {
		for (const route of REST_TOOL_GET_ROUTES) {
			const path = route.routePath
				.replace(":orgSlug", privateSlug)
				.replace(":id", "1");
			expect({ path, status: await anonymousGet(path) }).toEqual({
				path,
				status: 401,
			});
		}
	});

	it("refuses an unmatched path on a public org (Hono's catch-all must not resolve)", async () => {
		expect(await anonymousGet(`/api/${publicSlug}/not-a-route`)).toBe(404);
	});

	it("does not open non-GET methods on the declared paths", async () => {
		const res = await app.request(
			`/api/${publicSlug}/connections`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			},
			testEnv
		);
		// Falls through to the generic tool-door route, where `connections` is
		// not a public-readable tool name.
		expect(res.status).toBe(401);
	});

	it("leaves the POST tool door unchanged", async () => {
		expect(
			await anonymousToolPost(publicSlug, "manage_connections", {
				action: "list",
			})
		).toBe(200);
		expect(
			await anonymousToolPost(publicSlug, "manage_connections", {
				action: "delete",
			})
		).toBe(401);
		expect(
			await anonymousToolPost(privateSlug, "manage_connections", {
				action: "list",
			})
		).toBe(401);
	});

	it("rejects the MCP-only render tool at the generic REST execution route", async () => {
		const proxyApp = new Hono<{ Bindings: Env }>();
		proxyApp.post("/api/:orgSlug/:toolName", (c) => restToolProxy(c));
		const res = await proxyApp.request(
			"/api/test-org/render_lobu_view",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "render",
					blocks: [{ type: "text", value: "must stay MCP-only" }],
				}),
			},
			testEnv
		);

		expect({ status: res.status, body: await res.json() }).toEqual({
			status: 404,
			body: { error: "Tool not found: render_lobu_view" },
		});
	});
});
