import { inferAutomationGranularityFromSchedule } from "@lobu/connector-sdk";
import type { AutomationTriggerResult } from "@lobu/core/contracts/tools/manage-automations";
import { beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../../db/client";
import { createAutomationRun } from "../../../runs/queue-service";
import { computePendingWindow } from "../../../utils/window-utils";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

describe("Automation trigger execution contract", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("directs an agentless manual run through the external completion protocol", async () => {
		const workspace = await TestWorkspace.create({
			name: "External Trigger Org",
		});
		const entity = await createTestEntity({
			name: "External Trigger Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "external-trigger-contract",
			name: "External Trigger Contract",
			prompt: "Summarize the current window.",
			agent_id: null,
		})) as { automation_id: string };

		const triggered = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;

		expect(triggered).toEqual({
			action: "trigger",
			automation_id: automation.automation_id,
			run_id: triggered.run_id,
			status: "pending",
			created: true,
			execution: {
				lane: "external_client",
				owner: "caller",
				next_action: {
					kind: "complete_window",
					read: {
						method: "knowledge.read",
						input: {
							automation_id: Number(automation.automation_id),
							run_id: triggered.run_id,
						},
					},
					// biome-ignore lint/suspicious/noThenProperty: Exact public protocol assertion.
					then: "automations.completeWindow",
				},
			},
		});

		const retargetAgent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
			agentId: "external-retarget-agent",
		});
		await workspace.owner.automations.update({
			automation_id: automation.automation_id,
			agent_id: retargetAgent.agentId,
		});
		const retriggered = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;
		expect(retriggered.run_id).toBe(triggered.run_id);
		expect(retriggered.created).toBe(false);
		expect(retriggered.execution).toEqual(triggered.execution);
	});

	it("coalesces concurrent external triggers without poisoning either transaction", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Concurrent Trigger Org",
		});
		const entity = await createTestEntity({
			name: "Concurrent Trigger Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "concurrent-trigger-contract",
			name: "Concurrent Trigger Contract",
			prompt: "Summarize the current window.",
			agent_id: null,
		})) as { automation_id: string };

		const results = (await Promise.all([
			workspace.owner.automations.trigger({
				automation_id: automation.automation_id,
			}),
			workspace.owner.automations.trigger({
				automation_id: automation.automation_id,
			}),
		])) as AutomationTriggerResult[];

		expect(results.map((result) => result.created).sort()).toEqual([false, true]);
		expect(new Set(results.map((result) => result.run_id)).size).toBe(1);
		expect(results[0].execution).toEqual(results[1].execution);
		expect(results[0].execution.lane).toBe("external_client");
		const runs = await sql`
      SELECT id FROM runs WHERE automation_id = ${Number(automation.automation_id)}
    `;
		expect(runs).toHaveLength(1);
	});

	it("keeps the persisted device lane when the Automation is retargeted", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Device Trigger Org",
		});
		const entity = await createTestEntity({
			name: "Device Trigger Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const [device] = await sql<{ id: string }>`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id
      ) VALUES (
        ${workspace.users.owner.id}, 'trigger-device-a', 'macos',
        ${sql.json({})}, 'Device A', ${workspace.org.id}
      )
      RETURNING id::text AS id
    `;
		const retargetAgent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
			agentId: "device-retarget-agent",
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "device-trigger-contract",
			name: "Device Trigger Contract",
			prompt: "Summarize the current window.",
			agent_id: null,
			device_worker_id: device.id,
			agent_kind: "claude-code",
		})) as { automation_id: string };

		const first = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;
		expect(first.execution).toEqual({
			lane: "device_worker",
			owner: "device",
			device_worker_id: device.id,
			agent_kind: "claude-code",
			next_action: { kind: "handled_elsewhere" },
		});
		expect(first.created).toBe(true);

		// Persisted dual-id snapshots still exist on the claim-next-window path.
		// Device-first resolution is authoritative for those rows.
		await sql`
      UPDATE runs
      SET approved_input = approved_input
        || jsonb_build_object('agent_id', ${retargetAgent.agentId}::text)
      WHERE id = ${first.run_id}
    `;
		await workspace.owner.automations.update({
			automation_id: automation.automation_id,
			agent_id: retargetAgent.agentId,
			device_worker_id: null,
			agent_kind: null,
		});
		const retriggered = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;

		expect(retriggered).toEqual({
			action: "trigger",
			automation_id: automation.automation_id,
			run_id: first.run_id,
			status: "pending",
			created: false,
			execution: {
				lane: "device_worker",
				owner: "device",
				device_worker_id: device.id,
				agent_kind: "claude-code",
				next_action: { kind: "handled_elsewhere" },
			},
		});
	});

	it("uses the persisted managed-agent lane for gateway preflight after retargeting", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Managed Trigger Org",
		});
		const entity = await createTestEntity({
			name: "Managed Trigger Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const originalAgent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
			agentId: "trigger-original-agent",
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "managed-trigger-contract",
			name: "Managed Trigger Contract",
			prompt: "Summarize the current window.",
			agent_id: originalAgent.agentId,
		})) as { automation_id: string };
		const pending = await computePendingWindow(
			sql as unknown as DbClient,
			Number(automation.automation_id),
			inferAutomationGranularityFromSchedule(null),
		);
		const queued = await createAutomationRun({
			organizationId: workspace.org.id,
			automationId: Number(automation.automation_id),
			agentId: originalAgent.agentId,
			windowStart: pending.windowStart.toISOString(),
			windowEnd: pending.windowEnd.toISOString(),
			dispatchSource: "manual",
		});
		await sql`
      UPDATE runs
      SET status = 'running', claimed_by = 'lobu-dispatcher', claimed_at = NOW()
      WHERE id = ${queued.runId}
    `;
		await workspace.owner.automations.update({
			automation_id: automation.automation_id,
			agent_id: null,
		});

		await expect(
			workspace.owner.automations.trigger({
				automation_id: automation.automation_id,
			}),
		).rejects.toThrow(/Embedded Lobu is not available/);
		const runs = await sql<{ status: string; approved_input: Record<string, unknown> }>`
      SELECT status, approved_input
      FROM runs
      WHERE automation_id = ${Number(automation.automation_id)}
    `;
		expect(runs).toHaveLength(1);
		expect(runs[0].status).toBe("running");
		expect(runs[0].approved_input.agent_id).toBe(originalAgent.agentId);
	});

	it("preserves the managed-agent gateway preflight without creating a failed run", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Managed Preflight Org",
		});
		const entity = await createTestEntity({
			name: "Managed Preflight Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const agent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
			agentId: "trigger-preflight-agent",
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "managed-trigger-preflight",
			name: "Managed Trigger Preflight",
			prompt: "Summarize the current window.",
			agent_id: agent.agentId,
		})) as { automation_id: string };

		await expect(
			workspace.owner.automations.trigger({
				automation_id: automation.automation_id,
			}),
		).rejects.toThrow(/Embedded Lobu is not available/);
		const runs = await sql`
      SELECT id FROM runs WHERE automation_id = ${Number(automation.automation_id)}
    `;
		expect(runs).toHaveLength(0);
	});
});
