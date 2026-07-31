import { afterEach, expect, test } from "bun:test";
import type { AgentConfigStore } from "@lobu/core";
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

const FOREIGN_ORG_ID = "test-org-agent-history-foreign";
const SHARED_AGENT_ID = "lobu-builder";

test("rejects no-ambient history when only unscoped metadata names an org", async () => {
	const userAgentsStore = {
		findAgentOrganizations: async () => [],
		ownsAgent: async () => false,
		addAgent: async () => {},
	} as unknown as UserAgentsStore;
	const agentConfigStore = {
		getMetadata: async (agentId: string) =>
			agentId === SHARED_AGENT_ID
				? {
						agentId: SHARED_AGENT_ID,
						name: "Builder",
						owner: { platform: "external", userId: "history-user" },
						organizationId: FOREIGN_ORG_ID,
						createdAt: 0,
						lastUsedAt: null,
					}
				: null,
	} as unknown as Pick<AgentConfigStore, "getMetadata">;
	const app = new Hono();
	app.route(
		"/api/v1/agents/:agentId/history",
		createAgentHistoryRoutes({ userAgentsStore, agentConfigStore }),
	);
	setAuthProvider(() => ({
		userId: "history-user",
		platform: "external",
		exp: Date.now() + 60_000,
	}));

	const response = await app.request(
		`/api/v1/agents/${SHARED_AGENT_ID}/history/threads`,
	);

	expect(response.status).toBe(401);
});

test("rejects no-ambient admin history without a tenant scope", async () => {
	const app = new Hono();
	app.route(
		"/api/v1/agents/:agentId/history",
		createAgentHistoryRoutes({}),
	);
	setAuthProvider(() => ({
		userId: "history-admin",
		platform: "external",
		isAdmin: true,
		exp: Date.now() + 60_000,
	}));

	const response = await app.request(
		`/api/v1/agents/${SHARED_AGENT_ID}/history/session/messages`,
	);

	expect(response.status).toBe(401);
});

test("uses the single agent_users org without consulting metadata", async () => {
	const userAgentsStore = {
		findAgentOrganizations: async () => [FOREIGN_ORG_ID],
		ownsAgent: async () => false,
		addAgent: async () => {},
	} as unknown as UserAgentsStore;
	const agentConfigStore = {
		getMetadata: async () => {
			throw new Error("metadata fallback should not run");
		},
	} as unknown as Pick<AgentConfigStore, "getMetadata">;
	const app = new Hono();
	app.route(
		"/api/v1/agents/:agentId/history",
		createAgentHistoryRoutes({ userAgentsStore, agentConfigStore }),
	);
	setAuthProvider(() => ({
		userId: "history-user",
		platform: "external",
		exp: Date.now() + 60_000,
	}));

	const response = await app.request(
		`/api/v1/agents/${SHARED_AGENT_ID}/history/threads/invalid%21/messages`,
	);

	expect(response.status).toBe(400);
});
