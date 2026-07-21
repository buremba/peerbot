/**
 * Behavior scheduling-health surfacing (item 3, #2033).
 *
 * 3.1: manage_behaviors `list` returns a computed `health` field —
 *   `degraded` for an ACTIVE behavior whose next_run_at is overdue past the
 *   missed-firing margin (a behavior that has silently stopped firing), and
 *   `healthy` for a behavior scheduled in the future.
 *
 * 3.2: getSchedulerHealth (the /health/scheduler alarm path) surfaces overdue
 *   active behaviors and stuck-pending behavior runs in `issues[]` — previously
 *   it filtered run_type='sync' ONLY, so behaviors were invisible to alerting.
 *
 * Note on run_type: the watcher→behavior rename (#2034) migrated the
 * runs.run_type enum value 'watcher'→'behavior', so behavior runs now carry
 * run_type='behavior' and the CHECK constraint rejects 'watcher'. The
 * `watcher_id` COLUMN and the `watchers` table stay (internal seam). These
 * tests insert run_type='behavior' to match the migrated schema + the code
 * under test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { getSchedulerHealth } from "../../scheduled/scheduler-health";
import { manageBehaviors } from "../../tools/admin/manage_behaviors";
import { computeBehaviorHealth } from "../../watchers/behavior-health";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestAgent, seedOwnerContext } from "../setup/test-fixtures";

async function createScheduledBehavior(): Promise<{
  behaviorId: number;
  ctx: Awaited<ReturnType<typeof seedOwnerContext>>["ctx"];
}> {
  const { org, user, ctx } = await seedOwnerContext();
  const agent = await createTestAgent({
    organizationId: org.id,
    ownerUserId: user.id,
  });
  const created = await manageBehaviors(
    {
      action: "create",
      slug: `health-behavior-${Date.now()}`,
      name: "Health behavior",
      prompt: "Summarize newly landed content.",
      agent_id: agent.agentId,
      sources: [
        {
          name: "github",
          query: "SELECT id, payload_text FROM events WHERE 1=0",
        },
      ],
      triggers: [
        {
          kind: "schedule",
          cron: "* * * * *",
          execution: "window",
          active_run: "coalesce",
        },
      ],
    },
    {} as Env,
    ctx,
  );
  if (created.action !== "create" || !("behavior_id" in created)) {
    throw new Error("Behavior creation did not complete");
  }
  return { behaviorId: Number(created.behavior_id), ctx };
}

describe("behavior health surfacing (#2033)", () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it("3.1 (unit): computeBehaviorHealth is degraded for an active, overdue behavior", () => {
    const now = Date.now();
    const degraded = computeBehaviorHealth(
      {
        status: "active",
        // Overdue by 30 min — well past the 6-min missed-firing margin.
        nextRunAt: new Date(now - 30 * 60 * 1000).toISOString(),
      },
      now,
    );
    expect(degraded.health).toBe("degraded");
    expect(degraded.reasons.length).toBeGreaterThan(0);

    // A behavior scheduled in the future is healthy.
    const healthy = computeBehaviorHealth(
      { status: "active", nextRunAt: new Date(now + 60 * 1000).toISOString() },
      now,
    );
    expect(healthy.health).toBe("healthy");

    // An in-flight run is NOT false-degraded even if next_run_at slipped.
    const inFlight = computeBehaviorHealth(
      {
        status: "active",
        nextRunAt: new Date(now - 30 * 60 * 1000).toISOString(),
        latestRunStatus: "running",
      },
      now,
    );
    expect(inFlight.health).toBe("healthy");
  });

  it("3.1 (integration): manage_behaviors list returns health='degraded' for an overdue active behavior", async () => {
    const { behaviorId, ctx } = await createScheduledBehavior();
    const sql = getTestDb();
    // Push next_run_at well into the past → missed firing.
    await sql`
      UPDATE watchers
      SET next_run_at = current_timestamp - interval '30 minutes'
      WHERE id = ${behaviorId}
    `;

    const result = await manageBehaviors({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.behaviors.find(
      (b) => String((b as { behavior_id?: unknown }).behavior_id) === String(behaviorId),
    ) as { health?: string; health_reasons?: string[] } | undefined;
    expect(row).toBeDefined();
    expect(row?.health).toBe("degraded");
    expect((row?.health_reasons ?? []).length).toBeGreaterThan(0);
  });

  it("3.1 (integration): a future-scheduled behavior lists as healthy", async () => {
    const { behaviorId, ctx } = await createScheduledBehavior();
    const sql = getTestDb();
    await sql`
      UPDATE watchers
      SET next_run_at = current_timestamp + interval '5 minutes'
      WHERE id = ${behaviorId}
    `;

    const result = await manageBehaviors({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.behaviors.find(
      (b) => String((b as { behavior_id?: unknown }).behavior_id) === String(behaviorId),
    ) as { health?: string } | undefined;
    expect(row?.health).toBe("healthy");
  });

  it("3.1 (integration): a failed latest run degrades an on-schedule behavior", async () => {
    const { behaviorId, ctx } = await createScheduledBehavior();
    const sql = getTestDb();
    // On schedule (future) so the ONLY unhealthy signal is the failed run —
    // proving health reflects the run outcome, not just the scheduler cursor.
    await sql`
      UPDATE watchers
      SET next_run_at = current_timestamp + interval '5 minutes'
      WHERE id = ${behaviorId}
    `;
    await sql`
      INSERT INTO runs
        (organization_id, run_type, watcher_id, status, approval_status,
         error_message, created_at, completed_at)
      VALUES
        (${ctx.organizationId}, 'behavior', ${behaviorId}, 'failed', 'auto',
         'No model is configured', current_timestamp - interval '2 minutes',
         current_timestamp - interval '1 minute')
    `;

    const result = await manageBehaviors({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.behaviors.find(
      (b) => String((b as { behavior_id?: unknown }).behavior_id) === String(behaviorId),
    ) as
      | { health?: string; last_scheduling_error?: string | null }
      | undefined;
    expect(row?.health).toBe("degraded");
    expect(row?.last_scheduling_error).toBe("No model is configured");
  });

  it("3.3: list emits behavior_* lineage keys, never the internal watcher_* names", async () => {
    const { behaviorId, ctx } = await createScheduledBehavior();
    const result = await manageBehaviors({ action: "list" }, {} as Env, ctx);
    if (result.action !== "list") throw new Error("expected list result");
    const row = result.behaviors.find(
      (b) => String((b as { behavior_id?: unknown }).behavior_id) === String(behaviorId),
    ) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row).toHaveProperty("behavior_group_id");
    expect(row).toHaveProperty("source_behavior_id");
    expect(row).not.toHaveProperty("watcher_group_id");
    expect(row).not.toHaveProperty("source_watcher_id");
  });

  it("3.2: getSchedulerHealth surfaces an overdue behavior in issues[]", async () => {
    const { behaviorId } = await createScheduledBehavior();
    const sql = getTestDb();
    // Overdue by 2 hours → past the 1-hour behavior overdue threshold.
    await sql`
      UPDATE watchers
      SET next_run_at = current_timestamp - interval '2 hours'
      WHERE id = ${behaviorId}
    `;

    const health = await getSchedulerHealth({} as Env);
    expect(health.metrics.overdueBehaviors).toBeGreaterThanOrEqual(1);
    expect(health.metrics.behaviorsOverdueByHours).toBeGreaterThan(1);
    expect(health.healthy).toBe(false);
    expect(health.issues.some((i) => /behaviors overdue/i.test(i))).toBe(true);
  });

  it("3.2: getSchedulerHealth surfaces a stuck-pending behavior run in issues[]", async () => {
    const { behaviorId, ctx } = await createScheduledBehavior();
    const sql = getTestDb();
    // Keep next_run_at in the future so the ONLY issue is the stuck run.
    await sql`
      UPDATE watchers
      SET next_run_at = current_timestamp + interval '5 minutes'
      WHERE id = ${behaviorId}
    `;
    const orgId = ctx.organizationId;
    // A pending watcher run created 3 hours ago — past the 2h stale interval.
    await sql`
      INSERT INTO runs
        (organization_id, run_type, watcher_id, status, approval_status, created_at)
      VALUES
        (${orgId}, 'behavior', ${behaviorId}, 'pending', 'auto',
         current_timestamp - interval '3 hours')
    `;

    const health = await getSchedulerHealth({} as Env);
    expect(health.metrics.stalePendingBehaviorRuns).toBeGreaterThanOrEqual(1);
    expect(health.issues.some((i) => /stuck pending/i.test(i))).toBe(true);
  });
});

afterAll(() => {
  // no-op; embedded PG torn down by the global harness.
});
