import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../../index";
import { restGetBehaviors, restSearchKnowledge } from "../../rest-api";

describe("REST ToolUserError responses", () => {
	it("preserves the status thrown by the wrapped tool", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.use("*", async (c, next) => {
			c.set("organizationId" as never, "test-org" as never);
			c.set("memberRole" as never, "owner" as never);
			c.set("mcpIsAuthenticated" as never, true as never);
			c.set(
				"mcpAuthInfo" as never,
				{
					tokenType: "access_token",
					organizationId: "test-org",
					userId: "test-user",
					scopes: [],
				} as never
			);
			await next();
		});
		app.get("/api/:orgSlug/knowledge/search", restSearchKnowledge);

		const response = await app.request(
			"/api/test-org/knowledge/search?query=customer+feedback"
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "read_knowledge requires an MCP session with read access.",
		});
	});

	it("rejects a malformed behavior_id instead of partially parsing it", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.get("/api/:orgSlug/behaviors", restGetBehaviors);

		const response = await app.request("/api/test-org/behaviors?behavior_id=71%29");

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "behavior_id must be a positive integer",
		});
	});
});
