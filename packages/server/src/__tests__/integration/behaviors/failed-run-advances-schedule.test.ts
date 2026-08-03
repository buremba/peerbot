import { describe, expect, it } from "vitest";
import { materializeDueBehaviorRuns } from "../../../behaviors/automation";
import { resolveBehaviorRunsByMessageIds } from "../../../behaviors/run-completion";
import { advanceBehaviorSchedule } from "../../../behaviors/schedule-cursor";
import { getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

async function createDueBehaviorWithDispatchedRun(opts: {
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
  const behaviorId = Number(behavior.behavior_id);

  // A stale cursor remains due until a terminal run advances it.
  const staleCursor = new Date(Date.now() - 60_000);
  await sql`
    UPDATE behaviors SET next_run_at = ${staleCursor}::timestamptz
    WHERE id = ${behaviorId}
  `;

  const [run] = await sql`
    INSERT INTO runs (organization_id, run_type, behavior_id, status,
                      dispatched_message_id, approved_input)
    VALUES (${workspace.org.id}, 'behavior', ${behaviorId}, 'running',
            ${opts.messageId},
            ${sql.json({
              finalize_nudge_count: opts.nudgeCount ?? 99,
              dispatch_source: opts.dispatchSource ?? "scheduled",
            })})
    RETURNING id
  `;

  return {
    sql,
    organizationId: workspace.org.id,
    behaviorId,
    runId: Number(run.id),
    staleCursor,
  };
}

async function cursorOf(behaviorId: number): Promise<Date> {
  const sql = getTestDb();
  const [row] =
    await sql`SELECT next_run_at FROM behaviors WHERE id = ${behaviorId}`;
  return new Date(row.next_run_at as string);
}

describe("a terminally failed Behavior run advances next_run_at", () => {
  it("advances the cursor when the agent turn returns an error", async () => {
    const { behaviorId, runId, staleCursor } =
      await createDueBehaviorWithDispatchedRun({
        slug: "advance-on-turn-error",
        messageId: "msg-turn-error",
      });

    await resolveBehaviorRunsByMessageIds(
      ["msg-turn-error"],
      {
        ok: false,
        error: "provider returned 429",
      }
    );

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(behaviorId);
    expect(after.getTime()).toBeGreaterThan(staleCursor.getTime());
    expect(after.getTime()).toBeGreaterThan(Date.now());
  });

  it("advances the cursor when the agent never calls complete_window", async () => {
    const { behaviorId, runId, staleCursor } =
      await createDueBehaviorWithDispatchedRun({
        slug: "advance-on-finalize-miss",
        messageId: "msg-finalize-miss",
        // Past the nudge budget, so this resolves terminally rather than requeuing.
        nudgeCount: 99,
      });

    await resolveBehaviorRunsByMessageIds(["msg-finalize-miss"], { ok: true });

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(behaviorId);
    expect(after.getTime()).toBeGreaterThan(staleCursor.getTime());
    expect(after.getTime()).toBeGreaterThan(Date.now());
  });

  it("does NOT advance for an event-dispatched run", async () => {
    // Event delivery is independent of the cron cursor. If a failing event
    // delivery advanced it, that Behavior would silently skip its next
    // scheduled activation — a missed run, caused by an unrelated failure.
    // `failBehaviorRun` carves this out; without the same carve-out here the two
    // failure paths would disagree about what a failure means.
    const { behaviorId, runId, staleCursor } =
      await createDueBehaviorWithDispatchedRun({
        slug: "no-advance-on-event",
        messageId: "msg-event-dispatch",
        dispatchSource: "event",
      });

    await resolveBehaviorRunsByMessageIds(["msg-event-dispatch"], {
      ok: false,
      error: "provider exploded",
    });

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(behaviorId);
    expect(after.getTime()).toBe(staleCursor.getTime());
  });

  it("leaves the cursor alone while a finalize nudge requeues the run", async () => {
    const { behaviorId, staleCursor } = await createDueBehaviorWithDispatchedRun({
      slug: "no-advance-on-requeue",
      messageId: "msg-requeue",
      nudgeCount: 0,
    });

    await resolveBehaviorRunsByMessageIds(["msg-requeue"], { ok: true });

    const after = await cursorOf(behaviorId);
    expect(after.getTime()).toBe(staleCursor.getTime());
  });

  it("one Behavior with an unparseable cron cannot abort the whole tick", async () => {
    const { sql, behaviorId, runId } =
      await createDueBehaviorWithDispatchedRun({
        slug: "corrupt-cron-tick-isolation",
        messageId: "msg-corrupt-cron",
        skipIfUnchanged: true,
      });
    await sql`UPDATE runs SET status = 'failed' WHERE id = ${runId}`;
    await sql`
      UPDATE behaviors SET schedule = 'not-a-cron' WHERE id = ${behaviorId}
    `;

    try {
      await expect(materializeDueBehaviorRuns()).resolves.toBeDefined();

      // Asserting the PARK is what makes this bite: without it the tick still
      // resolves (materializeDueItems catches per item), so a bare
      // "resolves" assertion would pass even with the guard removed.
      const [behavior] =
        await sql`SELECT next_run_at FROM behaviors WHERE id = ${behaviorId}`;
      expect(behavior.next_run_at).toBeNull();
    } finally {
      await sql`
        UPDATE behaviors
        SET schedule = '0 * * * *', next_run_at = NOW() + INTERVAL '1 hour'
        WHERE id = ${behaviorId}
      `;
    }
  });

  it("parks a Behavior whose cron is unparseable instead of throwing", async () => {
    // An unparseable cron is PERMANENT — retrying can never fix it. Throwing
    // would roll the run-failure back forever, and because
    // `dispatchBehaviorRun` calls `failBehaviorRun` from inside its own `catch`
    // (and `dispatchPendingBehaviorRuns` has no per-run guard) the throw would
    // escape both and abort the dispatch tick for every org. So the run must
    // still reach `failed`, and the Behavior must be parked.
    const { sql, behaviorId, runId } = await createDueBehaviorWithDispatchedRun({
      slug: "park-on-unparseable-cron",
      messageId: "msg-invalid-schedule",
    });
    await sql`
      UPDATE behaviors SET schedule = 'not-a-cron'
      WHERE id = ${behaviorId}
    `;

    try {
      await expect(
        resolveBehaviorRunsByMessageIds(["msg-invalid-schedule"], {
          ok: false,
          error: "provider exploded",
        })
      ).resolves.toBeDefined();

      const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
      expect(run.status).toBe("failed");

      // NULL drops out of the `next_run_at <= now()` due predicate, so the
      // broken Behavior stops re-selecting every tick.
      const [behavior] =
        await sql`SELECT next_run_at FROM behaviors WHERE id = ${behaviorId}`;
      expect(behavior.next_run_at).toBeNull();
    } finally {
      await sql`
        UPDATE behaviors
        SET schedule = '0 * * * *', next_run_at = NOW() + INTERVAL '1 hour'
        WHERE id = ${behaviorId}
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
      }) as unknown as Parameters<typeof advanceBehaviorSchedule>[0];

      await expect(advanceBehaviorSchedule(failingSql, 1)).rejects.toThrow(
        /connection terminated/
      );
      expect(queries).toBe(failAtQuery);
    });
  }
});

describe("finalize-miss diagnostics", () => {
  it("names the pending tool approval instead of blaming the agent", async () => {
    const { sql, organizationId, behaviorId, runId } =
      await createDueBehaviorWithDispatchedRun({
        slug: "finalize-miss-names-approval",
        messageId: "msg-gated-approval",
        nudgeCount: 99,
      });
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        ${`ta_test_${runId}`},
        'pending-tool',
        ${sql.json({
          mcpId: "lobu-memory",
          toolName: "run_sdk",
          agentId: "advance-agent-finalize-miss-names-approval",
          userId: "u1",
          organizationId,
          args: {},
          conversationId: `personal-agent_behavior_${behaviorId}_run_${runId}`,
        })},
        NOW() + INTERVAL '1 hour'
      )
    `;

    await resolveBehaviorRunsByMessageIds(["msg-gated-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/blocked on tool approval/);
    expect(run.error_message).toMatch(/lobu-memory\/run_sdk/);
    expect(run.error_message).not.toMatch(/finished without calling/);
  });

  it("ignores approvals outside the run's tenant and conversation", async () => {
    const { sql, organizationId, behaviorId, runId } =
      await createDueBehaviorWithDispatchedRun({
        slug: "finalize-miss-scopes-approval",
        messageId: "msg-scoped-approval",
        nudgeCount: 99,
      });
    const pending = (
      id: string,
      toolName: string,
      org: string,
      behaviorId: number
    ) => sql`
        INSERT INTO oauth_states (id, scope, payload, expires_at)
        VALUES (
          ${id},
          'pending-tool',
          ${sql.json({
            mcpId: "lobu-memory",
            toolName,
            agentId: "advance-agent-finalize-miss-scopes-approval",
            userId: "u1",
            organizationId: org,
            args: {},
            conversationId:
              `personal-agent_behavior_${behaviorId}_run_${runId}`,
          })},
          NOW() + INTERVAL '1 hour'
        )
      `;
    await pending(`ta_wrong_org_${runId}`, "wrong_org", "other-org", behaviorId);
    await pending(
      `ta_wrong_behavior_${runId}`,
      "wrong_behavior",
      organizationId,
      behaviorId + 1
    );

    await resolveBehaviorRunsByMessageIds(["msg-scoped-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/No active tool approval was found/);
    expect(run.error_message).not.toMatch(/wrong_org|wrong_behavior/);
  });

  it("falls back to the agent-miss message when nothing is pending", async () => {
    const { sql, runId } = await createDueBehaviorWithDispatchedRun({
      slug: "finalize-miss-no-approval",
      messageId: "msg-no-approval",
      nudgeCount: 99,
    });

    await resolveBehaviorRunsByMessageIds(["msg-no-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/finished without calling/);
    expect(run.error_message).toMatch(/No active tool approval was found/);
  });
});
