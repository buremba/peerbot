/**
 * notify + input_schema — an agent asks a human a question in their inbox.
 *
 * The whole point is that an ask reuses the approval rail rather than inventing
 * one, so this walks the rail end to end and asserts the things that were
 * silently broken before:
 *   - a bare `{}` schema is a DECISION: the feed marks it inline, so the inbox
 *     renders two buttons (previously gated on an allowlist of two entity-change
 *     action keys, so an ask could never qualify);
 *   - a field-shaped schema is NOT inline: it must route to a form, because two
 *     buttons would discard what the human typed;
 *   - approving with `input` records THAT INPUT as the answer —
 *     `BuilderApprovalHandler.apply()` had no parameter for it, so the human's
 *     values were dropped while approve reported success;
 *   - an agent cannot answer its own question.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { getPastReactionsSummary } from "../../../utils/watcher-reactions";
import { initWorkspaceProvider } from "../../../workspace";
import { getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

type SendResult = {
	notified_count: number;
	event_id: number | null;
	url: string | null;
	run_id?: number;
};

type ActivityResult = {
	items: Array<{
		title: string;
		status: string | null;
		run_id?: number;
		interaction_type?: string;
		interaction_status?: string;
		interaction_inline?: boolean;
		interaction_choice_field?: string;
		interaction_choices?: Array<{ value: string; label: string }>;
	}>;
};

describe("notify input_schema — agent asks a human", () => {
	let orgId: string;
	let humanCtx: AuthContext;
	let agentCtx: AuthContext;
	let behaviorCtx: AuthContext;
	let behaviorId: number;
	let windowId: number;

	const baseCtx = (
		userId: string,
		boundAgentId: string | null,
	): AuthContext => ({
		organizationId: orgId,
		tokenOrganizationId: orgId,
		userId,
		memberRole: "owner",
		agentId: boundAgentId,
		requestedAgentId: boundAgentId,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgId}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	});

	beforeAll(async () => {
		// No cleanupTestDatabase: every assertion is scoped to this run's fresh
		// org id, and the full-table wipe alone exceeds the 60s hook budget.
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "agent ask e2e" });
		orgId = org.id;
		const owner = await createTestUser({ email: "ask-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		humanCtx = baseCtx(owner.id, null);
		agentCtx = baseCtx(owner.id, "asking-agent");
		const sql = getTestDb();
		const [behavior] = await sql`
			WITH next_id AS (SELECT nextval('watchers_id_seq')::integer AS id)
			INSERT INTO watchers (
				id, watcher_group_id, organization_id, agent_id, created_by, name, slug
			)
			SELECT id, id, ${org.id}, 'asking-agent', ${owner.id},
				'Ask provenance behavior', 'ask-provenance-behavior'
			FROM next_id
			RETURNING id
		`;
		behaviorId = Number(behavior.id);
		const [window] = await sql`
			INSERT INTO events (
				organization_id, semantic_type, payload_type, payload_data,
				metadata, occurred_at, created_at, created_by
			) VALUES (
				${org.id}, 'canvas_state', 'json_template', '{}'::jsonb,
				${sql.json({
					watcher_id: behaviorId,
					granularity: "hour",
					window_start: "2026-08-10T00:00:00.000Z",
					window_end: "2026-08-10T01:00:00.000Z",
				})},
				NOW(), NOW(), ${owner.id}
			)
			RETURNING id
		`;
		windowId = Number(window.id);
		behaviorCtx = {
			...baseCtx(owner.id, null),
			actingWatcherId: behaviorId,
			actingWindowId: windowId,
		};
	});

	async function send(args: Record<string, unknown>): Promise<SendResult> {
		return (await executeTool(
			"notify",
			{ action: "send", ...args },
			TEST_ENV,
			agentCtx,
		)) as SendResult;
	}

	async function activity(): Promise<ActivityResult> {
		return (await executeTool(
			"manage_operations",
			{
				action: "list_activity",
				limit: 20,
				kinds: ["notification"],
				include_runs: false,
			},
			TEST_ENV,
			humanCtx,
		)) as ActivityResult;
	}

	it("a bare {} schema is a decision the inbox can settle inline", async () => {
		const sent = await send({
			title: "Ship the pricing change?",
			body: "Revenue +4%, 12 grandfathered accounts.",
			input_schema: {},
		});
		expect(sent.run_id).toBeGreaterThan(0);
		expect(sent.event_id).toBeGreaterThan(0);

		const sql = getTestDb();
		// The notification POINTS at an interaction event; it does not carry the
		// interaction itself. That indirection is what every existing surface
		// already resolves.
		const [notification] = await sql`
			SELECT metadata FROM events WHERE id = ${Number(sent.event_id)}
		`;
		const metadata = notification.metadata as Record<string, string>;
		expect(metadata.notification_type).toBe("action_approval_needed");
		expect(metadata.resource_type).toBe("event");

		const [interaction] = await sql`
			SELECT interaction_type, interaction_status, interaction_input_schema, run_id
			FROM events WHERE id = ${Number(metadata.resource_id)}
		`;
		expect(interaction.interaction_type).toBe("approval");
		expect(interaction.interaction_status).toBe("pending");
		expect(Number(interaction.run_id)).toBe(sent.run_id);

		const card = (await activity()).items.find(
			(i) => i.run_id === sent.run_id,
		);
		expect(card?.status).toBe("action_approval_needed");
		expect(card?.interaction_type).toBe("approval");
		expect(card?.interaction_status).toBe("pending");
		// The assertion that makes the buttons appear.
		expect(card?.interaction_inline).toBe(true);
	});

	it("a single enum field becomes named buttons, not approve/reject", async () => {
		const sent = await send({
			title: "The Acme renewal is at risk — how do we play it?",
			input_schema: {
				type: "object",
				properties: {
					play: { enum: ["Discount 15%", "Exec sponsor call", "Let it churn"] },
				},
				required: ["play"],
			},
		});
		const card = (await activity()).items.find((i) => i.run_id === sent.run_id);
		expect(card?.interaction_inline).toBe(true);
		// The field travels with the options so a caller can answer without
		// re-reading the schema. Approve/Reject cannot express this question, and
		// a bare approve would leave the required field empty.
		expect(card?.interaction_choice_field).toBe("play");
		expect(card?.interaction_choices?.map((c) => c.label)).toEqual([
			"Discount 15%",
			"Exec sponsor call",
			"Let it churn",
		]);
	});

	it("a lone OPTIONAL enum routes to the form — buttons cannot say 'no answer'", async () => {
		const sent = await send({
			title: "Optional: preferred demo slot?",
			input_schema: {
				type: "object",
				properties: { slot: { enum: ["Monday", "Tuesday"] } },
			},
		});
		const card = (await activity()).items.find((i) => i.run_id === sent.run_id);
		// One-click buttons can only SET the field; an optional field also needs
		// "answered nothing", which only the form can express.
		expect(card?.interaction_inline).toBeFalsy();
		expect(card?.interaction_choices).toBeUndefined();
	});

	it("an idempotent retry returns the SAME run, not a fresh orphan", async () => {
		const args = {
			title: "Approve the Q3 budget?",
			input_schema: {},
			idempotency_key: "ask-retry-e2e",
		};
		const first = await send(args);
		expect(first.run_id).toBeGreaterThan(0);

		// Queue-then-dedupe would strand a second pending run the agent polls
		// forever while the human answers the first — the retry must resolve
		// BEFORE the ask rail queues anything.
		const retry = await send(args);
		expect(retry.notified_count).toBe(0);
		expect(retry.event_id).toBe(first.event_id);
		expect(retry.run_id).toBe(first.run_id);

		const sql = getTestDb();
		const runs = await sql`
			SELECT id FROM runs
			WHERE organization_id = ${orgId}
				AND action_key = 'agent_ask'
				AND action_input->>'question' = ${args.title}
		`;
		expect(runs.length).toBe(1);
	});

	it("a field-shaped schema is NOT inline — it needs a form", async () => {
		const sent = await send({
			title: "How should we price the enterprise tier?",
			input_schema: {
				type: "object",
				properties: { price: { type: "number" } },
				required: ["price"],
			},
		});
		const card = (await activity()).items.find(
			(i) => i.run_id === sent.run_id,
		);
		expect(card?.interaction_status).toBe("pending");
		// Two buttons here would silently discard the number the human typed.
		expect(card?.interaction_inline).toBeFalsy();
	});

	it("approving with input records THAT input as the answer", async () => {
		const sent = await send({
			title: "Which plan should we grandfather?",
			input_schema: {
				type: "object",
				properties: { plan: { type: "string" } },
				required: ["plan"],
			},
		});

		const approved = (await executeTool(
			"manage_operations",
			{
				action: "approve",
				run_id: sent.run_id,
				input: { plan: "legacy-pro" },
			},
			TEST_ENV,
			humanCtx,
		)) as { approved?: boolean };
		expect(approved.approved).toBe(true);

		const sql = getTestDb();
		const [run] = await sql`
			SELECT approval_status, status, action_output
			FROM runs WHERE id = ${sent.run_id}
		`;
		expect(run.approval_status).toBe("approved");
		expect(run.status).toBe("completed");
		// Drop the `input` argument from handler.apply() and this is `{}` while
		// everything above still passes — which is exactly how the bug hid.
		expect(run.action_output).toEqual({ answer: { plan: "legacy-pro" } });
	});

	it("refuses a blank answer to a required field and keeps the run answerable", async () => {
		const sent = await send({
			title: "What should the enterprise tier cost?",
			input_schema: {
				type: "object",
				properties: {
					price: { type: "number", description: "Monthly USD" },
					rationale: { type: "string" },
				},
				required: ["price"],
			},
		});

		// The web form drops empty inputs before submitting, so an untouched form
		// arrives as `{}` — indistinguishable from "approve, no fields". Accepting
		// it completed the run with `{answer:{}}`: the agent asked for a number and
		// was told, successfully, nothing.
		const blank = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: sent.run_id, input: {} },
			TEST_ENV,
			humanCtx,
		)) as { error?: string; approved?: boolean };
		expect(blank.approved).toBeUndefined();
		expect(blank.error).toMatch(/`price`/);

		const sql = getTestDb();
		// Still PENDING, not burned — the refusal has to leave the question
		// answerable, which is why it runs before the claim.
		const [held] = await sql`
			SELECT approval_status, status, action_output
			FROM runs WHERE id = ${sent.run_id}
		`;
		expect(held.approval_status).toBe("pending");
		expect(held.action_output).toBeNull();

		const answered = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: sent.run_id, input: { price: 499 } },
			TEST_ENV,
			humanCtx,
		)) as { approved?: boolean };
		expect(answered.approved).toBe(true);

		const [done] = await sql`
			SELECT approval_status, action_output FROM runs WHERE id = ${sent.run_id}
		`;
		expect(done.approval_status).toBe("approved");
		expect(done.action_output).toEqual({ answer: { price: 499 } });
	});

	it("stamps WHO is asking onto the interaction the reviewer opens", async () => {
		const sent = await send({
			title: "Should I delete the staging data?",
			input_schema: {},
		});

		const sql = getTestDb();
		const [notification] = await sql`
			SELECT metadata FROM events WHERE id = ${Number(sent.event_id)}
		`;
		const resourceId = (notification.metadata as Record<string, string>)
			.resource_id;
		const [interaction] = await sql`
			SELECT metadata, author_name FROM events WHERE id = ${Number(resourceId)}
		`;
		const metadata = interaction.metadata as Record<string, unknown>;

		// "Should I delete the staging data?" reads very differently depending on
		// what is asking. The reviewer opens the INTERACTION event, so attribution
		// has to live there — the notification carrying it is not enough. Every
		// sibling approval path already stamps both of these; this one did not.
		expect(metadata.initiator).toMatchObject({
			kind: "agent_session",
			agent_id: "asking-agent",
		});
		expect(metadata).toHaveProperty("mcp_session_id");
		expect(interaction.author_name).toBeTruthy();
	});

	it("an agent cannot answer its own question", async () => {
		const sent = await send({
			title: "Should I delete the staging data?",
			input_schema: {},
		});
		const result = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: sent.run_id },
			TEST_ENV,
			agentCtx,
		)) as { error?: string };
		expect(result.error).toMatch(/human web session/i);

		const sql = getTestDb();
		const [run] = await sql`
			SELECT approval_status FROM runs WHERE id = ${sent.run_id}
		`;
		expect(run.approval_status).toBe("pending");
	});

	it("binds a Behavior ask and its rejection reason back to the firing window", async () => {
		const sent = (await executeTool(
			"notify",
			{
				action: "send",
				title: "Review the staged LinkedIn comment",
				body: "Draft: Durable state makes this workflow dependable.",
				input_schema: {
					type: "object",
					properties: {
						outcome: {
							enum: ["posted_unchanged", "posted_edited"],
						},
					},
					required: ["outcome"],
				},
				behavior_source: {
					behavior_id: behaviorId,
					window_id: windowId,
				},
			},
			TEST_ENV,
			behaviorCtx,
		)) as SendResult;

		const sql = getTestDb();
		const [run] = await sql`
			SELECT watcher_id, window_id
			FROM runs WHERE id = ${sent.run_id}
		`;
		expect(Number(run.watcher_id)).toBe(behaviorId);
		expect(Number(run.window_id)).toBe(windowId);

		const [reaction] = await sql`
			SELECT run_id FROM watcher_reactions
			WHERE watcher_id = ${behaviorId} AND window_id = ${windowId}
			ORDER BY id DESC LIMIT 1
		`;
		expect(Number(reaction.run_id)).toBe(sent.run_id);

		await executeTool(
			"manage_operations",
			{
				action: "reject",
				run_id: sent.run_id,
				reason: "The tone is too promotional for this discussion.",
			},
			TEST_ENV,
			humanCtx,
		);
		const summary = await getPastReactionsSummary(behaviorId);
		expect(summary).toContain("Durable state makes this workflow dependable.");
		expect(summary).toMatch(/rejected/i);
		expect(summary).toContain(
			"The tone is too promotional for this discussion."
		);
	});
});
