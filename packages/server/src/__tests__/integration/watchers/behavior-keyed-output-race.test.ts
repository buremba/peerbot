/**
 * Keyed Behavior event outputs must keep EXACTLY ONE live event per key.
 *
 * `persistBehaviorEventOutput` resolves the current head with a SELECT and then
 * INSERTs inside the caller's transaction. Under READ COMMITTED a second run
 * whose probe lands before the first run COMMITS sees no head, so both insert
 * with `supersedes_event_id = NULL` and both stay live — permanently, silently,
 * with no error raised. `idx_events_superseded_by` cannot catch it because it is
 * unique on `supersedes_event_id`, which is NULL on both rows.
 *
 * This is not a timing test. The interleaving is forced: transaction A is held
 * open after its insert until B has probed and committed, which is exactly the
 * state two Behaviour runs on two replicas are in when their windows overlap.
 */
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { persistBehaviorEventOutput } from '../../../utils/persist-behavior-event-output';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';

const KEYED_OUTPUT = {
  event: 'voice_profile',
  key: ['channel', 'mode'],
} as const;

/**
 * Block until some backend is waiting on a transaction lock — the state a
 * conflicting INSERT enters while the tuple it collides with is still
 * uncommitted. Polls on a THIRD connection, so it observes A and B rather than
 * participating. Throws instead of hanging, so a version of this suite where the
 * race stops being reachable fails loudly rather than silently testing nothing.
 */
async function waitForBlockedInsert(sql: Sql, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%INSERT INTO events%'
    `;
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'no INSERT ever blocked on the identity constraint — the concurrent interleaving was not reached, so this test would prove nothing'
  );
}

describe('Behavior keyed event outputs > concurrent runs', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('keeps exactly one live event per key when two runs interleave', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Keyed Race Org' });
    const organizationId = workspace.org.id;
    const watcherId = 4242;

    /** One Behaviour run persisting a single keyed draft. */
    const persistRun = (tx: DbClient, canvasRevisionId: number) =>
      persistBehaviorEventOutput({
        tx,
        rows: [
          {
            title: 'Voice profile',
            content: `Refinement from canvas ${canvasRevisionId}.`,
            metadata: { channel: 'x', mode: 'taste' },
          },
        ],
        outputName: 'profiles',
        output: KEYED_OUTPUT,
        watcherId,
        organizationId,
        windowId: 1,
        // A distinct canvas revision per run — that is what a real second run
        // produces, and it keeps the two runs off the idempotency-key index so
        // the keyed identity is the only thing that can prevent a duplicate.
        canvasRevisionId,
        runId: null,
        boundEntityIds: [],
        validContentIds: new Set<number>(),
        occurredAt: new Date().toISOString(),
      });

    // ── Force the interleaving ────────────────────────────────────────────
    // A inserts, then parks with its transaction still OPEN. B therefore probes
    // against a database where A's row is not yet visible.
    let signalAInserted!: () => void;
    const aInserted = new Promise<void>((resolve) => {
      signalAInserted = resolve;
    });
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runA = sql.begin(async (tx) => {
      await persistRun(tx as unknown as DbClient, 1001);
      signalAInserted();
      await aMayCommit;
    });

    await aInserted;
    // B must NOT be awaited before A is released: once the identity constraint
    // exists, B's insert blocks on A's uncommitted conflicting tuple — which is
    // the constraint working — so awaiting B here would deadlock the test
    // against itself rather than exercise the race.
    const runB = sql.begin(async (tx) => {
      await persistRun(tx as unknown as DbClient, 1002);
    });

    // Releasing A here directly would be a COIN FLIP, not a race: A usually
    // commits while B is still acquiring its connection, so B's probe finds the
    // committed head and performs an ordinary supersede. Measured — the retry
    // branch was entered 0 times in 3 runs, i.e. the interesting path was never
    // executed and a mutation to it did not fail this test.
    //
    // Wait for B to be genuinely BLOCKED on A's uncommitted tuple instead. That
    // state is only reachable once B has already probed and seen no head (a
    // READ COMMITTED SELECT never blocks), so it pins the exact interleaving:
    // both runs believe they are creating the first version of this key.
    // releaseA in finally: if the wait times out, A must still commit so the
    // failure surfaces as the timeout's message, not as a hung pool teardown.
    try {
      await waitForBlockedInsert(sql);
    } finally {
      releaseA();
    }
    await Promise.all([runA, runB]);

    const live = await sql<{ id: number; supersedes_event_id: number | null }[]>`
      SELECT id, supersedes_event_id
      FROM events
      WHERE organization_id = ${organizationId}
        AND semantic_type = 'voice_profile'
        AND superseded_by IS NULL
      ORDER BY id
    `;

    // Both rows must survive — events is append-only — but only one may be live.
    const all = await sql<{ id: number; supersedes_event_id: number | null }[]>`
      SELECT id, supersedes_event_id FROM events
      WHERE organization_id = ${organizationId} AND semantic_type = 'voice_profile'
      ORDER BY id
    `;
    expect(all).toHaveLength(2);
    expect(live).toHaveLength(1);

    // And the survivors form ONE chain, which is what proves the recovery path
    // ran rather than the constraint merely rejecting B outright. B's first
    // insert hit 23505 on idx_events_identity_root_behavior, so it re-probed,
    // found A's now-committed row, and retried as A's successor.
    const [root, successor] = all;
    expect(root.supersedes_event_id).toBeNull();
    expect(successor.supersedes_event_id).toBe(root.id);
    expect(live[0].id).toBe(successor.id);
  });
});
