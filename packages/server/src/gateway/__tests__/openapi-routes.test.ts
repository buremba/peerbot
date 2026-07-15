/**
 * Doc-projection regression tests for the defineRoute registry.
 *
 * The merged OpenAPI document is assembled from three `paths` groups
 * (dispatch tools, openapi-auto walk, defineRoute registry). The merge must be
 * method-wise: the registry documenting POST /api/v1/agents must NOT drop
 * openapi-auto's GET on the same path (the whole-path-spread bug the review
 * caught). Also pins the SSE endpoint's `text/event-stream` declaration.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	buildRoutePaths,
	defineRoute,
	getValidated,
	mergeOpenApiPaths,
	type RouteSpec,
} from "../routes/shared/define-route.js";
import { createAgentApi } from "../routes/public/agent.js";
import { Type } from "@sinclair/typebox";

describe("mergeOpenApiPaths", () => {
	test("merges per method — sibling operations on the same path survive", () => {
		const auto = {
			"/api/v1/agents": { get: { operationId: "listAgents" } },
			"/api/v1/agents/{agentId}": {
				patch: { operationId: "updateAgent" },
			},
		};
		const registry = {
			"/api/v1/agents": { post: { operationId: "createAgent" } },
			"/api/v1/agents/{agentId}": {
				get: { operationId: "getAgent" },
				delete: { operationId: "deleteAgent" },
			},
		};
		const merged = mergeOpenApiPaths(auto, registry) as Record<
			string,
			Record<string, { operationId: string }>
		>;
		expect(Object.keys(merged["/api/v1/agents"]).sort()).toEqual([
			"get",
			"post",
		]);
		expect(Object.keys(merged["/api/v1/agents/{agentId}"]).sort()).toEqual([
			"delete",
			"get",
			"patch",
		]);
	});

	test("later group wins per conflicting method", () => {
		const merged = mergeOpenApiPaths(
			{ "/x": { get: { operationId: "stub" } } },
			{ "/x": { get: { operationId: "rich" } } },
		) as Record<string, Record<string, { operationId: string }>>;
		expect(merged["/x"].get.operationId).toBe("rich");
	});
});

describe("buildRoutePaths", () => {
	test("agent routes document both methods on /api/v1/agents/{agentId} and SSE media type", () => {
		// Registering the real agent API populates the route registry.
		createAgentApi({
			queueProducer: {} as never,
			sessionManager: {} as never,
			sseManager: {} as never,
			publicGatewayUrl: "http://localhost:8787",
		} as never);

		const paths = buildRoutePaths() as Record<
			string,
			Record<string, { responses: Record<string, unknown> }>
		>;

		expect(paths["/api/v1/agents"]?.post).toBeDefined();
		expect(paths["/api/v1/agents/{agentId}"]?.get).toBeDefined();
		expect(paths["/api/v1/agents/{agentId}"]?.delete).toBeDefined();

		const sse = paths["/api/v1/agents/{agentId}/events"]?.get as {
			responses: Record<string, { content?: Record<string, unknown> }>;
		};
		expect(sse).toBeDefined();
		expect(Object.keys(sse.responses["200"].content ?? {})).toEqual([
			"text/event-stream",
		]);
	});

	test("JSON bodies validate STRICTLY — scalar coercion is rejected", async () => {
		const app = new Hono();
		defineRoute(
			app,
			{
				method: "post",
				path: "/strict",
				request: {
					body: Type.Object({ content: Type.String() }),
				},
				responses: { 200: { description: "ok" } },
			},
			(c) => c.json({ ok: true }),
		);
		// {content: 123} must be a 400, not silently coerced to "123".
		const bad = await app.request("/strict", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: 123 }),
		});
		expect(bad.status).toBe(400);
		const good = await app.request("/strict", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "hi" }),
		});
		expect(good.status).toBe(200);
	});

	test("path/query params coerce from their string form", async () => {
		const app = new Hono();
		let seen: unknown;
		defineRoute(
			app,
			{
				method: "get",
				path: "/things/{thingId}",
				request: {
					params: Type.Object({ thingId: Type.String() }),
					query: Type.Object({ limit: Type.Integer({ minimum: 1 }) }),
				},
				responses: { 200: { description: "ok" } },
			},
			(c) => {
				seen = getValidated(c).query;
				return c.json({ ok: true });
			},
		);
		const res = await app.request("/things/t1?limit=5");
		expect(res.status).toBe(200);
		expect(seen).toEqual({ limit: 5 });
		const bad = await app.request("/things/t1?limit=zero");
		expect(bad.status).toBe(400);
	});

	test("custom mediaType and {param} doc form are preserved", () => {
		const spec: RouteSpec = {
			method: "get",
			path: "/api/v1/things/{thingId}/stream",
			responses: {
				200: {
					description: "stream",
					schema: Type.String(),
					mediaType: "text/event-stream",
				},
			},
		};
		defineRoute(new Hono(), spec, () => new Response(null));
		const paths = buildRoutePaths();
		expect(paths["/api/v1/things/{thingId}/stream"]).toBeDefined();
	});
});
