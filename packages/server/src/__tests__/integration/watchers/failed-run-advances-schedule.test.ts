import { describe, expect, it } from "vitest";
import { ApiResponseRenderer } from "../../../gateway/api/response-renderer";
import { materializeDueWatcherRuns } from "../../../watchers/automation";
import { resolveWatcherRunsByMessageIds } from "../../../watchers/run-completion";
import {
  advanceWatcherSchedule,
  parseProviderQuotaResetAt,
} from "../../../watchers/schedule-cursor";
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
    organizationId: workspace.org.id,
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

describe("provider quota reset parsing", () => {
  it("treats a date-only reset as UTC and adds boundary grace", () => {
    const reset = parseProviderQuotaResetAt(
      "429 Limit Exhausted. Your limit will reset at 2026-07-31",
      new Date("2026-07-30T12:00:00.000Z")
    );

    expect(reset?.toISOString()).toBe("2026-07-31T00:01:00.000Z");
  });

  it("ignores missing or already-past reset timestamps", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");

    expect(parseProviderQuotaResetAt("429 Limit Exhausted", now)).toBeNull();
    expect(
      parseProviderQuotaResetAt("Your limit will reset at 2026-07-31", now)
    ).toBeNull();
  });

  it("keeps the boundary grace when the reset time just passed", () => {
    const now = new Date("2026-07-31T12:00:30.000Z");

    expect(
      parseProviderQuotaResetAt(
        "Your limit will reset at 2026-07-31 12:00:00",
        now
      )?.toISOString()
    ).toBe("2026-07-31T12:01:00.000Z");
  });
});

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

  it("parks a quota-exhausted Behavior through the provider reset boundary", async () => {
    const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const providerReset = resetAt
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const { watcherId, runId } = await createDueWatcherWithDispatchedRun({
      slug: "park-until-provider-reset",
      messageId: "msg-provider-reset",
    });

    const renderer = new ApiResponseRenderer({
      broadcast() {},
    } as unknown as ConstructorParameters<typeof ApiResponseRenderer>[0]);
    await renderer.handleError(
      {
        messageId: "msg-provider-reset",
        channelId: "api-provider-reset",
        conversationId: "api-provider-reset",
        userId: "watcher-test",
        teamId: "api",
        timestamp: Date.now(),
        error: `429 Weekly/Monthly Limit Exhausted. Your limit will reset at ${providerReset}`,
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
      },
      "test-session"
    );

    const sql = getTestDb();
    const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");

    const after = await cursorOf(watcherId);
    const expectedNotBefore =
      Math.floor(resetAt.getTime() / 1000) * 1000 + 60_000;
    expect(after.getTime()).toBe(expectedNotBefore);
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

describe("finalize-miss diagnostics", () => {
  it("names the pending tool approval instead of blaming the agent", async () => {
    const { sql, organizationId, watcherId, runId } =
      await createDueWatcherWithDispatchedRun({
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
          conversationId: `personal-agent_watcher_${watcherId}_run_${runId}`,
        })},
        NOW() + INTERVAL '1 hour'
      )
    `;

    await resolveWatcherRunsByMessageIds(["msg-gated-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/blocked on tool approval/);
    expect(run.error_message).toMatch(/lobu-memory\/run_sdk/);
    expect(run.error_message).not.toMatch(/finished without calling/);
  });

  it("ignores approvals outside the run's tenant and conversation", async () => {
    const { sql, organizationId, watcherId, runId } =
      await createDueWatcherWithDispatchedRun({
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
              `personal-agent_watcher_${behaviorId}_run_${runId}`,
          })},
          NOW() + INTERVAL '1 hour'
        )
      `;
    await pending(`ta_wrong_org_${runId}`, "wrong_org", "other-org", watcherId);
    await pending(
      `ta_wrong_behavior_${runId}`,
      "wrong_behavior",
      organizationId,
      watcherId + 1
    );

    await resolveWatcherRunsByMessageIds(["msg-scoped-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/No active tool approval was found/);
    expect(run.error_message).not.toMatch(/wrong_org|wrong_behavior/);
  });

  it("falls back to the agent-miss message when nothing is pending", async () => {
    const { sql, runId } = await createDueWatcherWithDispatchedRun({
      slug: "finalize-miss-no-approval",
      messageId: "msg-no-approval",
      nudgeCount: 99,
    });

    await resolveWatcherRunsByMessageIds(["msg-no-approval"], { ok: true });

    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run.status).toBe("failed");
    expect(run.error_message).toMatch(/finished without calling/);
    expect(run.error_message).toMatch(/No active tool approval was found/);
  });
});
