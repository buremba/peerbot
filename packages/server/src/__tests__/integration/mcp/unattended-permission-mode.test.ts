/**
 * `execution_config.permission_mode` must actually govern the MCP tool-approval
 * gate for a headless Behavior turn.
 *
 * Before this was wired the field was validated at the tool boundary,
 * role-gated to owner/admin, persisted, shipped to the worker — and read by
 * nobody. An operator who set `dontAsk` on a scheduled Behavior got a run that
 * still blocked on an approval card no human could answer, because a scheduled
 * dispatch has no human in the loop.
 *
 * Token fidelity matters here and is easy to get wrong: the worker token's
 * `runId` is the `chat_message` QUEUE row, not the parent `behavior` row, so a
 * policy that joins `runs.watcher_id` on `tokenData.runId` matches nothing in
 * production while still passing a naively-built test. Every token minted below
 * therefore carries a real queue-row id that is NOT the Behavior run id — if
 * someone re-derives the policy from `runId`, these tests go red.
 *
 * Each case drives the real JSON-RPC path (`proxy.getApp().fetch`) so the gate,
 * the grant store, and the policy lookup are all the production ones.
 *
 * Reading the outcome — the two paths differ in SHAPE, not just in text:
 * - BLOCKED: the proxy answers the call itself, so the reply is a successful
 *   JSON-RPC `result` whose content carries the approval prose.
 * - ALLOWED: the call proceeds to the forward path and dies there against the
 *   deliberately unroutable upstream, producing a top-level JSON-RPC `error`.
 *
 * Asserting on shape rather than on a specific network message keeps the test
 * from re-breaking whenever the forward path's failure text changes (it already
 * differs between DNS failure and the SSRF guard).
 */

import { generateWorkerToken } from "@lobu/core";
import { describe, expect, it } from "vitest";
import { McpProxy } from "../../../gateway/auth/mcp/proxy";
import { GrantStore } from "../../../gateway/permissions/grant-store";
import { orgContext } from "../../../lobu/stores/org-context";
import { getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const APPROVAL_TEXT = /requires approval/i;

// Minimal McpConfigSource: we only need the gate that runs before the upstream
// is contacted. The host is deliberately unroutable (see file header).
const fakeConfigService = {
	getHttpServer: async () => ({
		url: "http://upstream.invalid/mcp",
		type: "http" as const,
	}),
	getAllHttpServers: async () => new Map(),
};

interface Scenario {
	workspace: TestWorkspace;
	organizationId: string;
	agentId: string;
	watcherId: number;
	behaviorRunId: number;
	/** The `chat_message` queue row the worker token is scoped to. */
	queueRunId: number;
	conversationId: string;
}

let counter = 0;

/**
 * A Behavior with the given `permission_mode`, its live Behavior run, and the
 * `chat_message` queue row that dispatched the turn.
 * `permissionMode: null` leaves execution_config untouched (the default).
 */
async function scenario(
	permissionMode: string | null,
	opts?: {
		/** Reuse an existing workspace + agent (sibling-Behavior case). */
		reuse?: { workspace: TestWorkspace; agentId: string };
		/** Force the agent slug, so two orgs can share one (tenant case). */
		agentSlug?: string;
	},
): Promise<Scenario> {
	const reuse = opts?.reuse;
	const sql = getTestDb();
	const slug = `unattended-${++counter}`;
	const workspace =
		reuse?.workspace ??
		(await TestWorkspace.create({ name: `Unattended ${slug}` }));
	const entity = await createTestEntity({
		// Unique per scenario: two scenarios can share a workspace (the
		// sibling-Behavior case), and entity slugs are unique within a parent.
		name: `Unattended Entity ${slug}`,
		organization_id: workspace.org.id,
		created_by: workspace.users.owner.id,
	});
	const agentId =
		reuse?.agentId ??
		(
			await createTestAgent({
				organizationId: workspace.org.id,
				ownerUserId: workspace.users.owner.id,
				agentId: opts?.agentSlug ?? `unattended-agent-${slug}`,
				name: "Unattended Agent",
			})
		).agentId;

	const behavior = (await workspace.owner.behaviors.create({
		entity_id: entity.id,
		slug,
		name: "Unattended Behavior",
		prompt: "Summarize the available entity content.",
		triggers: [
			{
				kind: "schedule",
				cron: "0 * * * *",
				execution: "window",
				active_run: "coalesce",
				skip_if_unchanged: false,
			},
		],
		agent_id: agentId,
	})) as { behavior_id: string };
	const watcherId = Number(behavior.behavior_id);

	// Set permission_mode directly rather than through the create contract: the
	// role gate on elevated modes is a separate concern with its own tests, and
	// this test is about whether the RUNTIME gate reads the stored value.
	if (permissionMode !== null) {
		await sql`
      UPDATE watchers
      SET execution_config = COALESCE(execution_config, '{}'::jsonb)
        || ${sql.json({ permission_mode: permissionMode })}
      WHERE id = ${watcherId}
    `;
	}

	// Production shape: `dispatchWatcherRun` stamps `dispatched_message_id` in
	// the SAME statement that marks the run 'running', before posting the
	// message the per-turn worker token is minted from. The gate binds to it, so
	// a fixture that omits it would pass against a gate that ignores the turn.
	const dispatchedMessageId = `msg-${slug}`;
	const [behaviorRun] = await sql`
    INSERT INTO runs (
      organization_id, run_type, watcher_id, status, dispatched_message_id,
      approved_input
    )
    VALUES (${workspace.org.id}, 'behavior', ${watcherId}, 'running',
            ${dispatchedMessageId}, ${sql.json({ dispatch_source: "scheduled" })})
    RETURNING id
  `;
	const behaviorRunId = Number(behaviorRun.id);

	// The queue row the token is actually scoped to — a DIFFERENT runs.id.
	const [queueRun] = await sql`
    INSERT INTO runs (organization_id, run_type, status)
    VALUES (${workspace.org.id}, 'chat_message', 'completed')
    RETURNING id
  `;

	return {
		workspace,
		organizationId: workspace.org.id,
		agentId,
		watcherId,
		behaviorRunId,
		dispatchedMessageId,
		queueRunId: Number(queueRun.id),
		conversationId: `${agentId}_watcher_${watcherId}_run_${behaviorRunId}`,
	};
}

/** Drive a write-capable tool call through the real proxy gate. */
async function callTool(opts: {
	organizationId: string;
	agentId: string;
	conversationId: string;
	queueRunId: number;
	dispatchedMessageId: string;
	/** Override to model a turn the dispatcher did not start. */
	messageId?: string;
	source?: string;
}): Promise<{ blocked: boolean; reachedForwardPath: boolean }> {
	const proxy = new McpProxy(fakeConfigService as never, {
		grantStore: new GrantStore(),
	});

	const token = generateWorkerToken("u1", opts.conversationId, "deployment-1", {
		channelId: "c1",
		agentId: opts.agentId,
		organizationId: opts.organizationId,
		source: opts.source ?? "watcher-run",
		// Production shape: the queue row, never the Behavior run.
		runId: opts.queueRunId,
		messageId: opts.messageId ?? opts.dispatchedMessageId,
	});

	const response = await orgContext.run(
		{ organizationId: opts.organizationId },
		async () =>
			proxy.getApp().fetch(
				new Request("http://localhost/lobu-memory", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 7,
						method: "tools/call",
						params: { name: "run_sdk", arguments: { code: "noop" } },
					}),
				}),
			),
	);

	const json = (await response.json()) as { result?: unknown; error?: unknown };
	return {
		blocked: APPROVAL_TEXT.test(JSON.stringify(json)),
		reachedForwardPath: json.error !== undefined && json.result === undefined,
	};
}

describe("permission_mode governs the MCP tool-approval gate", () => {
	for (const mode of ["dontAsk", "bypassPermissions"]) {
		it(`lets a headless Behavior turn through when permission_mode is '${mode}'`, async () => {
			const { blocked, reachedForwardPath } = await callTool(
				await scenario(mode),
			);

			expect(blocked).toBe(false);
			// Positive proof it reached the forward path rather than silently
			// short-circuiting somewhere else in the gate.
			expect(reachedForwardPath).toBe(true);
		});
	}

	for (const mode of [null, "default", "plan", "auto", "acceptEdits"]) {
		it(`still requires approval when permission_mode is ${mode ?? "unset"}`, async () => {
			const { blocked } = await callTool(await scenario(mode));

			expect(blocked).toBe(true);
		});
	}

	it("does not let one Behavior lend its elevated mode to a sibling of the same agent", async () => {
		const elevated = await scenario("dontAsk");
		// Same org AND same agent — only the Behavior differs.
		const plain = await scenario("default", {
			reuse: { workspace: elevated.workspace, agentId: elevated.agentId },
		});

		expect((await callTool(plain)).blocked).toBe(true);
		// Sanity: the elevated sibling really is elevated, so the assertion above
		// is about Behavior scoping and not about the bypass being broken outright.
		expect((await callTool(elevated)).blocked).toBe(false);
	});

	it("does not let another org's turn claim an elevated Behavior", async () => {
		// Agent ids are org-scoped, so two tenants can hold the SAME agent slug.
		// That is the dangerous shape: with a matching slug, only the org
		// predicates stand between org B's turn and org A's elevated Behavior.
		// A different-slug outsider would be stopped by the agent check instead
		// and would leave the tenant boundary itself untested.
		const sharedSlug = `shared-agent-${++counter}`;
		const elevated = await scenario("dontAsk", { agentSlug: sharedSlug });
		const outsider = await scenario("default", { agentSlug: sharedSlug });

		expect(elevated.agentId).toBe(outsider.agentId);
		expect(elevated.organizationId).not.toBe(outsider.organizationId);

		const { blocked } = await callTool({
			organizationId: outsider.organizationId,
			agentId: outsider.agentId,
			conversationId: elevated.conversationId,
			queueRunId: outsider.queueRunId,
		});

		expect(blocked).toBe(true);
	});

	it("does not let another agent in the same org claim an elevated Behavior", async () => {
		const elevated = await scenario("dontAsk");
		const other = await createTestAgent({
			organizationId: elevated.organizationId,
			ownerUserId: elevated.workspace.users.owner.id,
			agentId: `sibling-agent-${++counter}`,
			name: "Sibling Agent",
		});

		const { blocked } = await callTool({
			organizationId: elevated.organizationId,
			agentId: other.agentId,
			conversationId: elevated.conversationId,
			queueRunId: elevated.queueRunId,
		});

		expect(blocked).toBe(true);
	});

	it("still requires approval for an interactive turn", async () => {
		const s = await scenario("dontAsk");

		// A browser/chat conversation carries no `_watcher_<id>_run_<id>` suffix.
		// A human is present to answer the card, so the bypass must not apply.
		const { blocked } = await callTool({
			organizationId: s.organizationId,
			agentId: s.agentId,
			conversationId: `${s.agentId}_dm_user_42`,
			queueRunId: s.queueRunId,
		});

		expect(blocked).toBe(true);
	});

	describe("the conversation suffix alone never grants unattended tool use", () => {
		// The escalation is per-TURN, not per-session: a Behavior conversation
		// outlives the dispatch that created it, so verifying `intent` at session
		// creation does not stop a later turn on the same conversation from
		// inheriting bypassPermissions. Each case below shares the Behavior's
		// exact conversationId and differs only in what the SERVER recorded.

		it("blocks a direct-API turn on the very same conversation", async () => {
			const fixture = await scenario("bypassPermissions");

			const { blocked } = await callTool({
				...fixture,
				source: "direct-api",
				// An ordinary caller's turn carries its own message id.
				messageId: "msg-attacker-direct-api",
			});

			expect(blocked).toBe(true);
		});

		it("blocks a second turn posted into a live Behavior session", async () => {
			// An org member posting another message to the dispatcher's session
			// gets a new per-turn message id, so it is not the dispatched turn.
			const fixture = await scenario("bypassPermissions");

			const { blocked } = await callTool({
				...fixture,
				messageId: `${fixture.dispatchedMessageId}-second-turn`,
			});

			expect(blocked).toBe(true);
		});

		it("blocks a turn whose token carries no message id at all", async () => {
			const fixture = await scenario("bypassPermissions");

			const { blocked } = await callTool({ ...fixture, messageId: "" });

			expect(blocked).toBe(true);
		});

		it("blocks a resumed session once the Behavior run has finished", async () => {
			const fixture = await scenario("bypassPermissions");
			await getTestDb()`
        UPDATE runs SET status = 'completed' WHERE id = ${fixture.behaviorRunId}
      `;

			const { blocked } = await callTool(fixture);

			expect(blocked).toBe(true);
		});

		it("still allows the dispatcher's own turn, so the guard is not a blanket deny", async () => {
			// Pairs with the four cases above: without this, deleting the whole
			// unattended branch would keep them all green.
			const fixture = await scenario("bypassPermissions");

			const { blocked } = await callTool(fixture);

			expect(blocked).toBe(false);
		});
	});
});
