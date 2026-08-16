/**
 * operations.list_runs — operational filters + streaming-noise exclusion (#2051).
 *
 * A production MCP run showed list_runs mixing connector actions, feed syncs,
 * automation runs, AND every chat-message transport row (complete replies and
 * per-delta streaming fragments are each a `runs` row with
 * run_type='chat_message'). Real operation history was buried under tens of
 * thousands of streaming fragments.
 *
 * Proves:
 *  - default list EXCLUDES 'chat_message' transport runs;
 *  - explicit run_types:['chat_message'] still returns them (trace view);
 *  - trace input secrets are redacted without corrupting run timestamps;
 *  - new connector_key filter narrows to one connector;
 *  - new created_after / created_before date-range filters work;
 *  - invalid date input is a clean error, not a SQL failure.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageOperations } from "../../../tools/admin/manage_operations";
import type { ToolContext } from "../../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestConnection,
	createTestOrganization,
} from "../../setup/test-fixtures";

const env = {} as Env;

describe("manage_operations list_runs — operational filters (#2051)", () => {
	let orgId: string;
	let githubConnId: number;
	let slackConnId: number;

	const ctx = (): ToolContext => ({
		organizationId: orgId,
		userId: "list-runs-owner",
		memberRole: "owner",
		isAuthenticated: true,
		tokenType: "oauth",
		scopes: ["mcp:admin"],
		scopedToOrg: false,
		allowCrossOrg: false,
	});

	const insertRun = async (opts: {
		run_type: string;
		connection_id?: number | null;
		connector_key?: string | null;
		action_key?: string | null;
		action_input?: Record<string, unknown> | null;
		status?: string;
		created_at?: string;
	}): Promise<number> => {
		const db = getTestDb();
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, connection_id, connector_key, action_key, action_input, status, created_at, run_at)
      VALUES (
        ${orgId}, ${opts.run_type}, ${opts.connection_id ?? null},
        ${opts.connector_key ?? null}, ${opts.action_key ?? null},
        ${opts.action_input ? db.json(opts.action_input) : null},
        ${opts.status ?? "completed"},
        ${opts.created_at ?? new Date().toISOString()},
        ${opts.created_at ?? new Date().toISOString()}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		return Number(row.id);
	};

	const listRuns = async (
		extra: Record<string, unknown> = {},
	): Promise<{ runs: Array<Record<string, unknown>>; total: number }> => {
		const res = (await manageOperations(
			{ action: "list_runs", limit: 100, ...extra },
			env,
			ctx(),
		)) as { runs?: Array<Record<string, unknown>>; total?: number };
		expect(res.runs, JSON.stringify(res)).toBeDefined();
		return { runs: res.runs ?? [], total: Number(res.total ?? 0) };
	};

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "ListRuns Filters" });
		orgId = org.id;
		const github = await createTestConnection({
			organization_id: orgId,
			connector_key: "github",
		});
		githubConnId = github.id;
		const slack = await createTestConnection({
			organization_id: orgId,
			connector_key: "slack",
		});
		slackConnId = slack.id;

		// Operational runs.
		await insertRun({
			run_type: "action",
			connection_id: githubConnId,
			connector_key: "github",
			action_key: "create_issue",
			created_at: "2026-07-10T12:00:00Z",
		});
		await insertRun({
			run_type: "sync",
			connection_id: slackConnId,
			connector_key: "slack",
			created_at: "2026-07-12T12:00:00Z",
		});
		await insertRun({
			run_type: "automation",
			created_at: "2026-07-14T12:00:00Z",
		});
		// Chat transport noise: complete reply + streaming fragments all land as
		// run_type='chat_message' rows via the thread_response queue.
		for (let i = 0; i < 5; i++) {
			await insertRun({
				run_type: "chat_message",
				action_key: "thread_response",
				action_input:
					i === 0
						? {
								runJobToken: "live-worker-bearer",
								nested: { authorization: "Bearer live-worker-bearer" },
								safe: "trace context",
							}
						: null,
				created_at: `2026-07-15T12:00:0${i}Z`,
			});
		}
	});

	it("excludes chat_message transport runs from the default operational list", async () => {
		const { runs } = await listRuns();
		const types = new Set(runs.map((r) => r.run_type));
		expect(types.has("chat_message")).toBe(false);
		// Operational lanes still present.
		expect(types.has("action")).toBe(true);
		expect(types.has("sync")).toBe(true);
		expect(types.has("automation")).toBe(true);
	});

	it("default total also excludes the transport noise", async () => {
		const { total } = await listRuns();
		expect(total).toBe(3);
	});

	it("explicit run_types:['chat_message'] still exposes the trace view", async () => {
		const { runs, total } = await listRuns({ run_types: ["chat_message"] });
		expect(total).toBe(5);
		expect(runs.every((r) => r.run_type === "chat_message")).toBe(true);
	});

	it("redacts bearer credentials from the explicit trace view", async () => {
		const { runs } = await listRuns({ run_types: ["chat_message"] });
		const credentialBearing = runs.find(
			(run) =>
				(run.input as { safe?: string } | null)?.safe === "trace context",
		);
		expect(credentialBearing?.input).toEqual({
			runJobToken: "__LOBU_REDACTED__",
			nested: { authorization: "__LOBU_REDACTED__" },
			safe: "trace context",
		});
		expect(JSON.stringify(credentialBearing)).not.toContain(
			"live-worker-bearer",
		);
		expect(credentialBearing?.created_at).toBeInstanceOf(Date);
		expect((credentialBearing?.created_at as Date).toISOString()).toBe(
			"2026-07-15T12:00:00.000Z",
		);
	});

	it("filters by connector_key", async () => {
		const { runs, total } = await listRuns({ connector_key: "github" });
		expect(total).toBe(1);
		expect(runs[0]?.connector_key).toBe("github");
		expect(runs[0]?.operation_key).toBe("create_issue");
	});

	it("filters by created_after / created_before date range", async () => {
		const { runs, total } = await listRuns({
			created_after: "2026-07-11T00:00:00Z",
			created_before: "2026-07-13T00:00:00Z",
		});
		expect(total).toBe(1);
		expect(runs[0]?.run_type).toBe("sync");
	});

	it("rejects an unparseable date bound cleanly", async () => {
		await expect(
			manageOperations(
				{ action: "list_runs", created_after: "not-a-date" },
				env,
				ctx(),
			),
		).rejects.toThrow(/created_after/i);
	});
});
