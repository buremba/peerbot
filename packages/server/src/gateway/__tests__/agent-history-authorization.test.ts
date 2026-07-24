import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

const ORG_ID = "test-org-agent-history-auth";

afterEach(() => {
	setAuthProvider(null);
});

test("keeps an agent-bound session scoped to its agent in the ambient org", async () => {
	const userAgentsStore = {
		findAgentOrganizations: async (
			_platform: string,
			_userId: string,
			agentId: string,
		) => (agentId === "agent-b" ? [ORG_ID] : []),
		ownsAgent: async (
			_platform: string,
			_userId: string,
			agentId: string,
			organizationId?: string,
		) => agentId === "agent-b" && organizationId === ORG_ID,
	} as unknown as UserAgentsStore;
	const app = new Hono();
	app.route(
		"/api/v1/agents/:agentId/history",
		createAgentHistoryRoutes({ userAgentsStore }),
	);
	setAuthProvider(() => ({
		agentId: "agent-a",
		userId: "history-user",
		platform: "external",
		exp: Date.now() + 60_000,
	}));

	const response = await orgContext.run({ organizationId: ORG_ID }, () =>
		app.request("/api/v1/agents/agent-b/history/threads/invalid%21/messages", {
			headers: { host: "localhost" },
		}),
	);

	expect(response.status).toBe(401);
});
