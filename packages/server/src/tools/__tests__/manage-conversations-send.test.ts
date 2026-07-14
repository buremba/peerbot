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

/** A plain member (not owner/admin) — the tier `send` must still allow. */
const memberCtx: ToolContext = { ...ctx, memberRole: "member" };

const enqueued: Array<Record<string, unknown>> = [];

interface MockOpts {
	/** readConversationReply yields this (or a per-iteration function). */
	reply?: unknown | (() => unknown);
	/** getConversation yields this (default: a caller-owned web row). */
	conversation?: unknown;
}

/** A caller-owned web conversation — passes the send/get ownership fence. */
const OWNED_ROW = {
	platform: "web",
	conversationId: "conv-x",
	kind: "owned",
	userId: "user-1",
	title: "t",
	lastActivityAt: new Date(0),
	createdAt: new Date(0),
};

function mockDeps(opts: MockOpts = {}) {
	enqueued.length = 0;
	// The agent-exists probe runs getDb()/createDbClientFromEnv `...` — return a
	// truthy agent row so assertAgentInOrg passes.
	vi.doMock("../../db/client.js", () => {
		const tag = () => Promise.resolve([{ ok: 1 }]);
		return { getDb: () => tag, createDbClientFromEnv: () => tag };
	});
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
	const replyFn =
		typeof opts.reply === "function"
			? (opts.reply as () => unknown)
			: () => opts.reply ?? null;
	const conversation =
		"conversation" in opts ? opts.conversation : OWNED_ROW;
	vi.doMock("../../gateway/services/conversations-store.js", () => ({
		readConversationReply: () => Promise.resolve(replyFn()),
		getConversation: () => Promise.resolve(conversation),
		listConversations: () => Promise.resolve([OWNED_ROW]),
	}));
}

async function loadHandler() {
	const mod = await import("../admin/manage_conversations.js");
	return mod.manageConversations;
}

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("../../db/client.js");
	vi.doUnmock("../../gateway/services/platform-helpers.js");
	vi.doUnmock("../../lobu/gateway.js");
	vi.doUnmock("../../gateway/services/conversations-store.js");
});

describe("manage_conversations send", () => {
	it("lets a plain MEMBER send and returns the polled reply on a derived id", async () => {
		vi.resetModules();
		mockDeps({ reply: { status: "complete", text: "the answer" } });
		const manageConversations = await loadHandler();

		const res = (await manageConversations(
			{
				action: "send",
				agent_id: "researcher",
				thread: "daily",
				text: "hello",
			},
			env,
			// a MEMBER, not owner — proves send is member-tier (no admin re-gate).
			memberCtx,
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
		mockDeps({
			reply: () => {
				throw new Error("must not poll when wait:false");
			},
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

	it("returns (does NOT throw) a terminal error reply", async () => {
		vi.resetModules();
		mockDeps({ reply: { status: "error", error: "provider down" } });
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
		mockDeps({ reply: null }); // never completes
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

	it("resumes an explicit conversation_id that the caller owns", async () => {
		vi.resetModules();
		mockDeps({
			reply: { status: "complete", text: "resumed" },
			conversation: OWNED_ROW,
		});
		const manageConversations = await loadHandler();

		const res = (await manageConversations(
			{
				action: "send",
				agent_id: "researcher",
				conversation_id: "conv-x",
				text: "hi",
			},
			env,
			memberCtx,
		)) as Record<string, unknown>;

		expect(res.status).toBe("complete");
		expect(res.conversation_id).toBe("conv-x");
		expect(enqueued[0].conversationId).toBe("conv-x");
	});

	it("refuses a conversation_id that is not the caller's owned web conversation — for a MEMBER (IDOR)", async () => {
		vi.resetModules();
		// The target belongs to a DIFFERENT user.
		mockDeps({
			conversation: { ...OWNED_ROW, userId: "someone-else" },
		});
		const manageConversations = await loadHandler();

		await expect(
			manageConversations(
				{
					action: "send",
					agent_id: "researcher",
					conversation_id: "conv-x",
					text: "hi",
				},
				env,
				memberCtx,
			),
		).rejects.toThrow(/not found/);
		// Nothing was enqueued into another user's conversation.
		expect(enqueued).toHaveLength(0);
	});

	it("refuses sending into another user's conversation even for an ADMIN (no bypass)", async () => {
		vi.resetModules();
		mockDeps({ conversation: { ...OWNED_ROW, userId: "someone-else" } });
		const manageConversations = await loadHandler();

		await expect(
			manageConversations(
				{
					action: "send",
					agent_id: "researcher",
					conversation_id: "conv-x",
					text: "hi",
				},
				env,
				ctx, // owner — send is caller-attributed, so no admin cross-user write.
			),
		).rejects.toThrow(/not found/);
		expect(enqueued).toHaveLength(0);
	});

	it("delivers a reply that lands during the final wait window (short timeout)", async () => {
		vi.resetModules();
		// null on the first poll, then complete — with timeout_ms=1000 and a 1000ms
		// poll interval, the post-loop final read must still catch it.
		let calls = 0;
		mockDeps({
			reply: () =>
				++calls >= 2 ? { status: "complete", text: "late answer" } : null,
		});
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

		expect(res.status).toBe("complete");
		expect(res.reply).toBe("late answer");
	});

	it("rejects empty text", async () => {
		vi.resetModules();
		mockDeps({ reply: null });
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
		mockDeps({ reply: null });
		const manageConversations = await loadHandler();

		await expect(
			manageConversations(
				{ action: "send", agent_id: "researcher", text: "hi" },
				env,
				{ ...ctx, userId: null, scopes: ["*"] },
			),
		).rejects.toThrow(/authenticated caller/);
	});
});

describe("manage_conversations list/get fencing", () => {
	it("list scopes a MEMBER to their own owned threads (scope=user)", async () => {
		vi.resetModules();
		mockDeps({});
		const manageConversations = await loadHandler();
		const res = (await manageConversations(
			{ action: "list", agent_id: "researcher" },
			env,
			memberCtx,
		)) as Record<string, unknown>;
		expect(res.action).toBe("list");
		expect(Array.isArray(res.conversations)).toBe(true);
	});

	it("get returns a caller-owned conversation", async () => {
		vi.resetModules();
		mockDeps({ conversation: OWNED_ROW });
		const manageConversations = await loadHandler();
		const res = (await manageConversations(
			{ action: "get", agent_id: "researcher", conversation_id: "conv-x" },
			env,
			memberCtx,
		)) as Record<string, unknown>;
		expect(res.action).toBe("get");
	});

	it("get refuses another user's web conversation for a member (IDOR → 404)", async () => {
		vi.resetModules();
		mockDeps({ conversation: { ...OWNED_ROW, userId: "someone-else" } });
		const manageConversations = await loadHandler();
		await expect(
			manageConversations(
				{ action: "get", agent_id: "researcher", conversation_id: "conv-x" },
				env,
				memberCtx,
			),
		).rejects.toThrow(/not found/);
	});

	it("get lets an ADMIN read another user's conversation", async () => {
		vi.resetModules();
		mockDeps({ conversation: { ...OWNED_ROW, userId: "someone-else" } });
		const manageConversations = await loadHandler();
		const res = (await manageConversations(
			{ action: "get", agent_id: "researcher", conversation_id: "conv-x" },
			env,
			ctx, // owner
		)) as Record<string, unknown>;
		expect(res.action).toBe("get");
	});

	it("list rejects an unauthenticated caller", async () => {
		vi.resetModules();
		mockDeps({});
		const manageConversations = await loadHandler();
		await expect(
			manageConversations(
				{ action: "list", agent_id: "researcher" },
				env,
				{ ...ctx, userId: null, scopes: ["*"] },
			),
		).rejects.toThrow(/authenticated caller/);
	});
});
