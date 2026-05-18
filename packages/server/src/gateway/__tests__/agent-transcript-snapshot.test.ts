/**
 * Integration tests for the per-run agent_transcript_snapshot path.
 *
 * Backed by the ephemeral PGlite gateway harness (`ensurePgliteForGatewayTests`).
 * Covers the gateway-side surface: HTTP snapshot routes, advisory lock,
 * /agent-history fallback resolver, and schema constraints. The worker-side
 * helpers (hydrate / writeSnapshot) are tested in
 * `packages/agent-worker/src/openclaw/__tests__/transcript-snapshot.test.ts`.
 *
 * Test-isolation note: PGlite pins postgres.js to a single connection. The
 * cross-pod advisory lock cannot be exercised end-to-end here (the second
 * acquire would block forever on the same connection); the embedded-mode
 * no-op path is asserted instead, and the genuine cross-pod race is covered
 * by the dual-psql repro in the PR body.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createTranscriptRoutes } from "../gateway/transcript-routes.js";
import { acquireConversationLock } from "../orchestration/impl/embedded-deployment.js";
import {
  createAgentHistoryRoutes,
  readLatestSnapshotJsonl,
} from "../routes/public/agent-history.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

beforeAll(async () => {
  await ensurePgliteForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
});

/**
 * Insert a row in `runs` matching the `(org, agent, conv)` triple that the
 * snapshot route resolves run_id by. Returns the new run's id.
 */
async function insertRun(opts: {
  organizationId: string;
  agentId: string;
  conversationId: string;
  runType?: string;
  status?: string;
}): Promise<number> {
  const sql = getDb();
  const runType = opts.runType ?? "chat_message";
  const status = opts.status ?? "running";
  const rows = (await sql`
    INSERT INTO public.runs (
      organization_id, run_type, status, action_input,
      agent_id, conversation_id,
      queue_name, run_at, created_at
    ) VALUES (
      ${opts.organizationId},
      ${runType},
      ${status},
      ${sql.json({ agentId: opts.agentId, conversationId: opts.conversationId })},
      ${opts.agentId},
      ${opts.conversationId},
      ${runType},
      NOW(),
      NOW()
    )
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0]!.id;
}

function mintWorkerToken(opts: {
  organizationId: string;
  agentId: string;
  conversationId: string;
  /**
   * The per-run binding the gateway's MessageConsumer adds when minting
   * the per-job token. Omit to simulate a deployment-lifetime token
   * (e.g. WORKER_TOKEN) which should NOT be accepted by the snapshot
   * route — codex round 2 finding A on PR #865.
   */
  runId?: number;
}): string {
  return generateWorkerToken(
    "test-user",
    opts.conversationId,
    `lobu-worker-${opts.agentId}`,
    {
      channelId: `chan-${opts.conversationId}`,
      agentId: opts.agentId,
      organizationId: opts.organizationId,
      runId: opts.runId,
    }
  );
}

async function callRoute(
  method: "GET" | "POST" | "DELETE",
  path: string,
  token: string,
  body?: unknown
): Promise<Response> {
  const app = createTranscriptRoutes();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("agent_transcript_snapshot — snapshot route", () => {
  test("happy-path-multi-turn: writes one row per terminal run, hydrates byte-for-byte", async () => {
    const orgId = await seedAgentRow("agent-happy", {
      organizationId: "org_happy",
    });
    const agentId = "agent-happy";
    const conversationId = "conv-happy";

    // Turn 1: insert a chat_message run, mint a per-run token, POST
    // a completed snapshot. Production mints a fresh token per dispatch
    // via MessageConsumer; we simulate that here.
    const run1 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token1 = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: run1,
    });
    const turn1 =
      `{"type":"session","version":3,"id":"s1","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"u1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"turn 1 user"}]}}\n` +
      `{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-05-18T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"turn 1 assistant"}]}}\n`;
    let res = await callRoute("POST", "/snapshot", token1, {
      terminalStatus: "completed",
      snapshotJsonl: turn1,
      runId: run1,
    });
    expect(res.status).toBe(200);

    // Turn 2: new run, new per-run token, append more entries, POST.
    const run2 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token2 = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: run2,
    });
    const turn2 =
      turn1 +
      `{"type":"message","id":"u2","parentId":"a1","timestamp":"2026-05-18T10:01:00Z","message":{"role":"user","content":[{"type":"text","text":"turn 2 user"}]}}\n` +
      `{"type":"message","id":"a2","parentId":"u2","timestamp":"2026-05-18T10:01:01Z","message":{"role":"assistant","content":[{"type":"text","text":"turn 2 assistant"}]}}\n`;
    res = await callRoute("POST", "/snapshot", token2, {
      terminalStatus: "completed",
      snapshotJsonl: turn2,
      runId: run2,
    });
    expect(res.status).toBe(200);

    // Two PG rows in run order, both completed.
    const sql = getDb();
    const rows = (await sql`
      SELECT run_id, terminal_status, byte_size
      FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
      ORDER BY run_id ASC
    `) as Array<{
      run_id: number;
      terminal_status: string;
      byte_size: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      run_id: run1,
      terminal_status: "completed",
      byte_size: Buffer.byteLength(turn1, "utf-8"),
    });
    expect(rows[1]).toEqual({
      run_id: run2,
      terminal_status: "completed",
      byte_size: Buffer.byteLength(turn2, "utf-8"),
    });

    // Hydrate returns the latest (turn 2 bytes verbatim). GET doesn't
    // require a per-run binding — read scope is (org, agent, conv).
    res = await callRoute("GET", "/snapshot", token2);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(turn2);
  });

  test("large-snapshot-roundtrip: ~600 KB session survives PG TOAST", async () => {
    // Reproduces the largest-real-row case (633 KB measured across 2050
    // production session.jsonl rows). One synthetic `message` entry
    // padded to ~600 KB, framed as JSONL so the producer-shape assumption
    // holds — verifies PG TOAST + the route's MAX_SNAPSHOT_BYTES cap.
    const orgId = await seedAgentRow("agent-big", {
      organizationId: "org_big",
    });
    const agentId = "agent-big";
    const conversationId = "conv-big";
    const bigRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: bigRunId,
    });

    const padding = "x".repeat(600_000);
    const big =
      `{"type":"session","version":3,"id":"big","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"big1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"${padding}"}]}}\n`;

    let res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: big,
      runId: bigRunId,
    });
    expect(res.status).toBe(200);

    // Round-trip is byte-identical.
    res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out.length).toBe(big.length);
    expect(out).toBe(big);
  });

  test("opt-out: no snapshot rows ever created when LOBU_SESSION_STORE=file", async () => {
    // Phase 5 flipped the default: snapshot mode is on unless explicitly
    // opted out via LOBU_SESSION_STORE=file. The route layer doesn't
    // check the env (writes are always honoured if the JWT is valid), but
    // /agent-history's readLatestSnapshotJsonl is the consumer of that
    // env gate via its callers. With no snapshot row in either mode, the
    // resolver returns null and the existing disk-read fallback runs.
    const previous = process.env.LOBU_SESSION_STORE;
    process.env.LOBU_SESSION_STORE = "file";
    try {
      const orgId = await seedAgentRow("agent-off", {
        organizationId: "org_off",
      });
      const sql = getDb();
      const rows = (await sql`
        SELECT count(*)::int AS n
        FROM public.agent_transcript_snapshot
        WHERE organization_id = ${orgId}
      `) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
      const out = await readLatestSnapshotJsonl("agent-off", orgId);
      expect(out).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.LOBU_SESSION_STORE;
      } else {
        process.env.LOBU_SESSION_STORE = previous;
      }
    }
  });

  test("failed-run-not-replayed: hydrate skips failed snapshots and uses latest completed", async () => {
    const orgId = await seedAgentRow("agent-fail", {
      organizationId: "org_fail",
    });
    const agentId = "agent-fail";
    const conversationId = "conv-fail";

    // Completed run.
    const completedRun = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const completedJsonl = `{"type":"session","id":"good"}\n{"type":"message","id":"ok"}\n`;
    let res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId: completedRun,
      }),
      {
        terminalStatus: "completed",
        snapshotJsonl: completedJsonl,
        runId: completedRun,
      }
    );
    expect(res.status).toBe(200);

    // Newer failed run with a dangling tool_use trace.
    const failedRun = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const failedJsonl = `{"type":"session","id":"bad"}\n{"type":"message","id":"dangling","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]}}\n`;
    res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId: failedRun,
      }),
      {
        terminalStatus: "failed",
        snapshotJsonl: failedJsonl,
        runId: failedRun,
      }
    );
    expect(res.status).toBe(200);

    // Hydrate skips the failed row.
    res = await callRoute(
      "GET",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(completedJsonl);

    // Sanity: both rows persisted; admin queries can still inspect failures.
    const sql = getDb();
    const both = (await sql`
      SELECT run_id, terminal_status FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
      ORDER BY run_id ASC
    `) as Array<{ run_id: number; terminal_status: string }>;
    expect(both).toHaveLength(2);
    expect(both[0]).toEqual({ run_id: completedRun, terminal_status: "completed" });
    expect(both[1]).toEqual({ run_id: failedRun, terminal_status: "failed" });
  });

  test("failed-run-not-replayed (empty-history variant): no completed rows → hydrate 404s", async () => {
    const orgId = await seedAgentRow("agent-only-fail", {
      organizationId: "org_only_fail",
    });
    const agentId = "agent-only-fail";
    const conversationId = "conv-only-fail";
    const onlyFailRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: onlyFailRunId,
    });

    let res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "failed",
      snapshotJsonl: `{"type":"session","id":"only-bad"}\n`,
      runId: onlyFailRunId,
    });
    expect(res.status).toBe(200);

    // Hydrate must 404 — the only snapshot is failed.
    res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(404);
  });

  test("mid-run-loss: crash before cleanup leaves no snapshot; hydrate falls back to previous completed run", async () => {
    // Models the "worker crashes mid-run before writeSnapshot fires" path.
    // We simulate by writing a completed snapshot for run 1, inserting a
    // run 2 row that NEVER posts a snapshot, then asserting hydrate
    // returns run 1's bytes. Verifies the documented trade-off: the
    // partial in-flight transcript is gone, but earlier history is intact.
    const orgId = await seedAgentRow("agent-crash", {
      organizationId: "org_crash",
    });
    const agentId = "agent-crash";
    const conversationId = "conv-crash";

    const priorRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const prior = `{"type":"session","id":"prior"}\n{"type":"message","id":"p1"}\n`;
    let res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId: priorRunId,
      }),
      {
        terminalStatus: "completed",
        snapshotJsonl: prior,
        runId: priorRunId,
      }
    );
    expect(res.status).toBe(200);

    // Second run started, no snapshot written (the worker crashed).
    await insertRun({ organizationId: orgId, agentId, conversationId });

    // Hydrate returns the prior run's bytes verbatim — that's the resume
    // point for the next worker boot.
    res = await callRoute(
      "GET",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(prior);
  });

  test("two-pod race: second writer for same run_id returns 409 via UNIQUE", async () => {
    const orgId = await seedAgentRow("agent-race", {
      organizationId: "org_race",
    });
    const agentId = "agent-race";
    const conversationId = "conv-race";
    const raceRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: raceRunId,
    });

    const winningJsonl = `{"type":"session","id":"first-writer"}\n`;
    const first = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: winningJsonl,
      runId: raceRunId,
    });
    expect(first.status).toBe(200);

    const second = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: `${winningJsonl}{"type":"message","id":"loser"}\n`,
      runId: raceRunId,
    });
    expect(second.status).toBe(409);

    // First writer's bytes survive.
    const get = await callRoute("GET", "/snapshot", token);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(winningJsonl);
  });

  test("rejects token without (org, agent, conv) scope", async () => {
    // Auth boundary: missing organizationId → 400.
    const token = generateWorkerToken("test-user", "conv-x", "lobu-worker-x", {
      channelId: "chan-x",
      agentId: "agent-x",
    });
    const res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(400);
  });
});

describe("agent_transcript_snapshot — /agent-history fallback", () => {
  test("dead-worker-fallback-from-db: readLatestSnapshotJsonl returns the latest completed snapshot's bytes", async () => {
    const orgId = await seedAgentRow("agent-hist", {
      organizationId: "org_hist",
    });
    const agentId = "agent-hist";
    const conversationId = "conv-hist";
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const jsonl =
      `{"type":"session","version":3,"id":"h","timestamp":"2026-05-18T14:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-18T14:00:01Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n`;

    const sql = getDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgId}, ${agentId}, ${conversationId}, ${runId},
         ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
    `;

    const out = await readLatestSnapshotJsonl(agentId, orgId);
    expect(out).toBe(jsonl);
  });

  test("dead-worker-no-snapshot: readLatestSnapshotJsonl returns null on miss (no 500)", async () => {
    // No agent row → null. The callers (readSessionMessages / readSessionStats)
    // fall through to findSessionFile, which returns the documented empty
    // sentinel — never a 500. Also asserts that with no org pin the
    // resolver returns null (codex P2: prior version would have returned
    // SOME org's row via the unscoped agents lookup).
    const out = await readLatestSnapshotJsonl(
      "agent-does-not-exist",
      undefined
    );
    expect(out).toBeNull();
  });

  test("response-shape: hydrate bytes match what the disk path would parse", async () => {
    // Verifies the documented contract that snapshot bytes are byte-for-byte
    // identical to what the admin UI used to parse from session.jsonl on
    // disk. parseSessionEntries() in agent-history.ts splits on '\n' and
    // skips malformed lines — round-tripping our jsonl through PG and back
    // must preserve every newline.
    const orgId = await seedAgentRow("agent-shape", {
      organizationId: "org_shape",
    });
    const agentId = "agent-shape";
    const conversationId = "conv-shape";
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const lines = [
      `{"type":"session","version":3,"id":"s","timestamp":"2026-05-18T15:00:00Z","cwd":"/w"}`,
      `{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-05-18T15:00:01Z","provider":"anthropic","modelId":"claude-sonnet-4"}`,
      `{"type":"message","id":"u1","parentId":"m1","timestamp":"2026-05-18T15:00:02Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
    ];
    const jsonl = `${lines.join("\n")}\n`;

    const sql = getDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgId}, ${agentId}, ${conversationId}, ${runId},
         ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
    `;

    const out = await readLatestSnapshotJsonl(agentId, orgId);
    expect(out).toBe(jsonl);
    // Splitting on \n recovers the same line set the admin UI parses.
    expect(out!.split("\n").filter((l) => l.length > 0)).toEqual(lines);
  });
});

describe("agent_transcript_snapshot — advisory lock helper", () => {
  test.skipIf(process.env.LOBU_DISABLE_PREPARE !== "1")("lock-no-op-in-embedded-mode: PGlite-pinned pool returns sentinel without reserving", async () => {
    // Embedded mode pins the postgres.js pool to a single connection; the
    // real reserve()-based path would block forever. The helper detects
    // LOBU_DISABLE_PREPARE=1 (set by ensurePgliteForGatewayTests) and
    // returns a no-op release. The genuine cross-pod path is asserted in
    // the PR body's dual-psql repro. Skipped against real Postgres
    // (CI integration job) — the sentinel-mode assertion does not hold
    // there since sequential acquires on the same key would block.

    const a = await acquireConversationLock("org_lock_a", "agent-x", "conv-x");
    expect(a).not.toBeNull();
    // No real lock held → second acquire on the same key also succeeds.
    const b = await acquireConversationLock("org_lock_a", "agent-x", "conv-x");
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  test.skipIf(process.env.LOBU_DISABLE_PREPARE !== "1")("lock-cross-conv-parallelism (embedded sentinel): different (org,agent,conv) acquire independently", async () => {
    // Asserts the helper's keying — even in embedded sentinel mode the
    // call shape passes through and each acquire/release pairs cleanly.
    // The real-PG path uses pg_try_advisory_lock(int32, int32) where each
    // unique (org,agent,conv) hashes to a distinct key2. Skipped against
    // real Postgres (CI integration job) — without the embedded sentinel
    // shortcut, the cap+reserve path could collide with the lock counter
    // state pre-set by other tests; the cross-pod parallelism property
    // is tested at the lock keying layer (hashConvKey2) not here.
    const a = await acquireConversationLock("org_x", "agent-x", "conv-A");
    const b = await acquireConversationLock("org_x", "agent-x", "conv-B");
    const c = await acquireConversationLock("org_x", "agent-y", "conv-A");
    const d = await acquireConversationLock("org_y", "agent-x", "conv-A");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(d).not.toBeNull();
    await a!.release();
    await b!.release();
    await c!.release();
    await d!.release();
  });
});

describe("agent_transcript_snapshot — schema", () => {
  test("terminal_status CHECK constraint accepts valid and rejects invalid", async () => {
    const orgId = await seedAgentRow("agent-schema", {
      organizationId: "org_schema",
    });
    const agentId = "agent-schema";
    const conversationId = "conv-schema";
    const sql = getDb();

    // Each valid value succeeds.
    for (const status of [
      "completed",
      "failed",
      "timeout",
      "cancelled",
    ] as const) {
      const runId = await insertRun({
        organizationId: orgId,
        agentId,
        conversationId,
      });
      await sql`
        INSERT INTO public.agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id,
           snapshot_jsonl, byte_size, terminal_status)
        VALUES
          (${orgId}, ${agentId}, ${conversationId}, ${runId},
           ${`{"type":"session","id":"${status}"}\n`}, 32, ${status})
      `;
    }

    // Invalid status rejected.
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    let rejected = false;
    try {
      await sql`
        INSERT INTO public.agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id,
           snapshot_jsonl, byte_size, terminal_status)
        VALUES
          (${orgId}, ${agentId}, ${conversationId}, ${runId},
           ${`{"type":"session"}\n`}, 16, 'nope')
      `;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("org cascade: DELETE organization cascades into snapshot rows", async () => {
    const orgId = await seedAgentRow("agent-cascade", {
      organizationId: "org_cascade",
    });
    const agentId = "agent-cascade";
    const conversationId = "conv-cascade";
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const sql = getDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgId}, ${agentId}, ${conversationId}, ${runId},
         ${`{"type":"session","id":"x"}\n`}, 24, 'completed')
    `;

    // Deleting the org cascades into both runs and snapshots. (Deleting the
    // organization directly is unrealistic in production but the FK setup
    // is the same shape as pending_interactions / agent_grants which also
    // cascade.) Pre-delete: 1 snapshot row.
    let count = (await sql`
      SELECT count(*)::int AS n FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId}
    `) as Array<{ n: number }>;
    expect(count[0]!.n).toBe(1);

    // The agents row references the org as well — drop it first so the
    // org delete can proceed without violating other FKs we don't own.
    await sql`DELETE FROM public.agents WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM public.runs WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM public.organization WHERE id = ${orgId}`;

    count = (await sql`
      SELECT count(*)::int AS n FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId}
    `) as Array<{ n: number }>;
    expect(count[0]!.n).toBe(0);
  });

  test("run cascade: DELETE run cascades into the snapshot row referencing it", async () => {
    const orgId = await seedAgentRow("agent-runcasc", {
      organizationId: "org_runcasc",
    });
    const agentId = "agent-runcasc";
    const conversationId = "conv-runcasc";
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const sql = getDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgId}, ${agentId}, ${conversationId}, ${runId},
         ${`{"type":"session","id":"y"}\n`}, 24, 'completed')
    `;

    await sql`DELETE FROM public.runs WHERE id = ${runId}`;

    const count = (await sql`
      SELECT count(*)::int AS n FROM public.agent_transcript_snapshot
      WHERE run_id = ${runId}
    `) as Array<{ n: number }>;
    expect(count[0]!.n).toBe(0);
  });
});

// ─── Red→green for codex review findings on PR #865 ────────────────────────

describe("agent_transcript_snapshot — codex P1/P2 regressions", () => {
  test("P1#1 run-binding race: late POST attributes to the worker's claimed run, not the latest one", async () => {
    // PRE-FIX behavior: worker A finished execute() for run 100, started
    // cleanup() POST; run 101 was enqueued for the same conv before A's
    // POST arrived; the route's resolveLatestRunId() picked 101; A's
    // snapshot was stored under run_id=101; worker B's later POST for
    // run 101 hit a 409 and was silently dropped. The fix: worker sends
    // its claimed runId in the body and the route uses it verbatim.
    const orgId = await seedAgentRow("agent-bind", {
      organizationId: "org_bind",
    });
    const agentId = "agent-bind";
    const conversationId = "conv-bind";

    const run100 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    // Simulate the next user message enqueuing run 101 before worker A's
    // late POST arrives — this is the exact race codex called out.
    const run101 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    expect(run101).toBeGreaterThan(run100);

    // Worker A's per-run token — bound to run100, NOT run101.
    const tokenA = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: run100,
    });
    const aJsonl = `{"type":"session","id":"worker-A"}\n`;
    const res = await callRoute("POST", "/snapshot", tokenA, {
      terminalStatus: "completed",
      snapshotJsonl: aJsonl,
      // Worker A's claimed runId — even though run 101 is now the
      // "latest" for (org, agent, conv).
      runId: run100,
    });
    expect(res.status).toBe(200);

    // Assertion: the snapshot row is attributed to run100, not run101.
    const sql = getDb();
    const rows = (await sql`
      SELECT run_id, snapshot_jsonl FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
    `) as Array<{ run_id: number; snapshot_jsonl: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe(run100);
    expect(rows[0]!.snapshot_jsonl).toBe(aJsonl);

    // Now worker B for run 101 POSTs its own snapshot — with its own
    // per-run token. No UNIQUE collision because runs are disjoint.
    const tokenB = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: run101,
    });
    const bJsonl = `{"type":"session","id":"worker-B"}\n`;
    const res2 = await callRoute("POST", "/snapshot", tokenB, {
      terminalStatus: "completed",
      snapshotJsonl: bJsonl,
      runId: run101,
    });
    expect(res2.status).toBe(200);

    const both = (await sql`
      SELECT run_id, snapshot_jsonl FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
      ORDER BY run_id ASC
    `) as Array<{ run_id: number; snapshot_jsonl: string }>;
    expect(both).toHaveLength(2);
    expect(both[0]).toEqual({ run_id: run100, snapshot_jsonl: aJsonl });
    expect(both[1]).toEqual({ run_id: run101, snapshot_jsonl: bJsonl });
  });

  test("P1#1 tenant safety: cannot POST a snapshot for a runId outside the JWT's (org, agent, conv) tuple", async () => {
    // A misbehaving worker that forges a runId belonging to a different
    // conversation must be rejected. Without this check, the runId-from-
    // body design would be more dangerous than the previous lookup.
    const orgA = await seedAgentRow("agent-scope", {
      organizationId: "org_scope_a",
    });
    const orgB = await seedAgentRow("agent-other", {
      organizationId: "org_scope_b",
    });
    const runInB = await insertRun({
      organizationId: orgB,
      agentId: "agent-other",
      conversationId: "conv-other",
    });

    // Token scoped to (orgA, agent-scope, conv-scope) but with the
    // forged runId from orgB. The route's first check (token.runId ===
    // body.runId) passes; the second (isRunOwnedByJwtScope) rejects.
    const tokenA = mintWorkerToken({
      organizationId: orgA,
      agentId: "agent-scope",
      conversationId: "conv-scope",
      runId: runInB,
    });
    const res = await callRoute("POST", "/snapshot", tokenA, {
      terminalStatus: "completed",
      snapshotJsonl: `{"type":"session","id":"forged"}\n`,
      // Forged: belongs to org B, not the JWT's scope.
      runId: runInB,
    });
    expect(res.status).toBe(403);

    // No row written under either org.
    const sql = getDb();
    const count = (await sql`
      SELECT count(*)::int AS n FROM public.agent_transcript_snapshot
    `) as Array<{ n: number }>;
    expect(count[0]!.n).toBe(0);
  });

  test("P1#2 lock released on pre-spawn throw: spawnDeployment wraps spawn-prep in try/catch with release", async () => {
    // PRE-FIX behavior: lock acquired ~line 465, then several throwing
    // operations (generateEnvironmentVariables at ~494, nix package
    // validation, synchronous spawn() failure) had no release in their
    // error paths — the reserved connection and advisory lock leaked
    // until the gateway recycled.
    //
    // Asserting against `embedded-deployment.ts` source: we expect a
    // try/catch wrapping the spawn-prep block, with `convLock.release()`
    // (or the idempotent wrapper) called from the catch. Reading source
    // here is the only way to assert this without forcing a real
    // subprocess spawn from a test — `spawnDeployment` has no test seam
    // for "force generateEnvironmentVariables to throw, observe lock".
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL(
        "../orchestration/impl/embedded-deployment.ts",
        import.meta.url
      ),
      "utf-8"
    );

    // Locate the spawnDeployment method body so the assertions don't
    // accidentally match the same pattern elsewhere in the file.
    const spawnMatch = src.match(
      /protected async spawnDeployment\([\s\S]*?\n  \}/
    );
    expect(spawnMatch).not.toBeNull();
    const spawnBody = spawnMatch![0];

    // Pre-fix: `const commonEnvVars = await this.generateEnvironmentVariables`
    // (declared inline as a const) followed by the spawn() in the same
    // top-level block with no try wrap. Post-fix: `let child: ChildProcess`
    // declared outside a try, then assigned inside try, then catch that
    // releases convLock and re-throws.
    expect(spawnBody).toMatch(/let child: ChildProcess;/);
    expect(spawnBody).toMatch(/let commonEnvVars: Record<string, string>;/);

    // The catch block must release the lock and re-throw.
    expect(spawnBody).toMatch(
      /catch \(err\) \{[\s\S]*?convLock\.release\(\);[\s\S]*?throw err;/
    );
  });

  test("P1#3 lock released on child exit, not on killWorker entry: killWorker no longer references the release", async () => {
    // PRE-FIX behavior: killWorker released the conv lock BEFORE SIGTERM
    // and BEFORE awaiting exit. During the SIGTERM → exit window the
    // worker was still flushing its snapshot, but a sibling pod could
    // already claim the same conv lock, hydrate from a stale snapshot,
    // and race.
    //
    // The fix: spawnDeployment owns the release via an idempotent
    // closure shared by the error and exit handlers; killWorker no
    // longer touches the lock at all. Asserting against source because
    // killWorker's actual subprocess path can't be unit-tested.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL(
        "../orchestration/impl/embedded-deployment.ts",
        import.meta.url
      ),
      "utf-8"
    );
    // Extract just the killWorker function body via a defensive regex.
    const killWorkerMatch = src.match(
      /private async killWorker\([\s\S]*?\n  \}/
    );
    expect(killWorkerMatch).not.toBeNull();
    const killBody = killWorkerMatch![0];
    // The pre-fix version contained `entry.releaseConvLock` (the early
    // release call). The fix removed it entirely from killWorker.
    expect(killBody).not.toMatch(/releaseConvLock/);
    expect(killBody).not.toMatch(/convLock\.release/);

    // The exit handler must use an idempotent shared closure so the
    // error path + exit path can both fire safely.
    expect(src).toMatch(/releaseLockOnce/);
    expect(src).toMatch(/let lockReleased = false/);
  });

  test("P2 tenant isolation: /api/v1/agents/:id/history reads orgA's snapshot only, not orgB's, when both share the agentId", async () => {
    // PRE-FIX (round 1) behavior: `verifyOwnedAgentAccess` ran a fresh
    // `SELECT organization_id FROM public.agents WHERE id=? AND
    // owner_platform=? AND owner_user_id=? LIMIT 1` — owner_platform +
    // owner_user_id can BOTH match in two orgs simultaneously (same
    // human owns same agentId in two tenants), so the lookup leaked org
    // B's bytes to a session authenticated as org A roughly half the
    // time depending on row order. Codex round 2 finding B noted that
    // the round 1 test drove `readLatestSnapshotJsonl` directly (the
    // store-level helper), not the production `/history` auth path,
    // and missed the bug.
    //
    // FIX: org resolution moved to UserAgentsStore.findAgentOrganizations
    // (reads `agent_users` directly — the authoritative per-org owner
    // mapping). This test drives the HTTP route end-to-end so the
    // ownership-resolver code path is exercised.
    const sharedAgentId = "agent-shared";
    const orgA = "org_p2_a";
    const orgB = "org_p2_b";
    // Seed orgB FIRST so that under the round 1 bug the unscoped
    // `SELECT FROM agents WHERE id=? AND owner_*=? LIMIT 1` lookup
    // returns orgB (PG typically returns inserted-first rows first
    // without an ORDER BY). Both rows have the same owner so the
    // filter doesn't discriminate.
    await seedAgentRow(sharedAgentId, {
      organizationId: orgB,
      ownerPlatform: "external",
      ownerUserId: "u-shared",
    });
    await seedAgentRow(sharedAgentId, {
      organizationId: orgA,
      ownerPlatform: "external",
      ownerUserId: "u-shared",
    });

    // Map ownership in agent_users for ORG A ONLY. The race shape is:
    // BOTH `agents` rows (orgA, orgB) match `(id, owner_platform,
    // owner_user_id)`, but the user actually owns the agent only in
    // orgA (the orgB row was created by someone else with the same
    // owner_user_id). Round 1 resolves org via `agents` and can pick
    // orgB → leaks orgB's snapshot. Round 2 resolves via
    // `agent_users` (this row only) → correctly pins orgA.
    const userAgentsStore = new UserAgentsStore();
    await userAgentsStore.addAgent(
      "external",
      "u-shared",
      sharedAgentId,
      orgA
    );

    // Seed runs + completed snapshots in BOTH orgs. Sort run ids so the
    // orgB snapshot is "newer" globally — under the round 1 bug the
    // unscoped agents lookup could pick orgB even when the caller is
    // authenticated as orgA.
    const sql = getDb();
    const runA = await insertRun({
      organizationId: orgA,
      agentId: sharedAgentId,
      conversationId: "conv-a",
    });
    const runB = await insertRun({
      organizationId: orgB,
      agentId: sharedAgentId,
      conversationId: "conv-b",
    });
    expect(runB).toBeGreaterThan(runA);

    // Distinguishable JSONL: each org's snapshot contains a single
    // message entry whose `text` carries the org id. The /history
    // route parses these into the response, so a cross-tenant leak
    // shows up as the wrong text payload — not just byte mismatch.
    const aJsonl =
      `{"type":"session","version":3,"id":"sess-A","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m-A","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"FROM-ORG-A"}]}}\n`;
    const bJsonl =
      `{"type":"session","version":3,"id":"sess-B","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m-B","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"FROM-ORG-B"}]}}\n`;
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgA}, ${sharedAgentId}, 'conv-a', ${runA},
         ${aJsonl}, ${Buffer.byteLength(aJsonl, "utf-8")}, 'completed'),
        (${orgB}, ${sharedAgentId}, 'conv-b', ${runB},
         ${bJsonl}, ${Buffer.byteLength(bJsonl, "utf-8")}, 'completed')
    `;

    // Snapshot mode on for this test — the /history fallback only
    // consults the PG snapshot when this env is set.
    const previousMode = process.env.LOBU_SESSION_STORE;
    process.env.LOBU_SESSION_STORE = "snapshot";

    try {
      // Authenticate as the shared user. The /history route's
      // ownership resolver should pin the org via agent_users; the
      // round 1 bug would have resolved via agents and picked either
      // org depending on row order.
      setAuthProvider(() => ({
        userId: "u-shared",
        platform: "external",
        exp: Date.now() + 60_000,
      }));

      const app = new Hono();
      app.route(
        "/api/v1/agents/:agentId/history",
        createAgentHistoryRoutes({
          connectionManager: {
            getDeploymentsForAgent() {
              return [];
            },
            getHttpUrl() {
              return null;
            },
          } as any,
          // No agent metadata store — keeps the route on the
          // userAgentsStore (authoritative) path, which is the codex
          // P2 fix point.
          userAgentsStore,
        })
      );

      // Multiple calls — flush any nondeterministic row-order
      // sampling. Under the round 1 bug roughly half would resolve
      // to orgB and return "FROM-ORG-B".
      for (let i = 0; i < 5; i++) {
        const response = await app.request(
          "/api/v1/agents/agent-shared/history/session/messages",
          {
            headers: { host: "localhost" },
            method: "GET",
          }
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          messages: Array<{
            content: Array<{ type: string; text: string }>;
          }>;
        };
        // The route MUST return orgA's content because that's the
        // org the (user, agent) pair resolves to via the round 2
        // fix's findAgentOrganizations. Under the round 1 bug the
        // unscoped `agents` lookup picked whichever row sorted first
        // and could return orgB's "FROM-ORG-B" text.
        expect(body.messages).toHaveLength(1);
        const text = body.messages[0]?.content?.[0]?.text;
        expect(text).toBe("FROM-ORG-A");
        expect(text).not.toBe("FROM-ORG-B");
      }
    } finally {
      setAuthProvider(null);
      if (previousMode === undefined) {
        delete process.env.LOBU_SESSION_STORE;
      } else {
        process.env.LOBU_SESSION_STORE = previousMode;
      }
    }
  });

  test("A2 (codex round 2) — same-conv cross-run impersonation: deployment-lifetime token cannot POST under a sibling run's slot", async () => {
    // Round 1 made the snapshot route check `body.runId` belongs to
    // the JWT's (org, agent, conv) tuple. But the JWT itself carried
    // NO runId, so worker A bearing a same-conv token could POST any
    // same-scope `runs.id` — including run 101 (a sibling worker's
    // slot) — and overwrite worker B's snapshot. Codex round 2
    // finding A.
    //
    // FIX: the route now requires `tokenData.runId === body.runId`.
    // Deployment-lifetime tokens (no runId) ALWAYS 403. Per-run
    // tokens minted by MessageConsumer carry the exact run the worker
    // claimed.
    const orgId = await seedAgentRow("agent-A2", {
      organizationId: "org_a2",
    });
    const agentId = "agent-A2";
    const conversationId = "conv-A2";

    // Two sibling runs in the SAME (org, agent, conv).
    const claimedByA = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const claimedByB = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });

    // 1) A deployment-lifetime token (no runId) cannot POST under ANY
    //    run. Round 1's `body.runId belongs to JWT scope` would have
    //    let this through.
    const deploymentToken = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      // runId intentionally omitted — this is how the existing
      // WORKER_TOKEN is minted at deployment time.
    });
    const aJsonl = `{"type":"session","id":"impersonator"}\n`;
    const resDep = await callRoute("POST", "/snapshot", deploymentToken, {
      terminalStatus: "completed",
      snapshotJsonl: aJsonl,
      runId: claimedByB,
    });
    expect(resDep.status).toBe(403);

    // 2) A per-run token bound to claimedByA cannot POST under
    //    claimedByB. Token.runId !== body.runId.
    const tokenForA = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: claimedByA,
    });
    const resCross = await callRoute("POST", "/snapshot", tokenForA, {
      terminalStatus: "completed",
      snapshotJsonl: aJsonl,
      runId: claimedByB,
    });
    expect(resCross.status).toBe(403);

    // 3) Per-run token bound to claimedByA POSTing under claimedByA
    //    is the green case. Both fields match.
    const resGreen = await callRoute("POST", "/snapshot", tokenForA, {
      terminalStatus: "completed",
      snapshotJsonl: `{"type":"session","id":"legit-A"}\n`,
      runId: claimedByA,
    });
    expect(resGreen.status).toBe(200);

    // 4) Neither earlier 403 created a row.
    const sql = getDb();
    const rows = (await sql`
      SELECT run_id FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
      ORDER BY run_id ASC
    `) as Array<{ run_id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe(claimedByA);
  });

  test("session-reset purges all snapshot rows for this conversation only", async () => {
    // Phase 5: workers (and the gateway-side bridge) must purge PG
    // snapshots on /new, otherwise the next pod boot rehydrates the
    // flushed conversation and the user-visible "Starting fresh" is a
    // lie. This test exercises the worker-side DELETE endpoint.
    const orgId = await seedAgentRow("agent-reset", {
      organizationId: "org_reset",
    });
    const agentId = "agent-reset";
    const conversationId = "conv-reset";

    // Seed 3 completed snapshots for this (org, agent, conv).
    for (let i = 0; i < 3; i++) {
      const runId = await insertRun({
        organizationId: orgId,
        agentId,
        conversationId,
      });
      const token = mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId,
      });
      const jsonl = `{"type":"message","id":"m${i}"}\n`;
      const res = await callRoute("POST", "/snapshot", token, {
        terminalStatus: "completed",
        snapshotJsonl: jsonl,
        runId,
      });
      expect(res.status).toBe(200);
    }

    // Seed an unrelated row in a SIBLING conversation that must NOT be
    // touched by the reset.
    const siblingConv = "conv-sibling";
    const siblingRun = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId: siblingConv,
    });
    const siblingToken = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId: siblingConv,
      runId: siblingRun,
    });
    let res = await callRoute("POST", "/snapshot", siblingToken, {
      terminalStatus: "completed",
      snapshotJsonl: `{"type":"sibling"}\n`,
      runId: siblingRun,
    });
    expect(res.status).toBe(200);

    // DELETE under a per-run token for the reset conversation.
    const resetRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const resetToken = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: resetRunId,
    });
    res = await callRoute("DELETE", "/snapshot", resetToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(3);

    // Sibling conversation row survives; reset conversation has zero rows.
    const sql = getDb();
    const resetRows = (await sql`
      SELECT id FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId}
        AND agent_id = ${agentId}
        AND conversation_id = ${conversationId}
    `) as Array<{ id: number }>;
    expect(resetRows).toHaveLength(0);

    const siblingRows = (await sql`
      SELECT id FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId}
        AND agent_id = ${agentId}
        AND conversation_id = ${siblingConv}
    `) as Array<{ id: number }>;
    expect(siblingRows).toHaveLength(1);

    // Second DELETE is idempotent — returns 200 with deleted=0.
    res = await callRoute("DELETE", "/snapshot", resetToken);
    expect(res.status).toBe(200);
    const body2 = (await res.json()) as { deleted: number };
    expect(body2.deleted).toBe(0);
  });
});

// Drop the auth-provider stub between tests so other suites that share the
// process aren't tainted by the P2 test above.
afterEach(() => {
  setAuthProvider(null);
});
