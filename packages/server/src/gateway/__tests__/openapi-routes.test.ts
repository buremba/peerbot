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
