/**
 * Integration test: scripts/dedup-events.ts — remove DUPLICATE current rows.
 *
 * A now-fixed concurrency bug (PR #1286) let concurrent ingests of the same item
 * create MULTIPLE current rows for one (organization_id, connection_id,
 * origin_id). The dedup script keeps the newest current row (survivor) per
 * group, deletes the other current rows (losers) AND their transitive
 * supersedes-ancestor chains (so a deleted loser can't un-hide an ancestor), and
 * leaves single-chain groups (legit version history) untouched.
 *
 * This test pins, against a REAL Postgres, the three contract points:
 *   1. DUPLICATE group (2 current rows, one with a superseded ancestor) →
 *      after run: exactly 1 current row, loser+ancestor gone, survivor kept.
 *   2. LEGIT single chain (1 current + 1 superseded) → UNTOUCHED.
 *   3. IDEMPOTENT: a second run finds 0 duplicate groups / 0 deletes.
 *
 * It drives `dedupEvents()` directly (the same function the CLI wraps), passing
 * the test DB client so it never touches the singleton pool.
 *
 * Vitest CI gap note (mirrors neighbors): runs against the dev/CI pgvector DB
 * via DATABASE_URL; the integration job runs it in CI.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dedupEvents } from '../../../../../../scripts/dedup-events';
import type { DbClient } from '../../../db/client';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

/**
 * Insert a raw events row with explicit created_at + supersedes_event_id so the
 * survivor (newest) and the supersession chain are fully deterministic. Returns
 * the new id.
 */
async function insertRow(opts: {
  organizationId: string;
  connectionId: number;
  originId: string;
  connectorKey: string;
  content: string;
  createdAt: string;
  supersedesEventId?: number | null;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql`
    INSERT INTO events (
      entity_ids, organization_id, connection_id, origin_id,
      payload_type, payload_text, semantic_type, connector_key,
      metadata, supersedes_event_id, created_at
    ) VALUES (
      '{}'::bigint[],
      ${opts.organizationId},
      ${opts.connectionId},
      ${opts.originId},
      'text',
      ${opts.content},
      'content',
      ${opts.connectorKey},
      ${sql.json({})},
      ${opts.supersedesEventId ?? null},
      ${opts.createdAt}
    )
    RETURNING id
  `;
  return Number(row.id);
}

async function isCurrent(id: number): Promise<boolean> {
  const sql = getTestDb();
  const rows = await sql`SELECT id FROM current_event_records WHERE id = ${id}`;
  return rows.length === 1;
}

async function existsRow(id: number): Promise<boolean> {
  const sql = getTestDb();
  const rows = await sql`SELECT id FROM events WHERE id = ${id}`;
  return rows.length === 1;
}

async function currentCount(
  organizationId: string,
  connectionId: number,
  originId: string
): Promise<number> {
  const sql = getTestDb();
  const rows = await sql`
    SELECT id FROM current_event_records
    WHERE organization_id = ${organizationId}
      AND connection_id = ${connectionId}
      AND origin_id = ${originId}
  `;
  return rows.length;
}

describe('scripts/dedup-events > remove duplicate current rows', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let connectionId: number;

  // Scenario 1: duplicate group (2 current rows; loser has a superseded ancestor).
  let dupSurvivorId: number;
  let dupLoserAncestorId: number; // superseded by the loser
  let dupLoserId: number; // a SECOND current row (the bug)

  // Scenario 2: legit single chain (1 current + 1 superseded ancestor).
  let legitAncestorId: number; // superseded → hidden
  let legitCurrentId: number; // the single current row

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Dedup Script Org' });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });
    connectionId = Number(conn.id);

    // ── Scenario 1: the bug — two current rows for one origin_id ──────────────
    // The loser is the OLDER current row and has a superseded ancestor it once
    // replaced. The survivor is the NEWEST current row (no ancestor here).
    const dupOrigin = 'reddit_post_dup';

    // Ancestor (will be superseded by the loser → hidden, NOT current).
    dupLoserAncestorId = await insertRow({
      organizationId: org.id,
      connectionId,
      originId: dupOrigin,
      connectorKey: 'reddit',
      content: 'dup ancestor v0',
      createdAt: '2026-04-01T00:00:00Z',
    });

    // Loser: a current row (nothing supersedes it) that itself supersedes the
    // ancestor. This is the older of the two current rows.
    dupLoserId = await insertRow({
      organizationId: org.id,
      connectionId,
      originId: dupOrigin,
      connectorKey: 'reddit',
      content: 'dup loser v1 (current, supersedes ancestor)',
      createdAt: '2026-04-02T00:00:00Z',
      supersedesEventId: dupLoserAncestorId,
    });

    // Survivor: the NEWEST current row, created by the concurrency bug as a
    // second fresh insert (supersedes nothing).
    dupSurvivorId = await insertRow({
      organizationId: org.id,
      connectionId,
      originId: dupOrigin,
      connectorKey: 'reddit',
      content: 'dup survivor v1b (current, fresh — the duplicate)',
      createdAt: '2026-04-03T00:00:00Z',
    });

    // ── Scenario 2: legit single chain — must be left UNTOUCHED ───────────────
    const legitOrigin = 'reddit_post_legit';
    legitAncestorId = await insertRow({
      organizationId: org.id,
      connectionId,
      originId: legitOrigin,
      connectorKey: 'reddit',
      content: 'legit ancestor v0',
      createdAt: '2026-04-01T00:00:00Z',
    });
    legitCurrentId = await insertRow({
      organizationId: org.id,
      connectionId,
      originId: legitOrigin,
      connectorKey: 'reddit',
      content: 'legit current v1 (supersedes ancestor)',
      createdAt: '2026-04-02T00:00:00Z',
      supersedesEventId: legitAncestorId,
    });
  });

  it('seeds the bug: the duplicate group has TWO current rows before dedup', async () => {
    // Sanity — this is the precondition the script must repair. If this is 1,
    // the seed is wrong and the green assertions below would be vacuous.
    expect(await currentCount(org.id, connectionId, 'reddit_post_dup')).toBe(2);
    expect(await currentCount(org.id, connectionId, 'reddit_post_legit')).toBe(1);
  });

  it('dry-run reports the duplicate group + loser/ancestor rows without deleting', async () => {
    const sql = getTestDb() as unknown as DbClient;
    const report = await dedupEvents({
      execute: false,
      batchSize: 100,
      db: sql,
      log: () => {},
    });

    expect(report.duplicateGroups).toBe(1);
    // loser + its ancestor = 2 rows that WOULD be deleted.
    expect(report.totalDeletes).toBe(2);
    expect(report.executed).toBe(false);

    // Nothing actually removed.
    expect(await existsRow(dupLoserId)).toBe(true);
    expect(await existsRow(dupLoserAncestorId)).toBe(true);
    expect(await currentCount(org.id, connectionId, 'reddit_post_dup')).toBe(2);
  });

  it('execute: keeps the survivor, deletes the loser AND its ancestor chain', async () => {
    const sql = getTestDb() as unknown as DbClient;
    const report = await dedupEvents({
      execute: true,
      batchSize: 100,
      db: sql,
      log: () => {},
    });

    expect(report.duplicateGroups).toBe(1);
    expect(report.totalDeletes).toBe(2);
    expect(report.executed).toBe(true);

    // Duplicate group now has exactly one current row — the survivor.
    expect(await currentCount(org.id, connectionId, 'reddit_post_dup')).toBe(1);
    expect(await isCurrent(dupSurvivorId)).toBe(true);
    expect(await existsRow(dupSurvivorId)).toBe(true);

    // Loser and its ancestor are gone (the ancestor too, so it can't resurface).
    expect(await existsRow(dupLoserId)).toBe(false);
    expect(await existsRow(dupLoserAncestorId)).toBe(false);
  });

  it('leaves the legit single chain UNTOUCHED', async () => {
    // Both the current row and its (legitimately) superseded ancestor survive.
    expect(await existsRow(legitCurrentId)).toBe(true);
    expect(await existsRow(legitAncestorId)).toBe(true);
    expect(await isCurrent(legitCurrentId)).toBe(true);
    expect(await isCurrent(legitAncestorId)).toBe(false);
    expect(await currentCount(org.id, connectionId, 'reddit_post_legit')).toBe(1);
  });

  it('is idempotent: a second execute finds 0 duplicate groups / 0 deletes', async () => {
    const sql = getTestDb() as unknown as DbClient;
    const report = await dedupEvents({
      execute: true,
      batchSize: 100,
      db: sql,
      log: () => {},
    });

    expect(report.duplicateGroups).toBe(0);
    expect(report.totalDeletes).toBe(0);
    expect(report.currentRowsBefore).toBe(report.currentRowsAfter);
  });
});
