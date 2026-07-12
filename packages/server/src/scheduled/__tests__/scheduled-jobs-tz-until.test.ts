import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup";
import type { ToolContext } from "../../tools/registry";
import { manageSchedules } from "../../tools/admin/manage_schedules";
import {
  createScheduledJob,
  registerScheduledJobsTicker,
  type ScheduledJobRow,
} from "../scheduled-jobs-service";

const ORG = "org-tz-until";
const USER = "user-tz-until";

function ctx(): ToolContext {
  return {
    organizationId: ORG,
    userId: USER,
    memberRole: "admin",
    agentId: null,
    sourceContext: null,
    isAuthenticated: true,
    clientId: "lobu-worker",
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    tokenType: "pat",
    scopedToOrg: true,
    allowCrossOrg: false,
  } as unknown as ToolContext;
}

/** Register the real ticker against a fake scheduler; returns a tick runner. */
function makeTicker() {
  const handlers = new Map<string, (job: unknown) => Promise<void>>();
  const spawned: Array<{ name: string; payload: Record<string, unknown> }> = [];
  registerScheduledJobsTicker({
    register: (name: string, handler: (job: unknown) => Promise<void>) =>
      handlers.set(name, handler),
    spawn: async (name: string, payload: Record<string, unknown>) => {
      spawned.push({ name, payload });
      return "spawned-run";
    },
  } as never);
  return {
    spawned,
    tick: () => handlers.get("scheduled-jobs-tick")!({ payload: {}, taskRunId: 1 }),
  };
}

async function seedOrg(id: string): Promise<void> {
  await getDb()`
    INSERT INTO organization (id, name, slug)
    VALUES (${id}, ${id}, ${id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function readRow(id: string): Promise<ScheduledJobRow> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM scheduled_jobs WHERE id = ${id}
  `) as unknown as ScheduledJobRow[];
  return rows[0];
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

describe("scheduled jobs: timezone-aware cron advance", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG);
  });

  test("advances next_run_at in the schedule's timezone (9am Taipei = 01:00 UTC)", async () => {
    const job = await createScheduledJob({
      organizationId: ORG,
      actionType: "send_notification",
      actionArgs: { title: "tz test" },
      description: "9am Taipei daily",
      cron: "0 9 * * *",
      timezone: "Asia/Taipei",
      runAt: minutesAgo(1),
      createdByUser: USER,
    });
    const { tick, spawned } = makeTicker();

    await tick();

    expect(spawned).toHaveLength(1);
    const after = await readRow(job.id);
    expect(after.paused).toBe(false);
    // Taipei is UTC+8 with no DST: the next 09:00 wall-clock is always 01:00Z.
    const next = new Date(after.next_run_at);
    expect(next.getUTCHours()).toBe(1);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  test("without a timezone the same cron advances in server time (UTC)", async () => {
    const job = await createScheduledJob({
      organizationId: ORG,
      actionType: "send_notification",
      actionArgs: { title: "utc control" },
      description: "9am server-time daily",
      cron: "0 9 * * *",
      runAt: minutesAgo(1),
      createdByUser: USER,
    });
    const { tick, spawned } = makeTicker();

    await tick();

    expect(spawned).toHaveLength(1);
    const after = await readRow(job.id);
    expect(new Date(after.next_run_at).getUTCHours()).toBe(9);
  });
});

describe("scheduled jobs: until_at bound", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG);
  });

  test("fires the occurrence AT the bound, then retires instead of advancing", async () => {
    const due = minutesAgo(1);
    const job = await createScheduledJob({
      organizationId: ORG,
      actionType: "send_notification",
      actionArgs: { title: "last firing" },
      description: "bounded every-minute",
      cron: "* * * * *",
      runAt: due,
      untilAt: due,
      createdByUser: USER,
    });
    const { tick, spawned } = makeTicker();

    await tick();

    expect(spawned).toHaveLength(1);
    const after = await readRow(job.id);
    expect(after.paused).toBe(true);
    expect(after.last_fired_at).not.toBeNull();
  });

  test("keeps advancing while the next occurrence is within the bound", async () => {
    const job = await createScheduledJob({
      organizationId: ORG,
      actionType: "send_notification",
      actionArgs: { title: "still running" },
      description: "bounded but not done",
      cron: "* * * * *",
      runAt: minutesAgo(1),
      untilAt: new Date(Date.now() + 24 * 3600_000),
      createdByUser: USER,
    });
    const { tick, spawned } = makeTicker();

    await tick();

    expect(spawned).toHaveLength(1);
    const after = await readRow(job.id);
    expect(after.paused).toBe(false);
    expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("a due row already past its bound retires without firing", async () => {
    // Only reachable when an update pushed next_run_at beyond until_at;
    // simulate that end state directly.
    const job = await createScheduledJob({
      organizationId: ORG,
      actionType: "send_notification",
      actionArgs: { title: "never fires" },
      description: "past bound",
      cron: "* * * * *",
      runAt: minutesAgo(60),
      untilAt: minutesAgo(120),
      createdByUser: USER,
    });
    const { tick, spawned } = makeTicker();

    await tick();

    expect(spawned).toHaveLength(0);
    const after = await readRow(job.id);
    expect(after.paused).toBe(true);
    expect(after.last_fired_at).toBeNull();
  });
});

describe("scheduled jobs: idempotent create", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG);
  });

  test("same (org, key) returns the existing row, ignoring the retried args", async () => {
    const first = await createScheduledJob({
      organizationId: ORG,
      actionType: "send_notification",
      actionArgs: { title: "original" },
      description: "original schedule",
      runAt: new Date(Date.now() + 3600_000),
      idempotencyKey: "morning-checkin",
      createdByUser: USER,
    });
    const retried = await createScheduledJob({
      organizationId: ORG,
      actionType: "send_notification",
      actionArgs: { title: "retry with different args" },
      description: "retried schedule",
      runAt: new Date(Date.now() + 7200_000),
      idempotencyKey: "morning-checkin",
      createdByUser: USER,
    });

    expect(retried.id).toBe(first.id);
    expect(retried.description).toBe("original schedule");
  });

  test("same key in a different org creates an independent schedule", async () => {
    await seedOrg("org-tz-until-other");
    const a = await createScheduledJob({
      organizationId: ORG,
      actionType: "send_notification",
      actionArgs: { title: "a" },
      description: "org a",
      runAt: new Date(Date.now() + 3600_000),
      idempotencyKey: "shared-key",
      createdByUser: USER,
    });
    const b = await createScheduledJob({
      organizationId: "org-tz-until-other",
      actionType: "send_notification",
      actionArgs: { title: "b" },
      description: "org b",
      runAt: new Date(Date.now() + 3600_000),
      idempotencyKey: "shared-key",
      createdByUser: USER,
    });

    expect(b.id).not.toBe(a.id);
  });

  test("no key means no dedup — repeated creates make distinct rows", async () => {
    const mk = () =>
      createScheduledJob({
        organizationId: ORG,
        actionType: "send_notification",
        actionArgs: { title: "dup" },
        description: "unkeyed",
        runAt: new Date(Date.now() + 3600_000),
        createdByUser: USER,
      });
    const [a, b] = [await mk(), await mk()];
    expect(b.id).not.toBe(a.id);
  });
});

describe("manage_schedules tool: create/update validation + round-trip", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG);
  });

  const basePayload = { type: "send_notification", title: "hi" } as const;

  test("create persists and echoes timezone, until_at, idempotency_key; retry dedups", async () => {
    const args = {
      action: "create",
      description: "bounded Taipei schedule",
      run_at: new Date(Date.now() + 3600_000).toISOString(),
      cron: "0 9 * * *",
      timezone: "Asia/Taipei",
      until_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      idempotency_key: "tool-checkin",
      payload: basePayload,
    };
    const first = (await manageSchedules(args, {} as never, ctx())) as {
      schedule: { id: string; timezone: string; until_at: string; idempotency_key: string };
    };
    expect(first.schedule.timezone).toBe("Asia/Taipei");
    expect(first.schedule.until_at).not.toBeNull();
    expect(first.schedule.idempotency_key).toBe("tool-checkin");

    const retry = (await manageSchedules(args, {} as never, ctx())) as { schedule: { id: string } };
    expect(retry.schedule.id).toBe(first.schedule.id);
  });

  test("create rejects an unknown timezone", async () => {
    const res = (await manageSchedules(
      {
        action: "create",
        description: "bad tz",
        run_at: new Date().toISOString(),
        cron: "0 9 * * *",
        timezone: "Mars/Olympus_Mons",
        payload: basePayload,
      },
      {} as never,
      ctx()
    )) as { error?: string };
    expect(res.error).toContain("Unknown IANA timezone");
  });

  test("create rejects until_at before run_at", async () => {
    const res = (await manageSchedules(
      {
        action: "create",
        description: "inverted bound",
        run_at: new Date(Date.now() + 3600_000).toISOString(),
        until_at: new Date().toISOString(),
        payload: basePayload,
      },
      {} as never,
      ctx()
    )) as { error?: string };
    expect(res.error).toContain("until_at must not be before run_at");
  });

  test("update can set and clear timezone and until_at", async () => {
    const created = (await manageSchedules(
      {
        action: "create",
        description: "to be updated",
        run_at: new Date(Date.now() + 3600_000).toISOString(),
        cron: "0 9 * * *",
        payload: basePayload,
      },
      {} as never,
      ctx()
    )) as { schedule: { id: string } };

    const set = (await manageSchedules(
      {
        action: "update",
        id: created.schedule.id,
        timezone: "Asia/Taipei",
        until_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      },
      {} as never,
      ctx()
    )) as { schedule: { timezone: string | null; until_at: string | null } };
    expect(set.schedule.timezone).toBe("Asia/Taipei");
    expect(set.schedule.until_at).not.toBeNull();

    const cleared = (await manageSchedules(
      { action: "update", id: created.schedule.id, timezone: null, until_at: null },
      {} as never,
      ctx()
    )) as { schedule: { timezone: string | null; until_at: string | null } };
    expect(cleared.schedule.timezone).toBeNull();
    expect(cleared.schedule.until_at).toBeNull();
  });
});
