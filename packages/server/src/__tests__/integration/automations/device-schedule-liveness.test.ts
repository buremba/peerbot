import {
	addAutomationPeriod,
	alignToAutomationWindowStart,
	subtractAutomationPeriod,
} from "@lobu/connector-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
	materializeDueAutomationRuns,
	sweepStaleAutomationRuns,
} from "../../../automations/automation";
import type { Env } from "../../../index";
import { generateWindowToken } from "../../../utils/jwt";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client";

async function setupDeviceAutomation() {
	const sql = getTestDb();
	const workspace = await TestWorkspace.create({ name: "Device Schedule Org" });
	const userId = workspace.users.owner.id;
	const entity = await createTestEntity({
		name: "Device Schedule Entity",
		organization_id: workspace.org.id,
		created_by: userId,
	});
	const agent = await createTestAgent({
		organizationId: workspace.org.id,
		ownerUserId: userId,
		agentId: "device-schedule-agent",
		name: "Device Schedule Agent",
	});
	const created = (await workspace.owner.automations.create({
		entity_id: entity.id,
		slug: "device-schedule",
		name: "Device Schedule",
		prompt: "Summarize the oldest unfinished daily period.",
		triggers: [
			{
				kind: "schedule",
				cron: "0 9 * * *",
				execution: "window",
				active_run: "coalesce",
				skip_if_unchanged: false,
			},
		],
		agent_id: agent.agentId,
	})) as { automation_id: string };
	const automationId = Number(created.automation_id);
	const [device] = await sql<{ id: string }>`
		INSERT INTO device_workers (
			user_id, worker_id, platform, capabilities, label, organization_id,
			agent_kinds, last_seen_at
		) VALUES (
			${userId}, 'device-schedule-mac', 'macos', ${sql.json({})}, 'Schedule Mac',
			${workspace.org.id}, ${"{claude-code}"}::text[],
			current_timestamp - interval '10 minutes'
		)
		RETURNING id
	`;
	await sql`
		UPDATE automations
		SET device_worker_id = ${device.id}::uuid,
			agent_kind = 'claude-code',
			next_run_at = current_timestamp - interval '2 hours'
		WHERE id = ${automationId}
	`;
	const api = await TestApiClient.for({
		organizationId: workspace.org.id,
		userId,
		memberRole: "owner",
	});
	return { sql, api, automationId, deviceId: device.id };
}

async function cursor(sql: ReturnType<typeof getTestDb>, automationId: number) {
	const [row] = await sql<{
		next_run_at: string;
		next_window_start: string;
	}>`
		SELECT next_run_at, next_window_start
		FROM automations WHERE id = ${automationId}
	`;
	return {
		nextRunAt: new Date(row.next_run_at).toISOString(),
		nextWindowStart: new Date(row.next_window_start).toISOString(),
	};
}

describe("device-pinned scheduled Automation liveness (#2538)", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("defers without a run or cursor movement until the exact compatible device reconnects", async () => {
		const { sql, automationId, deviceId } = await setupDeviceAutomation();
		const before = await cursor(sql, automationId);

		const offline = await Promise.all([
			materializeDueAutomationRuns({} as Env),
			materializeDueAutomationRuns({} as Env),
		]);
		expect(offline.reduce((sum, result) => sum + result.runsCreated, 0)).toBe(
			0,
		);
		expect(await cursor(sql, automationId)).toEqual(before);

		await sql`
			UPDATE device_workers
			SET last_seen_at = current_timestamp, agent_kinds = ${"{codex}"}::text[]
			WHERE id = ${deviceId}::uuid
		`;
		expect((await materializeDueAutomationRuns({} as Env)).runsCreated).toBe(0);
		expect(await cursor(sql, automationId)).toEqual(before);

		await sql`
			UPDATE device_workers
			SET last_seen_at = current_timestamp,
				agent_kinds = ${"{claude-code,codex}"}::text[]
			WHERE id = ${deviceId}::uuid
		`;
		const reconnected = await Promise.all([
			materializeDueAutomationRuns({} as Env),
			materializeDueAutomationRuns({} as Env),
		]);
		expect(
			reconnected.reduce((sum, result) => sum + result.runsCreated, 0),
		).toBe(1);

		const [run] = await sql<{
			id: number;
			status: string;
			approved_input: Record<string, unknown>;
		}>`
			SELECT id, status, approved_input FROM runs
			WHERE automation_id = ${automationId} AND run_type = 'automation'
		`;
		expect(run.status).toBe("pending");
		expect(run.approved_input.device_worker_id).toBe(deviceId);
		expect(run.approved_input.agent_kind).toBe("claude-code");
		expect(
			new Date(String(run.approved_input.window_start)).toISOString(),
		).toBe(before.nextWindowStart);

		await sql`
			UPDATE runs SET created_at = current_timestamp - interval '3 hours'
			WHERE id = ${run.id}
		`;
		const swept = await Promise.all([
			sweepStaleAutomationRuns(sql),
			sweepStaleAutomationRuns(sql),
		]);
		expect(swept.reduce((sum, result) => sum + result.timedOut, 0)).toBe(0);
		expect(
			(await sql`SELECT status FROM runs WHERE id = ${run.id}`)[0].status,
		).toBe("pending");
		expect(await cursor(sql, automationId)).toEqual(before);

		const [replacement] = await sql<{ id: string }>`
			INSERT INTO device_workers (
				user_id, worker_id, platform, capabilities, label, organization_id,
				agent_kinds, last_seen_at
			)
			SELECT user_id, 'device-schedule-replacement', 'macos', ${sql.json({})},
				'Replacement Mac', organization_id, ${"{claude-code}"}::text[],
				current_timestamp
			FROM device_workers WHERE id = ${deviceId}::uuid
			RETURNING id
		`;
		await sql`
			UPDATE automations SET device_worker_id = ${replacement.id}::uuid
			WHERE id = ${automationId}
		`;
		await sql`
			UPDATE device_workers SET last_seen_at = current_timestamp - interval '10 minutes'
			WHERE id = ${deviceId}::uuid
		`;
		expect((await sweepStaleAutomationRuns(sql)).timedOut).toBe(0);
		const [retargetedRun] = await sql<{
			status: string;
			approved_input: Record<string, unknown>;
		}>`SELECT status, approved_input FROM runs WHERE id = ${run.id}`;
		expect(retargetedRun.status).toBe("pending");
		expect(retargetedRun.approved_input.device_worker_id).toBe(deviceId);
		expect(await cursor(sql, automationId)).toEqual(before);
		expect((await materializeDueAutomationRuns({} as Env)).runsCreated).toBe(0);

		await sql`DELETE FROM device_workers WHERE id = ${deviceId}::uuid`;
		expect((await sweepStaleAutomationRuns(sql)).timedOut).toBe(1);
		expect(
			(await sql`SELECT status FROM runs WHERE id = ${run.id}`)[0].status,
		).toBe("timeout");
		expect(await cursor(sql, automationId)).toEqual(before);

		expect((await materializeDueAutomationRuns({} as Env)).runsCreated).toBe(1);
		const [retried] = await sql<{ approved_input: Record<string, unknown> }>`
			SELECT approved_input FROM runs
			WHERE automation_id = ${automationId} AND status = 'pending'
		`;
		expect(retried.approved_input.device_worker_id).toBe(replacement.id);
		expect(
			new Date(String(retried.approved_input.window_start)).toISOString(),
		).toBe(before.nextWindowStart);
	});

	it("does not materialize for a fresh headless device that cannot claim Automations", async () => {
		const { sql, automationId, deviceId } = await setupDeviceAutomation();
		const before = await cursor(sql, automationId);
		await sql`
			UPDATE device_workers
			SET platform = 'headless', last_seen_at = current_timestamp,
				capabilities = ${sql.json(["os.shell"])},
				agent_kinds = ${"{claude-code}"}::text[]
			WHERE id = ${deviceId}::uuid
		`;

		expect((await materializeDueAutomationRuns({} as Env)).runsCreated).toBe(0);
		expect(await cursor(sql, automationId)).toEqual(before);
		expect(
			await sql`SELECT id FROM runs WHERE automation_id = ${automationId}`,
		).toHaveLength(0);

		await sql`
			UPDATE device_workers
			SET capabilities = ${sql.json(["automations.execute"])}
			WHERE id = ${deviceId}::uuid
		`;
		expect((await materializeDueAutomationRuns({} as Env)).runsCreated).toBe(1);
	});

	it("completes every missed period oldest-first, then advances to the next cron", async () => {
		const { sql, api, automationId, deviceId } = await setupDeviceAutomation();
		await sql`
			UPDATE device_workers SET last_seen_at = current_timestamp
			WHERE id = ${deviceId}::uuid
		`;
		const closedBoundary = alignToAutomationWindowStart(new Date(), "daily");
		let oldest = closedBoundary;
		for (let count = 0; count < 3; count += 1) {
			oldest = subtractAutomationPeriod(oldest, "daily");
		}
		await sql`
			UPDATE automations
			SET next_window_start = ${oldest.toISOString()}::timestamptz,
				completed_window_coverage = '{}'::tstzmultirange,
				window_projection_granularity = 'daily',
				next_run_at = current_timestamp - interval '2 hours'
			WHERE id = ${automationId}
		`;

		for (let period = 0; period < 3; period += 1) {
			const materialized = await Promise.all([
				materializeDueAutomationRuns({} as Env),
				materializeDueAutomationRuns({} as Env),
			]);
			expect(
				materialized.reduce((sum, result) => sum + result.runsCreated, 0),
			).toBe(1);
			const [run] = await sql<{
				id: number;
				approved_input: Record<string, unknown>;
			}>`
				SELECT id, approved_input FROM runs
				WHERE automation_id = ${automationId} AND status = 'pending'
			`;
			const windowStart = new Date(
				String(run.approved_input.window_start),
			).toISOString();
			const windowEnd = new Date(
				String(run.approved_input.window_end),
			).toISOString();
			expect(windowStart).toBe(oldest.toISOString());

			await sql`
				UPDATE runs SET status = 'running', claimed_at = current_timestamp,
					claimed_by = 'device-schedule-mac'
				WHERE id = ${run.id}
			`;
			const windowToken = await generateWindowToken(
				{
					automation_id: automationId,
					run_id: run.id,
					window_start: windowStart,
					window_end: windowEnd,
					granularity: "daily",
					content_count: 0,
					content_ids: [],
				},
				{ JWT_SECRET: "test-jwt-secret-for-testing-only" } as Env,
			);
			await api.automations.completeWindow({
				automation_id: String(automationId),
				run_id: run.id,
				window_token: windowToken,
				extracted_data: { summary: `period ${period + 1}` },
			});

			oldest = addAutomationPeriod(oldest, "daily");
			const after = await cursor(sql, automationId);
			expect(after.nextWindowStart).toBe(oldest.toISOString());
			if (period < 2) {
				expect(new Date(after.nextRunAt).getTime()).toBeLessThanOrEqual(
					Date.now(),
				);
			} else {
				expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
			}
		}

		expect(oldest.toISOString()).toBe(closedBoundary.toISOString());
		expect(
			await sql`SELECT id FROM runs WHERE automation_id = ${automationId}`,
		).toHaveLength(3);
	});
});
