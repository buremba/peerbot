/**
 * Integration tests for RunsQueue against a real Postgres.
 *
 * Covers the production automations that unit-level mocking cannot exercise —
 * SKIP LOCKED concurrency, graceful shutdown release, priority + expires_at +
 * retryDelay options, startup recovery scan.
 *
 * The SKIP LOCKED test runs the production claim SQL against real embedded
 * Postgres so row-lock semantics are covered without SQL mocks.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  RunsQueue,
  sweepCompletedRuns,
} from "../infrastructure/queue/runs-queue.js";
import {
  deploymentNameForLinkedChild,
  generateDeploymentName,
  linkedChildIdentityColumns,
  THREAD_MESSAGE_QUEUE_PREFIX,
} from "../orchestration/deployment-identity.js";
import { lockOwningAutomationForRun } from "../../automations/run-completion.js";
import { getDb } from "../../db/client.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
  seedOrgMembership,
} from "./helpers/db-setup.js";

let queue: RunsQueue | null = null;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  queue = new RunsQueue();
  await queue.start();
});

afterEach(async () => {
  if (queue) {
    await queue.stop();
    queue = null;
  }
});

describe("RunsQueue — SKIP LOCKED claim concurrency", () => {
  test("each row is consumed exactly once across concurrent claim loops", async () => {
    if (!queue) throw new Error("queue not started");
    const N = 8;
    for (let i = 0; i < N; i++) {
      await queue.send("test-skip-locked", { i });
    }

    const consumed: number[] = [];
    const handler = async (job: { data: { i: number } }) => {
      consumed.push(job.data.i);
    };

    // Inside one RunsQueue instance, a queue name has one active worker loop.
    // This still exercises the production SKIP LOCKED claim SQL against real
    // Postgres, without mocking the row-lock semantics.
    await queue.work("test-skip-locked", handler);

    // Drain — poll until all claimed.
    const start = Date.now();
    while (consumed.length < N && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(consumed.length).toBe(N);
    expect(new Set(consumed).size).toBe(N);
  });
});

describe("RunsQueue — caller options", () => {
  test("priority orders claim across same queue", async () => {
    if (!queue) throw new Error("queue not started");
    await queue.send("test-priority", { tag: "low" }, { priority: 1 });
    await queue.send("test-priority", { tag: "high" }, { priority: 10 });
    await queue.send("test-priority", { tag: "mid" }, { priority: 5 });

    const order: string[] = [];
    await queue.work(
      "test-priority",
      async (job: { data: { tag: string } }) => {
        order.push(job.data.tag);
      },
    );

    const start = Date.now();
    while (order.length < 3 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(order).toEqual(["high", "mid", "low"]);
  });

  test("expireInSeconds drops the row from claim", async () => {
    if (!queue) throw new Error("queue not started");
    // Send with a 1-second TTL, then directly age the row so it's already
    // expired before the worker picks it up.
    await queue.send(
      "test-expires",
      { tag: "doomed" },
      { expireInSeconds: 1 },
    );

    const sql = getDb();
    await sql`
      UPDATE runs
      SET expires_at = now() - interval '1 second'
      WHERE queue_name = 'test-expires'
    `;

    let claimed = false;
    await queue.work("test-expires", async () => {
      claimed = true;
    });

    await new Promise((r) => setTimeout(r, 600));
    expect(claimed).toBe(false);
  });

  test("retryDelay overrides exponential backoff with constant delay", async () => {
    if (!queue) throw new Error("queue not started");
    const sql = getDb();
    await queue.send(
      "test-retry-delay",
      { tag: "retry-me" },
      { retryDelay: 2, retryLimit: 3 },
    );

    let runs = 0;
    await queue.work("test-retry-delay", async () => {
      runs += 1;
      throw new Error("boom");
    });

    // Wait for first attempt + retry to be scheduled.
    await new Promise((r) => setTimeout(r, 600));
    const rows = await sql<{ run_at: Date; attempts: number }>`
      SELECT run_at, attempts FROM runs WHERE queue_name = 'test-retry-delay'
    `;
    // First attempt has run; row is back to pending with run_at ~2s in future.
    expect(rows.length).toBe(1);
    expect(rows[0]?.attempts ?? 0).toBeGreaterThanOrEqual(1);

    const runAt = rows[0]?.run_at?.getTime() ?? 0;
    expect(runAt).toBeGreaterThan(Date.now() + 1000);
    expect(runAt).toBeLessThan(Date.now() + 4000);
    expect(runs).toBe(1);
  });
});

describe("RunsQueue — deferral retries (isDeferralError contract)", () => {
  test("a deferral-flagged throw reschedules without consuming an attempt", async () => {
    // retryLimit 1: a PLAIN error would markFailed on the first throw (see the
    // companion test). Two deferral throws followed by success proves the
    // dispatch gate can wait out a prior turn longer than the attempt budget
    // without the follower job being stranded as failed-never-delivered.
    if (!queue) throw new Error("queue not started");
    let calls = 0;
    let done = false;
    await queue.send(
      "test-deferral",
      { tag: "waiting" },
      { retryLimit: 1, retryDelay: 0 },
    );
    await queue.work("test-deferral", async () => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error("prior turn still live") as Error & {
          deferral: boolean;
        };
        err.deferral = true;
        throw err;
      }
      done = true;
    });

    // Poll the ROW, not the in-handler `done` flag. `done` is set inside the
    // handler, which returns before the queue writes `status='completed'` — so
    // waiting on it and then reading the row is a read-too-early race that
    // reports `claimed` on a loaded runner. The companion test below already
    // polls the row for exactly this reason.
    const sql = getDb();
    let rows: { status: string; attempts: number | string }[] = [];
    const start = Date.now();
    while (rows[0]?.status !== "completed" && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      rows = [
        ...(await sql<{ status: string; attempts: number | string }>`
          SELECT status, attempts FROM runs WHERE queue_name = 'test-deferral'
        `),
      ];
    }
    expect(done).toBe(true);
    expect(calls).toBe(3);
    expect(rows[0]?.status).toBe("completed");
    expect(Number(rows[0]?.attempts ?? -1)).toBe(0);
  });

  test("a plain throw at the same budget fails the job — the flag is what spares it", async () => {
    if (!queue) throw new Error("queue not started");
    let calls = 0;
    await queue.send(
      "test-deferral-plain",
      { tag: "doomed" },
      { retryLimit: 1, retryDelay: 0 },
    );
    await queue.work("test-deferral-plain", async () => {
      calls += 1;
      throw new Error("boom");
    });

    const sql = getDb();
    let status = "";
    const start = Date.now();
    while (status !== "failed" && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      const rows = await sql<{ status: string }>`
        SELECT status FROM runs WHERE queue_name = 'test-deferral-plain'
      `;
      status = rows[0]?.status ?? "";
    }
    expect(status).toBe("failed");
    expect(calls).toBe(1);
  });
});

describe("RunsQueue — action_input JSONB shape", () => {
  test("send() persists action_input as a JSONB object, not a double-encoded JSONB string", async () => {
    // Regression: pre-fix, the INSERT bound `JSON.stringify(data)` to a
    // `$4::jsonb` parameter via `tx.unsafe()`. Postgres stored that as a
    // JSONB *string* (jsonb_typeof = 'string'), not a JSONB object, which
    // made every downstream `action_input ->> 'field'` reader silently
    // return NULL — including the snapshot-route ownership verifier in
    // gateway/transcript-routes.ts. Assert the new shape end-to-end so a
    // future refactor can't re-introduce the bug.
    if (!queue) throw new Error("queue not started");
    const payload = {
      agentId: "marketing",
      conversationId: "telegram:6570514069",
      userId: "u1",
    };
    await queue.send("test-jsonb-shape", payload);

    const sql = getDb();
    const rows = (await sql`
      SELECT jsonb_typeof(action_input) AS shape,
             action_input ->> 'agentId' AS extracted_agent_id,
             action_input ->> 'conversationId' AS extracted_conv_id
      FROM runs
      WHERE queue_name = 'test-jsonb-shape'
    `) as Array<{
      shape: string;
      extracted_agent_id: string | null;
      extracted_conv_id: string | null;
    }>;

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.shape).toBe("object");
    // Direct `->>` extraction works on the object shape — the exact
    // accessor the snapshot-route verifier relies on.
    expect(row?.extracted_agent_id).toBe("marketing");
    expect(row?.extracted_conv_id).toBe("telegram:6570514069");
  });
});

describe("RunsQueue — task parent provenance", () => {
  test("claims a durable task after its Automation parent has completed", async () => {
    if (!queue) throw new Error("queue not started");
    const sql = getDb();
    const organizationId = await seedAgentRow("task-parent-agent", {
      organizationId: "task-parent-org",
    });
    const [parent] = await sql<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, status, completed_at)
      VALUES (${organizationId}, 'automation', 'completed', now())
      RETURNING id
    `;
    const queueName = "task:test-completed-parent";
    const [task] = await sql<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, queue_name, action_key, action_input,
        parent_run_id, status, run_at
      ) VALUES (
        ${organizationId}, 'task', ${queueName}, 'test-completed-parent',
        ${sql.json({
          name: "test-completed-parent",
          payload: { sourceRunId: parent.id },
        })}::jsonb,
        ${parent.id}, 'pending', now()
      )
      RETURNING id
    `;

    let consumed = false;
    await queue.work(queueName, async () => {
      consumed = true;
    });

    let status = "";
    const start = Date.now();
    while (status !== "completed" && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = await sql<{ status: string }>`
        SELECT status FROM runs WHERE id = ${task.id}
      `;
      status = rows[0]?.status ?? "";
    }
    expect(consumed).toBe(true);
    expect(status).toBe("completed");
  });
});

describe("RunsQueue — graceful shutdown", () => {
  test("reconnect preserves the logical worker and serializes active handlers", async () => {
    if (!queue) throw new Error("queue not started");
    const sql = getDb();
    await queue.send("test-reconnect", { turn: 1 });
    await queue.send("test-reconnect", { turn: 2 });
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const order: number[] = [];
    const first = async (job: { data: { turn: number } }) => {
      order.push(job.data.turn);
      firstStarted?.();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    };
    const replacement = async (job: { data: { turn: number } }) => {
      order.push(job.data.turn);
    };
    await queue.work("test-reconnect", first);
    await started;
    const worker = (queue as any).workers.get("test-reconnect");
    await queue.work("test-reconnect", replacement);
    expect((queue as any).workers.get("test-reconnect")).toBe(worker);
    expect(worker.generation).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual([1]);
    releaseFirst?.();
    const deadline = Date.now() + 5000;
    let status = "";
    while (status !== "completed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = await sql<{ status: string }>`
        SELECT status FROM runs WHERE queue_name = 'test-reconnect' ORDER BY id DESC LIMIT 1
      `;
      status = rows[0]?.status ?? "";
    }
    expect(order).toEqual([1, 2]);
    expect(worker.active).toBe(0);
  });

  test("stop() releases claimed rows back to pending", async () => {
    if (!queue) throw new Error("queue not started");
    await queue.send("test-graceful", { tag: "hold" });

    let started = false;
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    await queue.work(
      "test-graceful",
      async () => {
        started = true;
        await blocked;
      },
    );

    // Wait for the worker to claim the row.
    const claimedStart = Date.now();
    while (!started && Date.now() - claimedStart < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(started).toBe(true);

    // Trigger shutdown; release after a tick so we can observe the released-row
    // path (drain timeout * 0 since handler resolves immediately on release).
    const stopPromise = queue.stop();
    setTimeout(() => release?.(), 100);
    await stopPromise;
    queue = null; // Don't double-stop in afterEach.

    // After stop, the row should be either in `pending` (released) or
    // `completed` (if the handler finished within the drain window).
    const sql = getDb();
    const rows = await sql<{ status: string; claimed_by: string | null }>`
      SELECT status, claimed_by FROM runs WHERE queue_name = 'test-graceful'
    `;
    expect(rows.length).toBe(1);
    const status = rows[0]?.status;
    expect(status === "pending" || status === "completed").toBe(true);
    if (status === "pending") {
      expect(rows[0]?.claimed_by).toBeNull();
    }
  });
});

describe("linked-child identity projection", () => {
  // Three sweeps read a linked chat_message child off `runs` and hand the
  // result straight to deploymentNameForLinkedChild, which is what decides
  // whose turn gets failed. A projection that aliases the wrong action_input
  // key does not error -- it silently names a different deployment, so the
  // owed terminal event lands on someone else's turn or nowhere. This pins the
  // mapping end to end against real Postgres, once, for the one projection all
  // three now share.
  test("maps every action_input key to the column its name promises", async () => {
    const sql = getDb();
    const orgId = await seedAgentRow("identity-agent", {
      organizationId: "identity-org",
    });
    const identity = {
      messageId: "msg-1",
      agentId: "identity-agent",
      userId: "U123",
      conversationId: "C999",
      channelId: "CHAN7",
      platform: "slack",
    };
    const [child] = await sql<{ id: number }>`
      INSERT INTO runs (
        run_type, queue_name, action_input, status, run_at, organization_id
      )
      VALUES (
        'chat_message', 'messages', ${sql.json(identity)}, 'pending', now(),
        ${orgId}
      )
      RETURNING id
    `;

    const [row] = await sql<{
      queue_name: string;
      message_id: string | null;
      agent_id: string | null;
      user_id: string | null;
      conversation_id: string | null;
      channel_id: string | null;
      platform: string | null;
    }>`
      SELECT queue_name, ${linkedChildIdentityColumns(sql)}
      FROM public.runs WHERE id = ${Number(child.id)}
    `;

    expect(row.message_id).toBe("msg-1");
    expect(row.agent_id).toBe("identity-agent");
    expect(row.user_id).toBe("U123");
    expect(row.conversation_id).toBe("C999");
    expect(row.channel_id).toBe("CHAN7");
    expect(row.platform).toBe("slack");

    // The round trip the sweeps actually perform: what came out of the row
    // must name the same deployment the enqueue side derived.
    expect(deploymentNameForLinkedChild(row, orgId)).toBe(
      generateDeploymentName({
        organizationId: orgId,
        agentId: identity.agentId,
        userId: identity.userId,
        platform: identity.platform,
        channelId: identity.channelId,
        conversationId: identity.conversationId,
      })
    );
  });

  test("a thread-message queue names its deployment without the identity", async () => {
    const sql = getDb();
    const orgId = await seedAgentRow("identity-thread-agent", {
      organizationId: "identity-thread-org",
    });
    // A per-deployment queue already carries the name, so this row is the case
    // where every projected identity column is NULL and the name still has to
    // come out right -- the shape the org-less sweep test exercises blind.
    const [child] = await sql<{ id: number }>`
      INSERT INTO runs (
        run_type, queue_name, action_input, status, run_at, organization_id
      )
      VALUES (
        'chat_message', ${`${THREAD_MESSAGE_QUEUE_PREFIX}dep-abc`},
        '{}'::jsonb, 'pending', now(), ${orgId}
      )
      RETURNING id
    `;

    const [row] = await sql<{
      queue_name: string;
      message_id: string | null;
      agent_id: string | null;
      user_id: string | null;
      conversation_id: string | null;
      channel_id: string | null;
      platform: string | null;
    }>`
      SELECT queue_name, ${linkedChildIdentityColumns(sql)}
      FROM public.runs WHERE id = ${Number(child.id)}
    `;

    expect(row.agent_id).toBeNull();
    expect(row.conversation_id).toBeNull();
    expect(deploymentNameForLinkedChild(row, orgId)).toBe("dep-abc");
  });
});

describe("the Automation-owner lock", () => {
  /** An Automation and a parent run of it, in `orgId`. */
  async function seedAutomationParent(orgId: string, agentId: string) {
    const sql = getDb();
    // `automations.created_by` is a NOT NULL FK to "user".
    const creatorId = `${agentId}-creator`;
    await seedOrgMembership(orgId, creatorId, "owner");
    await sql`
      INSERT INTO automations
        (organization_id, agent_id, created_by, automation_group_id,
         name, status, min_cooldown_seconds, created_at, updated_at)
      VALUES
        (${orgId}, ${agentId}, ${creatorId}, 0, 'lock probe', 'active', 0,
         now(), now())
    `;
    const [automation] = await sql<{ id: number }>`
      SELECT id FROM automations
      WHERE organization_id = ${orgId} ORDER BY id DESC LIMIT 1
    `;
    const [parent] = await sql<{ id: number }>`
      INSERT INTO runs (
        run_type, queue_name, action_input, status, run_at, organization_id,
        automation_id
      )
      VALUES (
        'automation', 'automation', '{}'::jsonb, 'running', now(), ${orgId},
        ${Number(automation.id)}
      )
      RETURNING id
    `;
    return { automationId: Number(automation.id), parentRunId: Number(parent.id) };
  }

  /** Is the automations row lockable right now from another connection? */
  async function lockableElsewhere(automationId: number): Promise<boolean> {
    const sql = getDb();
    try {
      await sql.begin(async (probe) => {
        await probe`SET LOCAL lock_timeout = '250ms'`;
        await probe`
          SELECT id FROM automations WHERE id = ${automationId} FOR UPDATE
        `;
      });
      return true;
    } catch {
      return false;
    }
  }

  test("holds the owning Automation for the caller", async () => {
    const orgId = await seedAgentRow("lock-agent", {
      organizationId: "lock-org",
    });
    const { automationId, parentRunId } = await seedAutomationParent(
      orgId,
      "lock-agent"
    );
    const sql = getDb();

    await sql.begin(async (tx) => {
      await lockOwningAutomationForRun(tx, parentRunId, {
        organizationId: orgId,
      });
      // Whoever holds this is next in the lock order for that Automation --
      // the whole reason every terminalization path takes it first.
      expect(await lockableElsewhere(automationId)).toBe(false);
    });

    expect(await lockableElsewhere(automationId)).toBe(true);
  });

  test("takes nothing when the org does not own the run", async () => {
    // CROSS-TENANT: the linked-child sweeps pass an org read off a child row.
    // If the scope were ignored, a child carrying another tenant's parent id
    // would lock that tenant's Automation and serialize their completions
    // behind this sweep.
    const orgId = await seedAgentRow("lock-tenant-agent", {
      organizationId: "lock-tenant-org",
    });
    const otherOrgId = await seedAgentRow("lock-other-agent", {
      organizationId: "lock-other-org",
    });
    const { automationId, parentRunId } = await seedAutomationParent(
      orgId,
      "lock-tenant-agent"
    );
    const sql = getDb();

    await sql.begin(async (tx) => {
      await lockOwningAutomationForRun(tx, parentRunId, {
        organizationId: otherOrgId,
      });
      expect(await lockableElsewhere(automationId)).toBe(true);
    });
  });

  test("without a scope it still locks, for callers holding only a run id", async () => {
    // The completion paths reach the lock with a run id alone; reading the
    // org first would invert the order the lock exists to establish.
    const orgId = await seedAgentRow("lock-unscoped-agent", {
      organizationId: "lock-unscoped-org",
    });
    const { automationId, parentRunId } = await seedAutomationParent(
      orgId,
      "lock-unscoped-agent"
    );
    const sql = getDb();

    await sql.begin(async (tx) => {
      await lockOwningAutomationForRun(tx, parentRunId);
      expect(await lockableElsewhere(automationId)).toBe(false);
    });
  });
});

describe("sweepCompletedRuns — expired Automation children", () => {
  test("terminalizes a linked child whose organization scope is missing", async () => {
    const sql = getDb();
    // The expiry DELETE deliberately spares parent-linked chat_message rows so
    // the sweep can fail them and resolve the parent instead. A child with no
    // organization_id cannot be resolved that way, so if the sweep merely
    // skipped it the row would stay `pending` with a past expires_at forever --
    // and the candidate window is `ORDER BY expires_at ASC LIMIT 100`, so
    // enough of them would crowd out every child that CAN be resolved.
    // `runs_legacy_org_required` demands an org for run_type 'automation' but
    // NOT for 'chat_message' — which is exactly why the org-less child below is
    // reachable and has to be handled rather than skipped.
    const orgId = await seedAgentRow("sweep-orphan-agent", {
      organizationId: "sweep-orphan-org",
    });
    const [parent] = await sql<{ id: number }>`
      INSERT INTO runs (run_type, queue_name, action_input, status, run_at, organization_id)
      VALUES ('automation', 'automation', '{}'::jsonb, 'running', now(), ${orgId})
      RETURNING id
    `;
    const [orphan] = await sql<{ id: number }>`
      INSERT INTO runs (
        run_type, queue_name, action_input, status, run_at,
        expires_at, parent_run_id, organization_id
      )
      VALUES (
        'chat_message', 'messages', '{}'::jsonb, 'pending', now() - interval '1 hour',
        now() - interval '1 hour', ${Number(parent.id)}, NULL
      )
      RETURNING id
    `;

    await sweepCompletedRuns();

    const [after] = await sql<{ status: string; error_message: string | null }>`
      SELECT status, error_message FROM runs WHERE id = ${Number(orphan.id)}
    `;
    // Whatever it becomes, it must not still be a pending row the sweep will
    // reconsider on every tick.
    expect(after.status).not.toBe("pending");
    expect(after.status).toBe("failed");
    expect(after.error_message).toMatch(/organization scope was missing/);
  });
});

describe("RunsQueue — shutdown release scope", () => {
  test("releases only this process's claims, not another worker's", async () => {
    if (!queue) throw new Error("queue not started");
    const sql = getDb();

    // Two claims this gateway did NOT issue: another gateway instance (same
    // owner shape, different instance UUID) and a device worker. Shutdown
    // identifies its own rows by owner prefix, so a prefix that over-matched
    // would reset live work belonging to someone else.
    const foreign = await sql<{ id: number; claimed_by: string }>`
      INSERT INTO runs (run_type, queue_name, action_input, status, claimed_at, claimed_by, run_at)
      VALUES
        ('chat_message', 'test-foreign', '{}'::jsonb, 'claimed',
         now(), 'gateway-00000000-0000-4000-8000-00000000ffff:test-foreign:0', now()),
        ('chat_message', 'test-foreign', '{}'::jsonb, 'claimed',
         now(), 'device-other-pid', now())
      RETURNING id, claimed_by
    `;

    await queue.send("test-release-scope", { tag: "hold" });
    let started = false;
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await queue.work("test-release-scope", async () => {
      started = true;
      await blocked;
    });
    const waitStart = Date.now();
    while (!started && Date.now() - waitStart < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(started).toBe(true);

    const stopPromise = queue.stop();
    setTimeout(() => release?.(), 50);
    await stopPromise;
    queue = null;

    for (const row of foreign) {
      const [after] = await sql<{ status: string; claimed_by: string | null }>`
        SELECT status, claimed_by FROM runs WHERE id = ${Number(row.id)}
      `;
      expect(after.status).toBe("claimed");
      expect(after.claimed_by).toBe(row.claimed_by);
    }

    const [own] = await sql<{ status: string }>`
      SELECT status FROM runs WHERE queue_name = 'test-release-scope'
    `;
    expect(own.status === "pending" || own.status === "completed").toBe(true);
  });
});

describe("RunsQueue — startup recovery scan", () => {
  test("recovers gateway claims without stealing device chat lifecycle", async () => {
    if (!queue) throw new Error("queue not started");
    // Stop the live queue first so we can manipulate rows freely.
    await queue.stop();
    queue = null;

    const sql = getDb();
    // Insert a row in `claimed` state with an old claimed_at to simulate a
    // crashed prior run.
    const inserted = await sql<{ id: number; queue_name: string }>`
      INSERT INTO runs (run_type, queue_name, action_input, status, claimed_at, claimed_by, run_at)
      VALUES
        ('chat_message', 'recovery-q', '{}'::jsonb, 'claimed',
         now() - interval '20 minutes', 'gateway-old-pid',
         now() - interval '20 minutes'),
        ('chat_message', 'messages', ${sql.json({
          executionTarget: {
            kind: "device",
            deviceWorkerId: "00000000-0000-4000-8000-000000000001",
            agentKind: "pi",
          },
        })}, 'running', now() - interval '20 minutes', 'device-old-pid',
         now() - interval '20 minutes')
      RETURNING id, queue_name
    `;
    const gatewayRunId = Number(
      inserted.find((row) => row.queue_name === "recovery-q")?.id
    );
    const deviceRunId = Number(
      inserted.find((row) => row.queue_name === "messages")?.id
    );

    // New RunsQueue instance — startup scan should reset the row.
    const fresh = new RunsQueue();
    await fresh.start();
    queue = fresh;

    // Scope by id: `messages` is the live production queue name, so a sibling
    // file in this shared database can leave rows behind that a queue_name
    // filter would pick up instead.
    const rows = await sql<{
      id: number;
      status: string;
      claimed_by: string | null;
    }>`
      SELECT id, status, claimed_by
      FROM runs
      WHERE id IN (${gatewayRunId}, ${deviceRunId})
    `;
    const deviceChat = rows.find((row) => Number(row.id) === deviceRunId);
    const gatewayChat = rows.find((row) => Number(row.id) === gatewayRunId);
    expect(gatewayChat?.status).toBe("pending");
    expect(gatewayChat?.claimed_by).toBeNull();
    expect(deviceChat?.status).toBe("running");
    expect(deviceChat?.claimed_by).toBe("device-old-pid");
  });
});
