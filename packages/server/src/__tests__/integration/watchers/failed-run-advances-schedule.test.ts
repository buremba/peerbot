import { describe, expect, it } from "vitest";
import { materializeDueWatcherRuns } from "../../../watchers/automation";
import { resolveWatcherRunsByMessageIds } from "../../../watchers/run-completion";
import { advanceWatcherSchedule } from "../../../watchers/schedule-cursor";
import { getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

async function createDueWatcherWithDispatchedRun(opts: {
  slug: string;
  messageId: string;
  nudgeCount?: number;
  dispatchSource?: "scheduled" | "event";
  skipIfUnchanged?: boolean;
}) {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({
    name: `Failed Run Advance ${opts.slug}`,
  });
  const entity = await createTestEntity({
    name: "Advance Entity",
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: `advance-agent-${opts.slug}`,
    name: "Advance Agent",
  });

  const behavior = (await workspace.owner.behaviors.create({
    entity_id: entity.id,
    slug: opts.slug,
    name: "Advance Behavior",
    prompt: "Summarize content for {{entities}}.",
    triggers: [
      {
        kind: "schedule",
        cron: "0 * * * *",
        execution: "window",
        active_run: "coalesce",
        skip_if_unchanged: opts.skipIfUnchanged ?? false,
      },
    ],
    agent_id: agent.agentId,
  })) as { behavior_id: string };
  const watcherId = Number(behavior.behavior_id);

  // A stale cursor remains due until a terminal run advances it.
  const staleCursor = new Date(Date.now() - 60_000);
  await sql`
    UPDATE watchers SET next_run_at = ${staleCursor}::timestamptz
    WHERE id = ${watcherId}
  `;

  const [run] = await sql`
    INSERT INTO runs (organization_id, run_type, watcher_id, status,
                      dispatched_message_id, approved_input)
    VALUES (${workspace.org.id}, 'behavior', ${watcherId}, 'running',
            ${opts.messageId},
            ${sql.json({
              finalize_nudge_count: opts.nudgeCount ?? 99,
              dispatch_source: opts.dispatchSource ?? "scheduled",
            })})
    RETURNING id
  `;

  return {
    sql,
    watcherId,
    runId: Number(run.id),
    staleCursor,
  };
}

async function cursorOf(watcherId: number): Promise<Date> {
  const sql = getTestDb();
  const [row] =
    await sql`SELECT next_run_at FROM watchers WHERE id = ${watcherId}`;
  return new Date(row.next_run_at as string);
}

describe("a terminally failed Behavior run advances next_run_at", () => {
  it("advances the cursor when the agent turn returns an error", async () => {
    const { watcherId, runId, staleCursor } =
      await createDueWatcherWithDispatchedRun({
        slug: "advance-on-turn-error",
        messageId: "msg-turn-error",
      });

    await resolveWatcherRunsByMessageIds(
      ["msg-turn-error"],
      {
        ok: false,
        error: "provider returned 429",
      }
    );

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(watcherId);
    expect(after.getTime()).toBeGreaterThan(staleCursor.getTime());
    expect(after.getTime()).toBeGreaterThan(Date.now());
  });

  it("advances the cursor when the agent never calls complete_window", async () => {
    const { watcherId, runId, staleCursor } =
      await createDueWatcherWithDispatchedRun({
        slug: "advance-on-finalize-miss",
        messageId: "msg-finalize-miss",
        // Past the nudge budget, so this resolves terminally rather than requeuing.
        nudgeCount: 99,
      });

    await resolveWatcherRunsByMessageIds(["msg-finalize-miss"], { ok: true });

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(watcherId);
    expect(after.getTime()).toBeGreaterThan(staleCursor.getTime());
    expect(after.getTime()).toBeGreaterThan(Date.now());
  });

  it("does NOT advance for an event-dispatched run", async () => {
    // Event delivery is independent of the cron cursor. If a failing event
    // delivery advanced it, that Behavior would silently skip its next
    // scheduled activation — a missed run, caused by an unrelated failure.
    // `failWatcherRun` carves this out; without the same carve-out here the two
    // failure paths would disagree about what a failure means.
    const { watcherId, runId, staleCursor } =
      await createDueWatcherWithDispatchedRun({
        slug: "no-advance-on-event",
        messageId: "msg-event-dispatch",
        dispatchSource: "event",
      });

    await resolveWatcherRunsByMessageIds(["msg-event-dispatch"], {
      ok: false,
      error: "provider exploded",
    });

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(watcherId);
    expect(after.getTime()).toBe(staleCursor.getTime());
  });

  it("leaves the cursor alone while a finalize nudge requeues the run", async () => {
    const { watcherId, staleCursor } = await createDueWatcherWithDispatchedRun({
      slug: "no-advance-on-requeue",
      messageId: "msg-requeue",
      nudgeCount: 0,
    });

    await resolveWatcherRunsByMessageIds(["msg-requeue"], { ok: true });

    const after = await cursorOf(watcherId);
    expect(after.getTime()).toBe(staleCursor.getTime());
  });

  it("one Behavior with an unparseable cron cannot abort the whole tick", async () => {
    const { sql, watcherId, runId } =
      await createDueWatcherWithDispatchedRun({
        slug: "corrupt-cron-tick-isolation",
        messageId: "msg-corrupt-cron",
        skipIfUnchanged: true,
      });
    await sql`UPDATE runs SET status = 'failed' WHERE id = ${runId}`;
    await sql`
      UPDATE watchers SET schedule = 'not-a-cron' WHERE id = ${watcherId}
    `;

    try {
      await expect(materializeDueWatcherRuns()).resolves.toBeDefined();

      // Asserting the PARK is what makes this bite: without it the tick still
      // resolves (materializeDueItems catches per item), so a bare
      // "resolves" assertion would pass even with the guard removed.
      const [watcher] =
        await sql`SELECT next_run_at FROM watchers WHERE id = ${watcherId}`;
      expect(watcher.next_run_at).toBeNull();
    } finally {
      await sql`
        UPDATE watchers
        SET schedule = '0 * * * *', next_run_at = NOW() + INTERVAL '1 hour'
        WHERE id = ${watcherId}
      `;
    }
  });

  it("parks a Behavior whose cron is unparseable instead of throwing", async () => {
    // An unparseable cron is PERMANENT — retrying can never fix it. Throwing
    // would roll the run-failure back forever, and because
    // `dispatchWatcherRun` calls `failWatcherRun` from inside its own `catch`
    // (and `dispatchPendingWatcherRuns` has no per-run guard) the throw would
    // escape both and abort the dispatch tick for every org. So the run must
    // still reach `failed`, and the Behavior must be parked.
    const { sql, watcherId, runId } = await createDueWatcherWithDispatchedRun({
      slug: "park-on-unparseable-cron",
      messageId: "msg-invalid-schedule",
    });
    await sql`
      UPDATE watchers SET schedule = 'not-a-cron'
      WHERE id = ${watcherId}
    `;

    try {
      await expect(
        resolveWatcherRunsByMessageIds(["msg-invalid-schedule"], {
          ok: false,
          error: "provider exploded",
        })
      ).resolves.toBeDefined();

      const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
      expect(run.status).toBe("failed");

      // NULL drops out of the `next_run_at <= now()` due predicate, so the
      // broken Behavior stops re-selecting every tick.
      const [watcher] =
        await sql`SELECT next_run_at FROM watchers WHERE id = ${watcherId}`;
      expect(watcher.next_run_at).toBeNull();
    } finally {
      await sql`
        UPDATE watchers
        SET schedule = '0 * * * *', next_run_at = NOW() + INTERVAL '1 hour'
        WHERE id = ${watcherId}
      `;
    }
  });

  // The transactional failure path is only meaningful if TRANSIENT errors still
  // surface. Parking must not swallow a dead connection — at EITHER query, so
  // covering only the UPDATE would let a swallowed SELECT through.
  for (const failAtQuery of [1, 2]) {
    const label = failAtQuery === 1 ? "the schedule SELECT" : "the cursor UPDATE";
    it(`propagates a database error from ${label} so the caller can roll back`, async () => {
      let queries = 0;
      const failingSql = (async () => {
        queries++;
        if (queries === failAtQuery) {
          throw new Error("connection terminated unexpectedly");
        }
        return [{ schedule: "0 * * * *", timezone: null }];
      }) as unknown as Parameters<typeof advanceWatcherSchedule>[0];

      await expect(advanceWatcherSchedule(failingSql, 1)).rejects.toThrow(
        /connection terminated/
      );
      expect(queries).toBe(failAtQuery);
    });
  }
});
