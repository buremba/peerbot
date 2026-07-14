/**
 * manage_conversations `send` control-flow — Vitest unit (no DB, no queue).
 *
 * Mocks the queue producer, the agent-exists check, agent-option resolution, and
 * the reply poll so we can assert the handler's routing without a live gateway:
 *   - enqueues a `platform:"api"` payload on the caller's api conversation id,
 *   - wait:false returns immediately ({ status: "queued" }),
 *   - wait:true returns the polled reply ({ status: "complete", reply }),
 *   - a terminal error becomes { status: "error" },
 *   - no reply before the deadline becomes { status: "timeout" },
 *   - empty text and a missing user id are rejected.
 *
 * vi.doMock + vi.resetModules + dynamic import keeps the mocks scoped to this
 * file (the proven pattern from resolve-pinned-selection-failclosed.test.ts), so
 * they never leak into the DB-backed suites in the same vitest worker.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../registry";
import type { Env } from "../../index";

const env = { ENVIRONMENT: "test" } as Env;
const ctx: ToolContext = {
	organizationId: "org-1",
	userId: "user-1",
	memberRole: "owner",
	isAuthenticated: true,
	tokenType: "oauth",
	// Session-equivalent scope sentinel: authorization is gated by role +
	// per-handler fences, not token scopes (matches how the in-process SDK runs a
	// cookie/session caller). Without a scope claim enforceRoleScopeAccess fails
	// closed on the write-tier `send`.
	scopes: ["*"],
	scopedToOrg: false,
	allowCrossOrg: false,
};

const enqueued: Array<Record<string, unknown>> = [];

/**
 * Register the shared mocks. `reply` is what readConversationReply yields; pass a
 * function to vary it across poll iterations (e.g. null then complete).
 */
function mockDeps(reply: unknown | (() => unknown)) {
	enqueued.length = 0;
	// requireOrg*Access + the agent-exists probe both run getDb()`...`; return a
	// truthy agent row and a no-op for the access checks.
	vi.doMock("../../db/client.js", () => {
		const tag = () => Promise.resolve([{ ok: 1 }]);
		return { getDb: () => tag, createDbClientFromEnv: () => tag };
	});
	vi.doMock("../../utils/organization-access.js", () => ({
		requireOrgReadAccess: () => Promise.resolve(),
		requireOrgWriteAccess: () => Promise.resolve(),
	}));
	vi.doMock("../../gateway/services/platform-helpers.js", async () => {
		const actual = await vi.importActual<
			typeof import("../../gateway/services/platform-helpers.js")
		>("../../gateway/services/platform-helpers.js");
		return {
			...actual,
			resolveAgentOptions: () => Promise.resolve({ provider: "claude" }),
		};
	});
	vi.doMock("../../lobu/gateway.js", () => ({
		getLobuCoreServices: () => ({
			getQueueProducer: () => ({
				enqueueMessage: (payload: Record<string, unknown>) => {
					enqueued.push(payload);
					return Promise.resolve("job-1");
				},
			}),
			getAgentSettingsStore: () => undefined,
		}),
	}));
	const replyFn = typeof reply === "function" ? (reply as () => unknown) : () => reply;
	vi.doMock("../../gateway/services/conversations-store.js", () => ({
		readConversationReply: () => Promise.resolve(replyFn()),
	}));
}

async function loadHandler() {
	const mod = await import("../admin/manage_conversations.js");
	return mod.manageConversations;
}

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("../../db/client.js");
	vi.doUnmock("../../utils/organization-access.js");
	vi.doUnmock("../../gateway/services/platform-helpers.js");
	vi.doUnmock("../../lobu/gateway.js");
	vi.doUnmock("../../gateway/services/conversations-store.js");
});

describe("manage_conversations send", () => {
	it("enqueues an api-platform turn and returns the polled reply", async () => {
		vi.resetModules();
		mockDeps({ status: "complete", text: "the answer" });
		const manageConversations = await loadHandler();

		const res = (await manageConversations(
			{
				action: "send",
				agent_id: "researcher",
				thread: "daily",
				text: "hello",
			},
			env,
			ctx,
		)) as Record<string, unknown>;

		expect(res.status).toBe("complete");
		expect(res.reply).toBe("the answer");
		// The turn was enqueued as platform:api on the caller's api conversation id.
		expect(enqueued).toHaveLength(1);
		const payload = enqueued[0];
		expect(payload.platform).toBe("api");
		expect(payload.agentId).toBe("researcher");
		expect(payload.organizationId).toBe("org-1");
		expect(String(payload.conversationId)).toContain("researcher_user-1_org-1");
		expect(String(payload.conversationId)).toContain("daily");
		expect(res.conversation_id).toBe(payload.conversationId);
	});

	it("wait:false returns queued immediately without polling", async () => {
		vi.resetModules();
		mockDeps(() => {
			throw new Error("must not poll when wait:false");
		});
		const manageConversations = await loadHandler();

		const res = (await manageConversations(
			{ action: "send", agent_id: "researcher", text: "fire", wait: false },
			env,
			ctx,
		)) as Record<string, unknown>;

		expect(res.status).toBe("queued");
		expect(res.message_id).toBeTruthy();
		expect(enqueued).toHaveLength(1);
	});

	it("surfaces a terminal error reply", async () => {
		vi.resetModules();
		mockDeps({ status: "error", error: "provider down" });
		const manageConversations = await loadHandler();

		const res = (await manageConversations(
			{ action: "send", agent_id: "researcher", text: "hi" },
			env,
			ctx,
		)) as Record<string, unknown>;

		expect(res.status).toBe("error");
		expect(res.error).toBe("provider down");
	});

	it("returns timeout when no reply lands before the deadline", async () => {
		vi.resetModules();
		mockDeps(null); // never completes
		const manageConversations = await loadHandler();

		const res = (await manageConversations(
			{
				action: "send",
				agent_id: "researcher",
				text: "hi",
				timeout_ms: 1000,
			},
			env,
			ctx,
		)) as Record<string, unknown>;

		expect(res.status).toBe("timeout");
		expect(res.message_id).toBeTruthy();
	});

	it("rejects empty text", async () => {
		vi.resetModules();
		mockDeps(null);
		const manageConversations = await loadHandler();

		await expect(
			manageConversations(
				{ action: "send", agent_id: "researcher", text: "   " },
				env,
				ctx,
			),
		).rejects.toThrow(/text is required/);
	});

	it("rejects an unauthenticated caller (no user id to bind the conversation)", async () => {
		vi.resetModules();
		mockDeps(null);
		const manageConversations = await loadHandler();

		await expect(
			manageConversations(
				{ action: "send", agent_id: "researcher", text: "hi" },
				env,
				{ ...ctx, userId: null },
			),
		).rejects.toThrow(/authenticated caller/);
	});
});
