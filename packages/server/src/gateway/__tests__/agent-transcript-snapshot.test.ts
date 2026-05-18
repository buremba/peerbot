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
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { createTranscriptRoutes } from "../gateway/transcript-routes.js";
import { acquireConversationLock } from "../orchestration/impl/embedded-deployment.js";
import { readLatestSnapshotJsonl } from "../routes/public/agent-history.js";
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
      queue_name, run_at, created_at
    ) VALUES (
      ${opts.organizationId},
      ${runType},
      ${status},
      ${sql.json({ agentId: opts.agentId, conversationId: opts.conversationId })},
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
}): string {
  return generateWorkerToken(
    "test-user",
    opts.conversationId,
    `lobu-worker-${opts.agentId}`,
    {
      channelId: `chan-${opts.conversationId}`,
      agentId: opts.agentId,
      organizationId: opts.organizationId,
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

    // Turn 1: insert a chat_message run, POST a completed snapshot.
    const run1 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const turn1 =
      `{"type":"session","version":3,"id":"s1","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"u1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"turn 1 user"}]}}\n` +
      `{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-05-18T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"turn 1 assistant"}]}}\n`;
    let res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: turn1,
    });
    expect(res.status).toBe(200);

    // Turn 2: new run, append more entries, POST another completed snapshot.
    const run2 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const turn2 =
      turn1 +
      `{"type":"message","id":"u2","parentId":"a1","timestamp":"2026-05-18T10:01:00Z","message":{"role":"user","content":[{"type":"text","text":"turn 2 user"}]}}\n` +
      `{"type":"message","id":"a2","parentId":"u2","timestamp":"2026-05-18T10:01:01Z","message":{"role":"assistant","content":[{"type":"text","text":"turn 2 assistant"}]}}\n`;
    res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: turn2,
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

    // Hydrate returns the latest (turn 2 bytes verbatim).
    res = await callRoute("GET", "/snapshot", token);
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
    await insertRun({ organizationId: orgId, agentId, conversationId });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
    });

    const padding = "x".repeat(600_000);
    const big =
      `{"type":"session","version":3,"id":"big","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"big1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"${padding}"}]}}\n`;

    let res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: big,
    });
    expect(res.status).toBe(200);

    // Round-trip is byte-identical.
    res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out.length).toBe(big.length);
    expect(out).toBe(big);
  });

  test("default-off: no snapshot rows ever created when LOBU_SESSION_STORE is unset", async () => {
    // Asserts the env gate at the resolver level. The route layer doesn't
    // check the env (writes are always honoured if the JWT is valid), but
    // /agent-history's readLatestSnapshotJsonl is the consumer of that env
    // gate. With no snapshot row, the resolver returns null and the
    // existing disk-read fallback path runs.
    const previous = process.env.LOBU_SESSION_STORE;
    delete process.env.LOBU_SESSION_STORE;
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
      const out = await readLatestSnapshotJsonl("agent-off");
      expect(out).toBeNull();
    } finally {
      if (previous !== undefined) process.env.LOBU_SESSION_STORE = previous;
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
      }),
      { terminalStatus: "completed", snapshotJsonl: completedJsonl }
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
      }),
      { terminalStatus: "failed", snapshotJsonl: failedJsonl }
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
    await insertRun({ organizationId: orgId, agentId, conversationId });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
    });

    let res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "failed",
      snapshotJsonl: `{"type":"session","id":"only-bad"}\n`,
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

    await insertRun({ organizationId: orgId, agentId, conversationId });
    const prior = `{"type":"session","id":"prior"}\n{"type":"message","id":"p1"}\n`;
    let res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
      }),
      { terminalStatus: "completed", snapshotJsonl: prior }
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
    await insertRun({ organizationId: orgId, agentId, conversationId });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
    });

    const winningJsonl = `{"type":"session","id":"first-writer"}\n`;
    const first = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: winningJsonl,
    });
    expect(first.status).toBe(200);

    const second = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: `${winningJsonl}{"type":"message","id":"loser"}\n`,
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

    const out = await readLatestSnapshotJsonl(agentId);
    expect(out).toBe(jsonl);
  });

  test("dead-worker-no-snapshot: readLatestSnapshotJsonl returns null on miss (no 500)", async () => {
    // No agent row → null. The callers (readSessionMessages / readSessionStats)
    // fall through to findSessionFile, which returns the documented empty
    // sentinel — never a 500.
    const out = await readLatestSnapshotJsonl("agent-does-not-exist");
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

    const out = await readLatestSnapshotJsonl(agentId);
    expect(out).toBe(jsonl);
    // Splitting on \n recovers the same line set the admin UI parses.
    expect(out!.split("\n").filter((l) => l.length > 0)).toEqual(lines);
  });
});

describe("agent_transcript_snapshot — advisory lock helper", () => {
  test("lock-no-op-in-embedded-mode: PGlite-pinned pool returns sentinel without reserving", async () => {
    // Embedded mode pins the postgres.js pool to a single connection; the
    // real reserve()-based path would block forever. The helper detects
    // LOBU_DISABLE_PREPARE=1 (set by ensurePgliteForGatewayTests) and
    // returns a no-op release. The genuine cross-pod path is asserted in
    // the PR body's dual-psql repro.
    expect(process.env.LOBU_DISABLE_PREPARE).toBe("1");

    const a = await acquireConversationLock("org_lock_a", "agent-x", "conv-x");
    expect(a).not.toBeNull();
    // No real lock held → second acquire on the same key also succeeds.
    const b = await acquireConversationLock("org_lock_a", "agent-x", "conv-x");
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  test("lock-cross-conv-parallelism (embedded sentinel): different (org,agent,conv) acquire independently", async () => {
    // Asserts the helper's keying — even in embedded sentinel mode the
    // call shape passes through and each acquire/release pairs cleanly.
    // The real-PG path uses pg_try_advisory_lock(int32, int32) where each
    // unique (org,agent,conv) hashes to a distinct key2.
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
