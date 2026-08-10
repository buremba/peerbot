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
import { pgTextArray } from "../../../db/client";
import type { Env } from "../../../index";
import { buildClientSDK } from "../../../sandbox/client-sdk";
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

		const card = (await activity()).items.find((i) => i.run_id === sent.run_id);
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

	it("routes a numeric enum to the form so its JSON type is preserved", async () => {
		const sent = await send({
			title: "How many rollout waves?",
			input_schema: {
				type: "object",
				properties: { waves: { type: "integer", enum: [2, 3] } },
				required: ["waves"],
			},
		});
		const card = (await activity()).items.find((i) => i.run_id === sent.run_id);

		// Inline choices are strings in the Activity contract. Turning `2` into
		// `"2"` would make the complete schema validator refuse every click, so a
		// typed numeric enum must use the form instead.
		expect(card?.interaction_inline).toBeFalsy();
		expect(card?.interaction_choices).toBeUndefined();

		const approved = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: sent.run_id, input: { waves: 2 } },
			TEST_ENV,
			humanCtx,
		)) as { approved?: boolean };
		expect(approved.approved).toBe(true);
	});

	it("preserves typed values for array enum choices", async () => {
		const sent = await send({
			title: "Which rollout waves should run?",
			input_schema: {
				type: "object",
				properties: {
					waves: {
						type: "array",
						items: { type: "integer", enum: [2, 3] },
						minItems: 1,
					},
				},
				required: ["waves"],
			},
		});

		// DynamicConnectorForm renders item enums as a multi-select and submits
		// the original enum values, rather than comma-separated strings.
		const approved = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: sent.run_id, input: { waves: [2] } },
			TEST_ENV,
			humanCtx,
		)) as { approved?: boolean };
		expect(approved.approved).toBe(true);
	});

	it("keeps string-capable array combinators answerable", async () => {
		const sent = await send({
			title: "Which release tags should run?",
			input_schema: {
				type: "object",
				properties: {
					tags: {
						type: "array",
						items: {
							anyOf: [{ type: "string", minLength: 1 }, { type: "integer" }],
						},
					},
				},
				required: ["tags"],
			},
		});
		const approved = (await executeTool(
			"manage_operations",
			{
				action: "approve",
				run_id: sent.run_id,
				input: { tags: ["stable"] },
			},
			TEST_ENV,
			humanCtx,
		)) as { approved?: boolean };
		expect(approved.approved).toBe(true);
	});

	it("allows a field literally named pattern without treating it as a regex", async () => {
		const sent = await send({
			title: "What naming pattern should we use?",
			input_schema: {
				type: "object",
				properties: { pattern: { type: "string" } },
				required: ["pattern"],
			},
		});
		const approved = (await executeTool(
			"manage_operations",
			{
				action: "approve",
				run_id: sent.run_id,
				input: { pattern: "release-{date}" },
			},
			TEST_ENV,
			humanCtx,
		)) as { approved?: boolean };
		expect(approved.approved).toBe(true);
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
		const card = (await activity()).items.find((i) => i.run_id === sent.run_id);
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

	it("completes the ClientSDK send → answer → getRun lifecycle", async () => {
		const client = buildClientSDK(agentCtx, TEST_ENV);
		const sent = await client.notifications.send({
			title: "Which release lane should the SDK use?",
			input_schema: {
				type: "object",
				properties: { lane: { enum: ["stable", "canary"] } },
				required: ["lane"],
			},
		});
		expect(sent.event_id).toBeGreaterThan(0);
		expect(sent.run_id).toBeGreaterThan(0);

		const pending = (await client.operations.getRun(Number(sent.run_id))) as {
			run: Record<string, unknown>;
		};
		expect(pending.run.status).toBe("pending");

		const approved = (await executeTool(
			"manage_operations",
			{
				action: "approve",
				run_id: sent.run_id,
				input: { lane: "stable" },
			},
			TEST_ENV,
			humanCtx,
		)) as { approved?: boolean };
		expect(approved.approved).toBe(true);

		const completed = (await client.operations.getRun(Number(sent.run_id))) as {
			run: Record<string, unknown>;
		};
		expect(completed.run.status).toBe("completed");
		expect(completed.run.output).toEqual({ answer: { lane: "stable" } });
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

	it("refuses an answer that violates the declared JSON Schema and keeps the run answerable", async () => {
		const sent = await send({
			title: "Which plan should we grandfather?",
			input_schema: {
				type: "object",
				properties: {
					plan: {
						type: "string",
						enum: ["legacy-pro", "legacy-enterprise"],
					},
				},
				required: ["plan"],
				additionalProperties: false,
			},
		});

		const invalid = (await executeTool(
			"manage_operations",
			{
				action: "approve",
				run_id: sent.run_id,
				input: { plan: "made-up-plan" },
			},
			TEST_ENV,
			humanCtx,
		)) as { error?: string; approved?: boolean };
		expect(invalid.approved).toBeUndefined();
		expect(invalid.error).toMatch(/plan: must be one of/i);

		const sql = getTestDb();
		const [held] = await sql`
			SELECT approval_status, status, action_output
			FROM runs WHERE id = ${sent.run_id}
		`;
		expect(held.approval_status).toBe("pending");
		expect(held.status).toBe("pending");
		expect(held.action_output).toBeNull();
	});

	it("rejects invalid or unanswerable schemas before creating a pending run", async () => {
		const cases = [
			{
				question: "Question with an invalid schema",
				inputSchema: {
					type: "object",
					properties: { answer: { type: "not-a-json-schema-type" } },
				},
				error: /input_schema is invalid/i,
			},
			{
				question: "Question with a scalar answer",
				inputSchema: { type: "string" },
				error: /must describe an object answer/i,
			},
			{
				question: "Question with a root constant",
				inputSchema: { type: "object", const: { answer: "hidden" } },
				error: /root const and enum constraints are not supported/i,
			},
			{
				question: "Question with a local schema reference",
				inputSchema: {
					type: "object",
					$defs: { plan: { enum: ["legacy", "new"] } },
					properties: { plan: { $ref: "#/$defs/plan" } },
					required: ["plan"],
				},
				error: /keyword '\$ref' is not supported/i,
			},
			{
				question: "Question with an invisible required field",
				inputSchema: { type: "object", required: ["missing"] },
				error: /fields missing from properties: missing/i,
			},
			{
				question: "Question with an unsafe form field name",
				inputSchema: {
					type: "object",
					properties: { toString: { type: "string" } },
					required: ["toString"],
				},
				error: /property name 'toString' is not supported/i,
			},
			{
				question: "Question with a hidden required field",
				inputSchema: {
					type: "object",
					properties: { answer: { type: "string" } },
					allOf: [{ required: ["missing"] }],
				},
				error: /keyword 'allOf' is not supported/i,
			},
			{
				question: "Question excluded by not",
				inputSchema: {
					type: "object",
					properties: { answer: { type: "string" } },
					not: {},
				},
				error: /keyword 'not' is not supported/i,
			},
			{
				question: "Question with choices that violate their field type",
				inputSchema: {
					type: "object",
					properties: {
						answer: { type: "number", enum: ["one", "two"] },
					},
					required: ["answer"],
				},
				error: /choices the answer form cannot submit/i,
			},
			{
				question: "Question with a nested object",
				inputSchema: {
					type: "object",
					properties: {
						answer: {
							type: "object",
							properties: { detail: { type: "string" } },
						},
					},
				},
				error: /must not contain a nested object/i,
			},
			{
				question: "Question requiring more fields than its form exposes",
				inputSchema: {
					type: "object",
					properties: { answer: { type: "string" } },
					minProperties: 2,
					additionalProperties: false,
				},
				error:
					/requires at least 2 answered fields but only 1 can be rendered/i,
			},
			{
				question: "Question with an unsafe answer pattern",
				inputSchema: {
					type: "object",
					properties: {
						answer: { type: "string", pattern: "^(a+)+$" },
					},
					required: ["answer"],
				},
				error: /keyword 'pattern' is not supported/i,
			},
			{
				question: "Question with unsafe property-name patterns",
				inputSchema: {
					type: "object",
					properties: { answer: { type: "string" } },
					patternProperties: { "^(a+)+$": { type: "string" } },
				},
				error: /keyword 'patternProperties' is not supported/i,
			},
			{
				question: "Question with asynchronous validation",
				inputSchema: { $async: true, type: "object", properties: {} },
				error: /keyword '\$async' is not supported/i,
			},
			{
				question: "Question with integer array items",
				inputSchema: {
					type: "object",
					properties: {
						codes: {
							type: "array",
							items: { type: "integer" },
							minItems: 1,
						},
					},
					required: ["codes"],
				},
				error: /array property 'codes'.*answer form/i,
			},
			{
				question: "Question with combinator-only typed array items",
				inputSchema: {
					type: "object",
					properties: {
						flags: {
							type: "array",
							items: {
								anyOf: [{ type: "integer" }, { type: "boolean" }],
							},
							minItems: 1,
						},
					},
					required: ["flags"],
				},
				error: /array property 'flags'.*answer form/i,
			},
			{
				question: "Question with contradictory field combinators",
				inputSchema: {
					type: "object",
					properties: {
						answer: {
							anyOf: [{ type: "number" }, { type: "null" }],
							allOf: [{ type: "string" }],
						},
					},
					required: ["answer"],
				},
				error: /keyword 'allOf' is not supported/i,
			},
			{
				question: "Question with contradictory string bounds",
				inputSchema: {
					type: "object",
					properties: {
						answer: { type: "string", minLength: 5, maxLength: 3 },
					},
					required: ["answer"],
				},
				error: /property 'answer'.*length bounds/i,
			},
			{
				question: "Question with contradictory numeric bounds",
				inputSchema: {
					type: "object",
					properties: {
						answer: {
							type: "number",
							minimum: 0,
							exclusiveMinimum: 10,
							maximum: 5,
						},
					},
					required: ["answer"],
				},
				error: /property 'answer'.*numeric bounds/i,
			},
			{
				question: "Question requiring an empty string",
				inputSchema: {
					type: "object",
					properties: { answer: { type: "string", const: "" } },
					required: ["answer"],
				},
				error: /property 'answer'.*answer form/i,
			},
			{
				question: "Question with boolean array items",
				inputSchema: {
					type: "object",
					properties: {
						flags: {
							type: "array",
							items: { type: "boolean" },
							minItems: 1,
						},
					},
					required: ["flags"],
				},
				error: /array property 'flags'.*answer form/i,
			},
		];

		for (const testCase of cases) {
			await expect(
				send({
					title: testCase.question,
					input_schema: testCase.inputSchema,
				}),
			).rejects.toThrow(testCase.error);
		}

		const sql = getTestDb();
		const runs = await sql`
			SELECT id FROM runs
			WHERE organization_id = ${orgId}
				AND action_key = 'agent_ask'
				AND action_input->>'question' = ANY(
					${pgTextArray(cases.map((testCase) => testCase.question))}::text[]
				)
		`;
		expect(runs).toHaveLength(0);
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

	it("cannot attach a caller-supplied ask to another organization's Behavior history", async () => {
		const victimOrg = await createTestOrganization({ name: "ask provenance victim" });
		const victimOwner = await createTestUser({
			email: `ask-victim-${Date.now()}@test.com`,
		});
		await addUserToOrganization(victimOwner.id, victimOrg.id, "owner");
		const sql = getTestDb();
		const [victimBehavior] = await sql`
			WITH next_id AS (SELECT nextval('watchers_id_seq')::integer AS id)
			INSERT INTO watchers (
				id, watcher_group_id, organization_id, agent_id, created_by, name, slug
			)
			SELECT id, id, ${victimOrg.id}, 'victim-agent', ${victimOwner.id},
				'Victim behavior', ${`victim-behavior-${Date.now()}`}
			FROM next_id
			RETURNING id
		`;
		const victimBehaviorId = Number(victimBehavior.id);
		const [victimWindow] = await sql`
			INSERT INTO events (
				organization_id, semantic_type, payload_type, payload_data,
				metadata, occurred_at, created_at, created_by
			) VALUES (
				${victimOrg.id}, 'canvas_state', 'json_template', '{}'::jsonb,
				${sql.json({ watcher_id: victimBehaviorId })},
				NOW(), NOW(), ${victimOwner.id}
			)
			RETURNING id
		`;
		const victimWindowId = Number(victimWindow.id);

		const sent = await send({
			title: "Forged cross-org review",
			body: "This must never enter the victim Behavior prompt.",
			input_schema: { type: "object" },
			behavior_source: {
				behavior_id: victimBehaviorId,
				window_id: victimWindowId,
			},
		});
		const [run] = await sql`
			SELECT watcher_id, window_id FROM runs WHERE id = ${sent.run_id}
		`;
		expect(run.watcher_id).toBeNull();
		expect(run.window_id).toBeNull();
		const linked = await sql`
			SELECT id FROM watcher_reactions WHERE run_id = ${sent.run_id}
		`;
		expect(linked).toHaveLength(0);

		// Historical malformed rows are filtered on read as well: a feedback row
		// cannot borrow a run or Behavior from a different organization.
		await sql`
			INSERT INTO watcher_reactions (
				organization_id, watcher_id, window_id, reaction_type,
				tool_name, tool_args, run_id
			) VALUES (
				${orgId}, ${victimBehaviorId}, ${victimWindowId},
				'notification_sent', 'notify',
				${sql.json({ title: "Forged cross-org review" })}, ${sent.run_id}
			)
		`;
		expect(await getPastReactionsSummary(victimBehaviorId)).toBeUndefined();
	});

	it("repairs a missing Behavior feedback edge when an idempotent ask retries", async () => {
		const sql = getTestDb();
		const suffix = `${process.pid}_${Date.now()}`;
		const sequenceName = `ask_reaction_fail_seq_${suffix}`;
		const functionName = `ask_reaction_fail_fn_${suffix}`;
		const triggerName = `ask_reaction_fail_trigger_${suffix}`;
		await sql.unsafe(`CREATE SEQUENCE ${sequenceName}`);
		await sql.unsafe(`
			CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
			BEGIN
				IF nextval('${sequenceName}') = 1 THEN
					RAISE EXCEPTION 'forced watcher reaction failure';
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql
		`);
		await sql.unsafe(`
			CREATE TRIGGER ${triggerName}
			BEFORE INSERT ON watcher_reactions
			FOR EACH ROW
			WHEN (NEW.watcher_id = ${behaviorId} AND NEW.tool_name = 'notify')
			EXECUTE FUNCTION ${functionName}()
		`);

		const idempotencyKey = `ask-reaction-repair:${suffix}`;
		const args = {
			action: "send",
			title: "Was the staged LinkedIn comment relevant?",
			body: "Draft: Durable state makes this workflow dependable.",
			input_schema: {
				type: "object",
				properties: {
					outcome: { enum: ["posted_unchanged", "posted_edited"] },
				},
				required: ["outcome"],
			},
			idempotency_key: idempotencyKey,
		};

		try {
			await expect(
				executeTool("notify", args, TEST_ENV, behaviorCtx)
			).rejects.toThrow(/forced watcher reaction failure/i);

			const notificationsAfterFailure = await sql`
				SELECT id FROM events
				WHERE organization_id = ${orgId}
				  AND metadata->>'_lobu_idempotency_key' = ${idempotencyKey}
			`;
			expect(notificationsAfterFailure).toHaveLength(1);

			const retry = (await executeTool(
				"notify",
				args,
				TEST_ENV,
				behaviorCtx
			)) as SendResult;
			expect(retry).toMatchObject({
				notified_count: 0,
				event_id: Number(notificationsAfterFailure[0]?.id),
			});
			expect(retry.run_id).toBeGreaterThan(0);

			const reactions = await sql`
				SELECT id FROM watcher_reactions
				WHERE organization_id = ${orgId}
				  AND watcher_id = ${behaviorId}
				  AND window_id = ${windowId}
				  AND run_id = ${retry.run_id}
				  AND tool_name = 'notify'
			`;
			expect(reactions).toHaveLength(1);

			await executeTool(
				"manage_operations",
				{
					action: "reject",
					run_id: retry.run_id,
					reason: "This discussion was not relevant to our product.",
				},
				TEST_ENV,
				humanCtx
			);
			const summary = await getPastReactionsSummary(behaviorId);
			expect(summary).toContain("Was the staged LinkedIn comment relevant?");
			expect(summary).toContain(
				"This discussion was not relevant to our product."
			);
		} finally {
			await sql.unsafe(
				`DROP TRIGGER IF EXISTS ${triggerName} ON watcher_reactions`
			);
			await sql.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
			await sql.unsafe(`DROP SEQUENCE IF EXISTS ${sequenceName}`);
		}
	});
});
