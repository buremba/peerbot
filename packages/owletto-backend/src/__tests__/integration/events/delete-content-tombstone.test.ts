/**
 * Integration test: `knowledge.delete` writes a tombstone instead of
 * physically removing the row.
 *
 * The events table is append-only — the contract is advertised in the
 * `save_knowledge` MCP tool description and depended on by
 * `get_content.include_superseded` plus `watcher_window_events` FK
 * cascades. `deleteContent` must:
 *   1. Insert a tombstone event whose `supersedes_event_id` points at the
 *      target.
 *   2. Hide the original from default reads (the `current_event_records`
 *      view filters out anything with a newer superseder).
 *   3. Keep the original recoverable via the `events` table directly /
 *      `include_superseded`.
 *   4. Refuse to delete events the caller does not own (other org).
 *   5. Report already-superseded targets without inserting another tombstone.
 *
 * Vitest CI gap: this file documents the behavior and runs locally; CI
 * does not currently exercise it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { deleteContent } from '../../../tools/delete_content';
import type { ToolContext } from '../../../tools/registry';
import { searchContentByText } from '../../../utils/content-search';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('deleteContent (tombstone) > end-to-end', () => {
  let callerOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let otherOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let callerEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let callerCtx: ToolContext;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    callerOrg = await createTestOrganization({ name: 'Tombstone Caller Org' });
    otherOrg = await createTestOrganization({ name: 'Tombstone Other Org' });

    const callerUser = await createTestUser({ email: 'tombstone-caller@example.com' });
    await addUserToOrganization(callerUser.id, callerOrg.id, 'owner');
    callerEntity = await createTestEntity({
      name: 'Tombstone Caller Entity',
      organization_id: callerOrg.id,
    });

    callerCtx = {
      organizationId: callerOrg.id,
      userId: callerUser.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
    };
  });

  it('hides the original event from search, recoverable via raw events table', async () => {
    const target = await createTestEvent({
      organization_id: callerOrg.id,
      entity_id: callerEntity.id,
      content: 'Soft-delete target — should disappear from search after tombstone',
    });

    const result = await deleteContent(
      { event_id: target.id } as never,
      {} as never,
      callerCtx
    );
    expect(result.deleted_ids).toEqual([target.id]);
    expect(result.tombstone_ids).toHaveLength(1);
    expect(result.not_found_ids).toEqual([]);
    expect(result.already_superseded_ids).toEqual([]);

    // Default search via current_event_records must not surface the
    // original anymore (NOT EXISTS newer.supersedes_event_id = e.id).
    const search = await searchContentByText(null, {
      organization_id: callerOrg.id,
      limit: 100,
    });
    const visibleIds = new Set(search.content.map((c) => c.id));
    expect(visibleIds.has(target.id)).toBe(false);

    // Tombstone exists, supersedes the target.
    const sql = getTestDb();
    const tombstoneRows = await sql`
      SELECT id, supersedes_event_id, semantic_type, organization_id
      FROM events
      WHERE id = ${result.tombstone_ids[0]}
    `;
    expect(tombstoneRows).toHaveLength(1);
    expect(Number(tombstoneRows[0].supersedes_event_id)).toBe(target.id);
    expect(tombstoneRows[0].semantic_type).toBe('tombstone');
    expect(tombstoneRows[0].organization_id).toBe(callerOrg.id);

    // Raw events row for the original is still on disk.
    const originalRows = await sql`SELECT id FROM events WHERE id = ${target.id}`;
    expect(originalRows).toHaveLength(1);
  });

  it('refuses to touch events that belong to another org (returns not_found)', async () => {
    const foreign = await createTestEvent({
      organization_id: otherOrg.id,
      content: 'Foreign event — caller must not be able to tombstone this',
    });

    const result = await deleteContent(
      { event_id: foreign.id } as never,
      {} as never,
      callerCtx
    );
    expect(result.deleted_ids).toEqual([]);
    expect(result.tombstone_ids).toEqual([]);
    expect(result.not_found_ids).toEqual([foreign.id]);

    // No tombstone row created for cross-org targets.
    const sql = getTestDb();
    const tombstoneAttempts =
      await sql`SELECT id FROM events WHERE supersedes_event_id = ${foreign.id}`;
    expect(tombstoneAttempts).toHaveLength(0);
  });

  it('reports already-superseded targets and does not insert a duplicate tombstone', async () => {
    const target = await createTestEvent({
      organization_id: callerOrg.id,
      entity_id: callerEntity.id,
      content: 'Will be deleted twice',
    });

    const first = await deleteContent(
      { event_id: target.id } as never,
      {} as never,
      callerCtx
    );
    expect(first.deleted_ids).toEqual([target.id]);
    expect(first.tombstone_ids).toHaveLength(1);

    // Second delete — already superseded by the first tombstone.
    const second = await deleteContent(
      { event_id: target.id } as never,
      {} as never,
      callerCtx
    );
    expect(second.deleted_ids).toEqual([]);
    expect(second.tombstone_ids).toEqual([]);
    expect(second.already_superseded_ids).toEqual([target.id]);

    // Exactly one tombstone exists for this target.
    const sql = getTestDb();
    const tombstones =
      await sql`SELECT id FROM events WHERE supersedes_event_id = ${target.id}`;
    expect(tombstones).toHaveLength(1);
  });

  it('handles a mixed batch (own + foreign + already-superseded + missing)', async () => {
    const own = await createTestEvent({
      organization_id: callerOrg.id,
      entity_id: callerEntity.id,
      content: 'Own event in batch',
    });
    const supersededTarget = await createTestEvent({
      organization_id: callerOrg.id,
      entity_id: callerEntity.id,
      content: 'Will be tombstoned before the batch runs',
    });
    await deleteContent(
      { event_id: supersededTarget.id } as never,
      {} as never,
      callerCtx
    );
    const foreign = await createTestEvent({
      organization_id: otherOrg.id,
      content: 'Foreign event in batch',
    });
    const ghostId = 999_999_999; // doesn't exist

    const result = await deleteContent(
      {
        event_ids: [own.id, supersededTarget.id, foreign.id, ghostId],
        reason: 'batch test',
      } as never,
      {} as never,
      callerCtx
    );

    expect(result.deleted_ids).toEqual([own.id]);
    expect(result.tombstone_ids).toHaveLength(1);
    expect(result.already_superseded_ids).toEqual([supersededTarget.id]);
    expect(new Set(result.not_found_ids)).toEqual(new Set([foreign.id, ghostId]));

    // The tombstone metadata captures the reason for audit.
    const sql = getTestDb();
    const tombstone = await sql`
      SELECT metadata
      FROM events
      WHERE id = ${result.tombstone_ids[0]}
    `;
    expect(tombstone[0].metadata).toMatchObject({
      tombstone: true,
      deleted_event_id: own.id,
      reason: 'batch test',
    });
  });
});
