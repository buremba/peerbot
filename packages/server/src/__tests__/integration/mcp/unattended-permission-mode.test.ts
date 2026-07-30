/**
 * `execution_config.permission_mode` must actually govern the MCP tool-approval
 * gate for a headless Behavior run.
 *
 * Before this was wired, the field was validated at the tool boundary,
 * role-gated to owner/admin, persisted, and shipped to the worker — and read by
 * nobody. An operator who set `dontAsk` on a scheduled Behavior got a run that
 * still blocked on an approval card no human could answer, because a scheduled
 * dispatch has no human in the loop. That is what stranded ~2,100 consecutive
 * runs of Behavior 5 in prod.
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
 * Asserting on the shape rather than on a specific network message keeps the
 * test from re-breaking every time the forward path's failure text changes
 * (it already differs between DNS failure and the SSRF guard).
 */

import { generateWorkerToken } from "@lobu/core";
import { beforeEach, describe, expect, it } from "vitest";
import { McpProxy } from "../../../gateway/auth/mcp/proxy";
import { GrantStore } from "../../../gateway/permissions/grant-store";
import { orgContext } from "../../../lobu/stores/org-context";
import { getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const APPROVAL_TEXT = /requires approval/i;

// Minimal McpConfigSource: we only need the gate that runs before the upstream
// is contacted. The host is deliberately unresolvable (see file header).
const fakeConfigService = {
	getHttpServer: async () => ({
		url: "http://upstream.invalid/mcp",
		type: "http" as const,
	}),
	getAllHttpServers: async () => new Map(),
};

interface Scenario {
	organizationId: string;
	agentId: string;
	watcherId: number;
	runId: number;
}

let counter = 0;

/**
 * A Behavior with the given `permission_mode` plus a live run row for it.
 * `permissionMode: null` leaves execution_config untouched (the default).
 */
async function scenario(permissionMode: string | null): Promise<Scenario> {
	const sql = getTestDb();
	const slug = `unattended-${++counter}`;
	const workspace = await TestWorkspace.create({ name: `Unattended ${slug}` });
	const entity = await createTestEntity({
		name: "Unattended Entity",
		organization_id: workspace.org.id,
		created_by: workspace.users.owner.id,
	});
	const agent = await createTestAgent({
		organizationId: workspace.org.id,
		ownerUserId: workspace.users.owner.id,
		agentId: `unattended-agent-${slug}`,
		name: "Unattended Agent",
	});

	const behavior = (await workspace.owner.behaviors.create({
		entity_id: entity.id,
		slug,
		name: "Unattended Behavior",
		prompt: "Summarize content for {{entities}}.",
		triggers: [
			{
				kind: "schedule",
				cron: "0 * * * *",
				execution: "window",
				active_run: "coalesce",
				skip_if_unchanged: false,
			},
		],
		agent_id: agent.agentId,
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

	const [run] = await sql`
    INSERT INTO runs (organization_id, run_type, watcher_id, status, approved_input)
    VALUES (${workspace.org.id}, 'behavior', ${watcherId}, 'running',
            ${sql.json({ dispatch_source: "scheduled" })})
    RETURNING id
  `;

	return {
		organizationId: workspace.org.id,
		agentId: agent.agentId,
		watcherId,
		runId: Number(run.id),
	};
}

/** Drive a write-capable tool call through the real proxy gate. */
async function callTool(opts: {
	organizationId: string;
	agentId: string;
	runId?: number;
}): Promise<{ blocked: boolean; reachedForwardPath: boolean; body: string }> {
	const proxy = new McpProxy(fakeConfigService as never, {
		grantStore: new GrantStore(),
	});

	const token = generateWorkerToken(
		"u1",
		`${opts.agentId}_watcher_1_run_${opts.runId ?? 0}`,
		"deployment-1",
		{
			channelId: "c1",
			agentId: opts.agentId,
			organizationId: opts.organizationId,
			source: "watcher-run",
			...(opts.runId === undefined ? {} : { runId: opts.runId }),
		},
	);

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

	const json = (await response.json()) as {
		result?: unknown;
		error?: unknown;
	};
	const body = JSON.stringify(json);
	return {
		blocked: APPROVAL_TEXT.test(body),
		reachedForwardPath: json.error !== undefined && json.result === undefined,
		body,
	};
}

describe("permission_mode governs the MCP tool-approval gate", () => {
	beforeEach(() => {
		counter += 1;
	});

	for (const mode of ["dontAsk", "bypassPermissions"]) {
		it(`lets a headless Behavior run through when permission_mode is '${mode}'`, async () => {
			const s = await scenario(mode);
			const { blocked, reachedForwardPath } = await callTool(s);

			expect(blocked).toBe(false);
			// Positive proof it reached the forward path rather than silently
			// short-circuiting somewhere else in the gate.
			expect(reachedForwardPath).toBe(true);
		});
	}

	for (const mode of [null, "default", "plan", "auto", "acceptEdits"]) {
		it(`still requires approval when permission_mode is ${mode ?? "unset"}`, async () => {
			const s = await scenario(mode);
			const { blocked } = await callTool(s);

			expect(blocked).toBe(true);
		});
	}

	it("does not let an elevated Behavior leak the bypass to a run of another Behavior", async () => {
		const elevated = await scenario("dontAsk");
		const plain = await scenario("default");

		// Same org and agent shape, but the token names the PLAIN run.
		const { blocked } = await callTool({
			organizationId: plain.organizationId,
			agentId: plain.agentId,
			runId: plain.runId,
		});

		expect(blocked).toBe(true);
		// Sanity: the elevated one is genuinely elevated, so the assertion above
		// is about run scoping and not about the bypass being broken outright.
		expect((await callTool(elevated)).blocked).toBe(false);
	});

	it("still requires approval for an interactive turn that carries no runId", async () => {
		const s = await scenario("dontAsk");

		const { blocked } = await callTool({
			organizationId: s.organizationId,
			agentId: s.agentId,
			// No runId: a browser/chat turn. A human is present to answer the card,
			// and the bypass must never apply to one.
		});

		expect(blocked).toBe(true);
	});

	it("still requires approval when the run is not a Behavior run", async () => {
		const s = await scenario("dontAsk");
		const sql = getTestDb();

		// A chat run in the same org: no watcher_id, so no execution_config to
		// consult. Must fall through to the approval gate.
		const [chatRun] = await sql`
      INSERT INTO runs (organization_id, run_type, status)
      VALUES (${s.organizationId}, 'chat_message', 'running')
      RETURNING id
    `;

		const { blocked } = await callTool({
			organizationId: s.organizationId,
			agentId: s.agentId,
			runId: Number(chatRun.id),
		});

		expect(blocked).toBe(true);
	});
});
