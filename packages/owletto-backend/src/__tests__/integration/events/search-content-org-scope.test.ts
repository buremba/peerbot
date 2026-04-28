/**
 * Integration test: org-scoping in `searchContentByText`.
 *
 * The original bug: an event saved with `f.organization_id = caller` but
 * empty `entity_ids` and no connection was invisible to `search_knowledge`,
 * because the org-scope clause required either an entity bridge or
 * (only when entity_ids was empty) a connection bridge. The fix turns the
 * clause into a triple-OR: direct org match OR entity bridge OR connection
 * bridge. This test pins all four cases plus the cross-org isolation
 * guarantee.
 *
 * NOTE: this file uses vitest. CI does not currently run the vitest
 * integration suite (see CLAUDE memory: "vitest CI gap"); the test runs
 * locally against the dev Postgres and acts as a regression record until
 * vitest is wired into CI.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('searchContentByText > org-scope visibility', () => {
  let callerOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let otherOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let callerEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let otherEntity: Awaited<ReturnType<typeof createTestEntity>>;

  let directOrgEventId: number;
  let entityBridgeEventId: number;
  let connectionBridgeEventId: number;
  let foreignEventId: number;
  let crossLinkedFromOtherEventId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    callerOrg = await createTestOrganization({ name: 'Caller Org' });
    otherOrg = await createTestOrganization({ name: 'Other Org' });

    const callerUser = await createTestUser({ email: 'caller-orgscope@example.com' });
    await addUserToOrganization(callerUser.id, callerOrg.id, 'owner');

    callerEntity = await createTestEntity({
      name: 'Caller Entity',
      organization_id: callerOrg.id,
    });
    otherEntity = await createTestEntity({
      name: 'Other Entity',
      organization_id: otherOrg.id,
    });

    await createTestConnectorDefinition({
      key: 'orgscope-test-connector',
      name: 'OrgScope Test',
      organization_id: callerOrg.id,
    });
    const callerConnection = await createTestConnection({
      organization_id: callerOrg.id,
      connector_key: 'orgscope-test-connector',
      entity_ids: [callerEntity.id],
    });

    // 1. Direct org match: f.organization_id = callerOrg, no entity_ids,
    //    no connection. This is the row that triggered the original bug —
    //    save_knowledge with no entity_ids landed but search couldn't find
    //    it.
    directOrgEventId = (
      await createTestEvent({
        organization_id: callerOrg.id,
        entity_ids: [],
        content: 'Direct-org event with no entity bridge and no connection',
      })
    ).id;

    // 2. Entity bridge: caller's entity referenced in entity_ids. Visible
    //    pre-fix, must remain visible post-fix.
    entityBridgeEventId = (
      await createTestEvent({
        organization_id: callerOrg.id,
        entity_id: callerEntity.id,
        content: 'Event linked to caller entity',
      })
    ).id;

    // 3. Connection bridge: connection in caller's org, no entity_ids.
    //    Was the only path the old SQL allowed for entity-less events.
    connectionBridgeEventId = (
      await createTestEvent({
        organization_id: callerOrg.id,
        connection_id: callerConnection.id,
        entity_ids: [],
        content: 'Event from caller connection with no entity_ids',
      })
    ).id;

    // 4. Foreign event: lives entirely in otherOrg with otherOrg's entity.
    //    Must NOT be visible to caller.
    foreignEventId = (
      await createTestEvent({
        organization_id: otherOrg.id,
        entity_id: otherEntity.id,
        content: 'Event in another org we should never see',
      })
    ).id;

    // 5. Cross-linked event: stamped to otherOrg but its entity_ids points
    //    at callerEntity. Pre-existing entity-bridge behavior says caller
    //    sees it. Pin that behavior didn't regress.
    crossLinkedFromOtherEventId = (
      await createTestEvent({
        organization_id: otherOrg.id,
        entity_id: callerEntity.id,
        content: 'Cross-linked event stamped to other org but mentioning our entity',
      })
    ).id;
  });

  it('finds events stamped directly to the caller org with no entity bridge', async () => {
    // Sanity: confirm fixture state is committed before reading.
    const sql = getTestDb();
    await sql`SELECT 1`;

    const result = await searchContentByText(null, {
      organization_id: callerOrg.id,
      limit: 50,
    });
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(directOrgEventId)).toBe(true);
  });

  it('finds events linked via entity_ids in the caller org', async () => {
    const result = await searchContentByText(null, {
      organization_id: callerOrg.id,
      limit: 50,
    });
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(entityBridgeEventId)).toBe(true);
  });

  it('finds events ingested through a connection in the caller org', async () => {
    const result = await searchContentByText(null, {
      organization_id: callerOrg.id,
      limit: 50,
    });
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(connectionBridgeEventId)).toBe(true);
  });

  it('does not leak events that belong entirely to another org', async () => {
    const result = await searchContentByText(null, {
      organization_id: callerOrg.id,
      limit: 50,
    });
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(foreignEventId)).toBe(false);
  });

  it('keeps cross-linked events (other org stamping, our entity) visible via the entity bridge', async () => {
    const result = await searchContentByText(null, {
      organization_id: callerOrg.id,
      limit: 50,
    });
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(crossLinkedFromOtherEventId)).toBe(true);
  });

  it('the other org sees only its own + cross-linked rows, not caller-only events', async () => {
    const result = await searchContentByText(null, {
      organization_id: otherOrg.id,
      limit: 50,
    });
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(foreignEventId)).toBe(true);
    expect(ids.has(crossLinkedFromOtherEventId)).toBe(true);
    expect(ids.has(directOrgEventId)).toBe(false);
    expect(ids.has(entityBridgeEventId)).toBe(false);
    expect(ids.has(connectionBridgeEventId)).toBe(false);
  });
});
