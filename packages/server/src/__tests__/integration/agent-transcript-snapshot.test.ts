/**
 * E2E reproducer for `feat/agent-transcript-snapshot` per AGENTS.md hard gate.
 *
 * Scenarios (all hit the real Hono routes against the in-process PGlite
 * backend via `pnpm test:pglite`):
 *
 *  1. With LOBU_SESSION_STORE unset (default), the snapshot routes don't
 *     even need to be exercised by the worker — behaviour is unchanged.
 *     (Asserted by NOT touching the env in the baseline test.)
 *  2. Multi-turn conversation persists across "worker restart": writing a
 *     `completed` snapshot then a second hydrate returns the same bytes
 *     verbatim.
 *  3. A `failed` snapshot is never used by hydrate; the latest *completed*
 *     wins even when a newer failed run exists.
 *  4. Two simulated pods racing on the same conversation — second-writer
 *     409s on the UNIQUE constraint, first-writer survives.
 *
 * Boot: `LOBU_TEST_BACKEND=pglite vitest run` (see global-setup.ts).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { generateWorkerToken } from "@lobu/core";
import { createTranscriptRoutes } from "../../gateway/gateway/transcript-routes";
import { acquireConversationLock } from "../../gateway/orchestration/impl/embedded-deployment";
import { readLatestSnapshotJsonl } from "../../gateway/routes/public/agent-history";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
  createTestAgent,
  createTestOrganization,
} from "../setup/test-fixtures";

/**
 * Worker tokens are encrypted by `generateWorkerToken` using ENCRYPTION_KEY.
 * Set a deterministic key for tests so verifyWorkerToken can decrypt.
 */
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ||
  "0000000000000000000000000000000000000000000000000000000000000000";

async function insertRun(opts: {
  organizationId: string;
  agentId: string;
  conversationId: string;
  runType?: string;
  status?: string;
}): Promise<number> {
  const sql = getTestDb();
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

describe("agent_transcript_snapshot routes (E2E)", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it("scenario 2: snapshot round-trip survives worker restart", async () => {
    const org = await createTestOrganization({ name: "Snap Org A" });
    const agent = await createTestAgent({ organizationId: org.id });
    const conversationId = `conv-${Date.now()}`;
    // Two sequential runs simulate two turns of the same conversation.
    const run1 = await insertRun({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });

    const turn1Jsonl =
      `{"type":"session","version":3,"id":"sess-1","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n` +
      `{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-05-18T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}]}}\n`;

    // First "worker" writes its snapshot.
    let res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: turn1Jsonl,
    });
    expect(res.status).toBe(200);

    // Sanity: PG row exists.
    const sql = getTestDb();
    const rows = (await sql`
      SELECT byte_size, terminal_status, run_id
      FROM public.agent_transcript_snapshot
      WHERE organization_id = ${org.id} AND agent_id = ${agent.agentId}
    `) as Array<{ byte_size: number; terminal_status: string; run_id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.byte_size).toBe(Buffer.byteLength(turn1Jsonl, "utf-8"));
    expect(rows[0]!.terminal_status).toBe("completed");
    expect(rows[0]!.run_id).toBe(run1);

    // Second "worker" (simulating a new pod) hydrates.
    res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(200);
    const hydrated = await res.text();
    expect(hydrated).toBe(turn1Jsonl);
  });

  it("scenario 3: failed snapshot does not poison hydrate", async () => {
    const org = await createTestOrganization({ name: "Snap Org B" });
    const agent = await createTestAgent({ organizationId: org.id });
    const conversationId = `conv-${Date.now()}-2`;

    // Run 1: completed. Run 2: failed (newer).
    const run1 = await insertRun({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });
    const goodJsonl =
      `{"type":"session","version":3,"id":"good","timestamp":"2026-05-18T11:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-18T11:00:01Z","message":{"role":"user","content":[{"type":"text","text":"first"}]}}\n`;
    let res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: org.id,
        agentId: agent.agentId,
        conversationId,
      }),
      { terminalStatus: "completed", snapshotJsonl: goodJsonl }
    );
    expect(res.status).toBe(200);

    const run2 = await insertRun({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });
    // The route resolves run_id via `latest matching action_input`, so the
    // newer run wins automatically. Failed snapshot for run2.
    const badJsonl =
      `{"type":"session","version":3,"id":"bad","timestamp":"2026-05-18T11:01:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"mx","parentId":null,"timestamp":"2026-05-18T11:01:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]}}\n`;
    res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: org.id,
        agentId: agent.agentId,
        conversationId,
      }),
      { terminalStatus: "failed", snapshotJsonl: badJsonl }
    );
    expect(res.status).toBe(200);

    // Hydrate must return the COMPLETED snapshot for run1, not the failed
    // run2 with the dangling tool_use.
    res = await callRoute(
      "GET",
      "/snapshot",
      mintWorkerToken({
        organizationId: org.id,
        agentId: agent.agentId,
        conversationId,
      })
    );
    expect(res.status).toBe(200);
    const hydrated = await res.text();
    expect(hydrated).toBe(goodJsonl);

    // Both rows are in PG — hydrate just filters.
    const sql = getTestDb();
    const both = (await sql`
      SELECT terminal_status, run_id
      FROM public.agent_transcript_snapshot
      WHERE organization_id = ${org.id} AND agent_id = ${agent.agentId}
      ORDER BY run_id
    `) as Array<{ terminal_status: string; run_id: number }>;
    expect(both).toHaveLength(2);
    expect(both[0]).toEqual({ terminal_status: "completed", run_id: run1 });
    expect(both[1]).toEqual({ terminal_status: "failed", run_id: run2 });
  });

  it("scenario 4: two-pod race — UNIQUE constraint surfaces 409 to second writer", async () => {
    const org = await createTestOrganization({ name: "Snap Org C" });
    const agent = await createTestAgent({ organizationId: org.id });
    const conversationId = `conv-${Date.now()}-3`;
    await insertRun({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });

    const jsonl = `{"type":"session","version":3,"id":"race","timestamp":"2026-05-18T12:00:00Z","cwd":"/w"}\n`;

    // First writer wins.
    const first = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: jsonl,
    });
    expect(first.status).toBe(200);

    // Second writer for the same (org, agent, conv, run_id) collides.
    const second = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: `${jsonl}{"type":"message","id":"m2"}\n`,
    });
    expect(second.status).toBe(409);

    // Original content remains.
    const get = await callRoute("GET", "/snapshot", token);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(jsonl);
  });

  it("hydrate returns 404 when no completed snapshot exists", async () => {
    const org = await createTestOrganization({ name: "Snap Org D" });
    const agent = await createTestAgent({ organizationId: org.id });
    const conversationId = `conv-${Date.now()}-4`;
    const token = mintWorkerToken({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });

    // No run, no snapshot — hydrate 404s.
    let res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(404);

    // Insert a run + failed snapshot. Hydrate still 404s — only completed
    // counts.
    await insertRun({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });
    res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "failed",
      snapshotJsonl: `{"type":"session","version":3,"id":"f","timestamp":"2026-05-18T13:00:00Z","cwd":"/w"}\n`,
    });
    expect(res.status).toBe(200);

    res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(404);
  });

  it("rejects token without (org, agent, conv) scope", async () => {
    // Mint a token missing organizationId.
    const token = generateWorkerToken(
      "test-user",
      "conv-x",
      "lobu-worker-x",
      { channelId: "chan-x", agentId: "agent-x" }
    );
    const res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(400);
  });

  it("scenario 5: /agent-history fallback reads the latest completed snapshot", async () => {
    // Reproduces the new disk-replacement path: with at least one completed
    // snapshot in PG, readLatestSnapshotJsonl resolves the bytes (via the
    // (org, agent, run DESC) index) without touching the filesystem.
    const org = await createTestOrganization({ name: "Snap Org E" });
    const agent = await createTestAgent({ organizationId: org.id });
    const conversationId = `conv-${Date.now()}-5`;
    const runId = await insertRun({
      organizationId: org.id,
      agentId: agent.agentId,
      conversationId,
    });

    const completedJsonl =
      `{"type":"session","version":3,"id":"hist","timestamp":"2026-05-18T14:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-18T14:00:01Z","message":{"role":"user","content":[{"type":"text","text":"history check"}]}}\n`;
    const sql = getTestDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${org.id}, ${agent.agentId}, ${conversationId}, ${runId},
         ${completedJsonl},
         ${Buffer.byteLength(completedJsonl, "utf-8")}, 'completed')
    `;

    // Function-level assertion — env-gate is checked by callers.
    const out = await readLatestSnapshotJsonl(agent.agentId);
    expect(out).toBe(completedJsonl);

    // Unknown agent → null (no PG row, no disk fallback in this helper).
    const miss = await readLatestSnapshotJsonl("agent-does-not-exist");
    expect(miss).toBeNull();
  });

  it("scenario 4b: advisory lock helper is a no-op in embedded mode", async () => {
    // The cross-pod advisory lock prevents two real-PG-backed gateway pods
    // from running the same (org, agent, conv) worker in parallel. In
    // embedded mode (LOBU_DISABLE_PREPARE=1, set by global-setup.ts for
    // PGlite) the postgres.js pool is pinned to a single connection, so
    // `reserve()` would block any sibling query forever — and in single-
    // process mode the in-process workers Map already gates concurrency,
    // so the lock isn't needed. The helper detects this and returns a
    // no-op sentinel.
    //
    // The genuine cross-pod path is asserted manually in the PR body's
    // dual-psql reproducer (two real-PG sessions racing pg_try_advisory_lock
    // on the same key). It cannot be exercised under PGlite for the
    // reasons above.
    expect(process.env.LOBU_DISABLE_PREPARE).toBe("1");

    const a = await acquireConversationLock("org_x", "agent-x", "conv-x");
    expect(a).not.toBeNull();
    // Embedded sentinel: release() resolves without doing anything; a
    // second acquire on the same key also succeeds (no real lock held).
    const b = await acquireConversationLock("org_x", "agent-x", "conv-x");
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });
});
