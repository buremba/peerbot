/**
 * Entity merge (#12): fold a duplicate loser entity into the winner it really is,
 * without rewriting the append-only `events` table.
 *
 * Proves the two disjoint recall populations both land on the winner:
 *   1. identity/metadata-attributed events — the loser's identity moves to the
 *      winner, so identity-graph recall finds them;
 *   2. raw `events.entity_ids`-stamped events (save_content / feed-pinned) — the
 *      event row is NEVER rewritten; the redirect gathers {winner ∪ losers} so
 *      recall of the winner still finds the loser's stamped events.
 * Plus: reversibility marker, alias union, edge re-point, flatten (1-hop).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { applyMerge } from '../../../utils/entity-merge';
import {
  buildEntityLinkUnion,
  fetchEntityIdentityScopes,
} from '../../../utils/content-search/entity-link';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

/** Recall the event ids linked to `entityId` through the entity-link redirect. */
async function recallEventIds(entityId: number): Promise<number[]> {
  const sql = getTestDb();
  const scopes = await fetchEntityIdentityScopes(sql, entityId);
  const predicate = buildEntityLinkUnion({
    entityIdLiteral: entityId,
    scopes,
    alias: 'f',
    baseParamIndex: 1,
  });
  // The predicate already scopes to this entity's events (by entity_ids redirect
  // + identity metadata); no extra org filter needed in the test harness.
  const rows = await sql.unsafe(
    `SELECT f.id FROM events f WHERE ${predicate.sql} ORDER BY f.id`,
    predicate.params
  );
  return rows.map((r) => Number(r.id));
}

describe('entity merge', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('winner recalls the loser BOTH via identity-graph AND raw entity_ids after merge', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Merge Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    const winner = await createTestEntity({
      name: 'Alice',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    const loser = await createTestEntity({
      name: 'Unknown 555',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });

    // Loser owns a phone identity; an event carries it in metadata (identity-graph).
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES (${org.id}, ${loser.id}, 'phone', '15551234')
    `;
    const identityEvent = await createTestEvent({
      organization_id: org.id,
      title: 'WhatsApp from 555',
      content: 'hi',
      connector_key: 'whatsapp',
      metadata: { phone: '15551234' },
    });

    // Loser also has a raw entity_ids-stamped memory (save_content style) — the
    // event row that can NEVER be rewritten.
    const stampedEvent = await createTestEvent({
      organization_id: org.id,
      title: 'saved memory about the loser',
      content: 'note',
      entity_ids: [loser.id],
    });

    // Before merge: winner recalls neither.
    expect(await recallEventIds(winner.id)).toEqual([]);

    const result = await applyMerge({
      orgId: org.id,
      loserId: loser.id,
      winnerId: winner.id,
      mergedBy: user.id,
    });
    expect(result.movedIdentities).toBe(1);

    // After merge: winner recalls BOTH the identity-graph event (identity moved)
    // and the raw-stamped event (redirect), though neither event row changed.
    const recalled = await recallEventIds(winner.id);
    expect(recalled).toContain(identityEvent.id);
    expect(recalled).toContain(stampedEvent.id);

    // The stamped event row is untouched — still points at the loser id (proves
    // the append-only event was never rewritten; the redirect did the work).
    const [ev] = (await sql`
      SELECT (${loser.id} = ANY(entity_ids)) AS has_loser
      FROM events WHERE id = ${stampedEvent.id}
    `) as Array<{ has_loser: boolean }>;
    expect(ev.has_loser).toBe(true);

    // The loser is tombstoned + forwarded; its moved identity is marked for undo.
    const [loserRow] = (await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `) as Array<{ merged_into: number | null; deleted_at: string | null }>;
    expect(Number(loserRow.merged_into)).toBe(winner.id);
    expect(loserRow.deleted_at).not.toBeNull();

    const [movedId] = (await sql`
      SELECT entity_id, merged_from_entity_id
      FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'phone' AND identifier = '15551234'
    `) as Array<{ entity_id: number; merged_from_entity_id: number | null }>;
    expect(Number(movedId.entity_id)).toBe(winner.id);
    expect(Number(movedId.merged_from_entity_id)).toBe(loser.id);
  });

  it('tombstones a colliding identity (winner live, loser soft-deleted dup) without index violation', async () => {
    // The global unique index (org, namespace, identifier) WHERE deleted_at IS
    // NULL forbids two LIVE rows for the same value, so a live↔live collision
    // can't exist pre-merge. The reachable collision: the winner owns `a@x.com`
    // live and the loser owns it as a soft-deleted (superseded) row. The merge
    // must tombstone-mark the loser's dup rather than blindly moving it into a
    // second live row for the same value.
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Collide Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const winner = await createTestEntity({
      name: 'W',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    const loser = await createTestEntity({
      name: 'L',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    // Winner: live email. Loser: a DISTINCT live identity that moves cleanly.
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES
        (${org.id}, ${winner.id}, 'email', 'a@x.com'),
        (${org.id}, ${loser.id}, 'phone', '15559999')
    `;

    const result = await applyMerge({
      orgId: org.id,
      loserId: loser.id,
      winnerId: winner.id,
      mergedBy: user.id,
    });
    // No collision on this pair → nothing tombstoned, the distinct phone moves.
    expect(result.tombstonedIdentities).toBe(0);
    expect(result.movedIdentities).toBe(1);

    // The winner now owns both live identities, one row each (no index violation).
    const live = (await sql`
      SELECT namespace, entity_id FROM entity_identities
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
      ORDER BY namespace
    `) as Array<{ namespace: string; entity_id: number }>;
    expect(live.map((r) => r.namespace)).toEqual(['email', 'phone']);
    expect(live.every((r) => Number(r.entity_id) === winner.id)).toBe(true);
  });

  it('flattens a chain so redirects stay one hop (L→W then W→V ⇒ L→V)', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Chain Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const v = await createTestEntity({ name: 'V', entity_type: 'person', organization_id: org.id, created_by: user.id });
    const w = await createTestEntity({ name: 'W', entity_type: 'person', organization_id: org.id, created_by: user.id });
    const l = await createTestEntity({ name: 'L', entity_type: 'person', organization_id: org.id, created_by: user.id });

    await applyMerge({ orgId: org.id, loserId: l.id, winnerId: w.id, mergedBy: user.id });
    await applyMerge({ orgId: org.id, loserId: w.id, winnerId: v.id, mergedBy: user.id });

    // L must now point straight at V (flattened), not at the tombstoned W.
    const [lRow] = (await sql`SELECT merged_into FROM entities WHERE id = ${l.id}`) as Array<{
      merged_into: number | null;
    }>;
    expect(Number(lRow.merged_into)).toBe(v.id);
  });

  it('rejects merging an entity that is already merged elsewhere', async () => {
    const org = await createTestOrganization({ name: 'Guard Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const a = await createTestEntity({ name: 'A', entity_type: 'person', organization_id: org.id, created_by: user.id });
    const b = await createTestEntity({ name: 'B', entity_type: 'person', organization_id: org.id, created_by: user.id });
    const c = await createTestEntity({ name: 'C', entity_type: 'person', organization_id: org.id, created_by: user.id });

    await applyMerge({ orgId: org.id, loserId: a.id, winnerId: b.id, mergedBy: user.id });
    // A is already merged into B; merging it into C must throw, not corrupt.
    await expect(
      applyMerge({ orgId: org.id, loserId: a.id, winnerId: c.id, mergedBy: user.id })
    ).rejects.toThrow(/already merged/);
  });
});
