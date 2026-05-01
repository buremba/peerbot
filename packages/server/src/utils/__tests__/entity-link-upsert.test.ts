import type { EntityLinkRule } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { applyEntityLinks, clearEntityLinkRulesCache } from '../entity-link-upsert';
import { ensureMemberEntityType } from '../member-entity-type';

const FEED_KEY = 'messages';

async function setupOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);
  clearEntityLinkRulesCache();
  return { org, user };
}

async function installRule(
  orgId: string,
  connectorKey: string,
  originType: string,
  rule: EntityLinkRule,
  overrides?: Record<string, unknown>
) {
  await createTestConnectorDefinition({
    key: connectorKey,
    name: connectorKey,
    organization_id: orgId,
    feeds_schema: {
      [FEED_KEY]: {
        eventKinds: {
          [originType]: { entityLinks: [rule] },
        },
      },
    },
    entity_link_overrides: overrides ?? null,
  });
  clearEntityLinkRulesCache();
}

describe('applyEntityLinks', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('creates an entity and writes identities when autoCreate is true and no match exists', async () => {
    const { org } = await setupOrg('autoCreate org');

    await installRule(org.id, 'whatsapp', 'message', {
      entityType: '$member',
      autoCreate: true,
      titlePath: 'metadata.push_name',
      identities: [
        { namespace: 'wa_jid', eventPath: 'metadata.sender_jid' },
        { namespace: 'phone', eventPath: 'metadata.sender_phone' },
      ],
      traits: {
        push_name: { eventPath: 'metadata.push_name', behavior: 'prefer_non_empty' },
      },
    });

    await applyEntityLinks({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            sender_jid: '14155551234@s.whatsapp.net',
            sender_phone: '+1 (415) 555-1234',
            push_name: 'Alex',
          },
        },
      ],
    });

    const sql = getTestDb();
    const entities = await sql`
      SELECT e.id, e.name, e.metadata FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
    `;
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe('Alex');
    expect((entities[0].metadata as { push_name?: string }).push_name).toBe('Alex');

    const idents = await sql<{ namespace: string; identifier: string }[]>`
      SELECT namespace, identifier FROM entity_identities
      WHERE organization_id = ${org.id} AND entity_id = ${entities[0].id}
      ORDER BY namespace
    `;
    expect(idents.map((r) => `${r.namespace}:${r.identifier}`)).toEqual([
      'phone:14155551234',
      'wa_jid:14155551234@s.whatsapp.net',
    ]);
  });

  it('reuses an existing entity and accretes a newly-seen identifier', async () => {
    const { org, user } = await setupOrg('reuse org');

    const sql = getTestDb();
    const [{ id: entityId }] = await sql<{ id: number | string }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      VALUES (
        ${org.id},
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        'Alex', 'member-seed', '{}'::jsonb, ${user.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${Number(entityId)}, 'phone', '14155551234', 'seed')
    `;

    await installRule(org.id, 'whatsapp', 'message', {
      entityType: '$member',
      autoCreate: true,
      identities: [
        { namespace: 'phone', eventPath: 'metadata.phone' },
        { namespace: 'wa_jid', eventPath: 'metadata.jid' },
      ],
    });

    await applyEntityLinks({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: { phone: '14155551234', jid: '14155551234@s.whatsapp.net' },
        },
      ],
    });

    const entityCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
    `;
    expect(entityCount[0].count).toBe('1');

    const idents = await sql<{ namespace: string }[]>`
      SELECT namespace FROM entity_identities
      WHERE organization_id = ${org.id} AND entity_id = ${Number(entityId)}
      ORDER BY namespace
    `;
    expect(idents.map((r) => r.namespace)).toEqual(['phone', 'wa_jid']);
  });

  it('skips linking when one event resolves to multiple distinct entities', async () => {
    const { org, user } = await setupOrg('ambiguous org');

    const sql = getTestDb();
    const entA = await sql<{ id: number | string }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      VALUES (
        ${org.id},
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        'A', 'member-a', '{}'::jsonb, ${user.id}
      )
      RETURNING id
    `;
    const entB = await sql<{ id: number | string }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      VALUES (
        ${org.id},
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        'B', 'member-b', '{}'::jsonb, ${user.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector) VALUES
        (${org.id}, ${Number(entA[0].id)}, 'phone', '14155551234', 'seed'),
        (${org.id}, ${Number(entB[0].id)}, 'email', 'alex@example.com', 'seed')
    `;

    await installRule(org.id, 'hypo', 'msg', {
      entityType: '$member',
      autoCreate: true,
      identities: [
        { namespace: 'phone', eventPath: 'metadata.phone' },
        { namespace: 'email', eventPath: 'metadata.email' },
      ],
    });

    await applyEntityLinks({
      connectorKey: 'hypo',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'msg',
          metadata: { phone: '14155551234', email: 'alex@example.com' },
        },
      ],
    });

    // No new entity created, no new identifiers accreted to either side.
    const entities = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
    `;
    expect(entities[0].count).toBe('2');

    const aIdents = await sql<{ namespace: string }[]>`
      SELECT namespace FROM entity_identities WHERE entity_id = ${Number(entA[0].id)}
    `;
    expect(aIdents.map((r) => r.namespace)).toEqual(['phone']);
  });

  it('applies per-install overrides end-to-end (loadEntityLinkRules wiring)', async () => {
    const { org } = await setupOrg('override org');

    await installRule(
      org.id,
      'whatsapp',
      'message',
      {
        entityType: '$member',
        autoCreate: true,
        identities: [
          { namespace: 'phone', eventPath: 'metadata.phone' },
          { namespace: 'wa_jid', eventPath: 'metadata.jid' },
        ],
      },
      { $member: { maskIdentities: ['phone'] } }
    );

    await applyEntityLinks({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: { phone: '14155551234', jid: '14155551234@s.whatsapp.net' },
        },
      ],
    });

    const sql = getTestDb();
    const idents = await sql<{ namespace: string }[]>`
      SELECT namespace FROM entity_identities WHERE organization_id = ${org.id}
    `;
    expect(idents.map((r) => r.namespace)).toEqual(['wa_jid']);
  });

  it('honors matchOnly: uses the identifier for lookup but does not persist it', async () => {
    const { org, user } = await setupOrg('matchOnly org');

    const sql = getTestDb();
    const [{ id: entityId }] = await sql<{ id: number | string }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      VALUES (
        ${org.id},
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        'Alex', 'member-alex', '{}'::jsonb, ${user.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${Number(entityId)}, 'email', 'alex@example.com', 'seed')
    `;

    await installRule(org.id, 'crm', 'contact_seen', {
      entityType: '$member',
      autoCreate: false,
      identities: [
        { namespace: 'email', eventPath: 'metadata.email', matchOnly: true },
        { namespace: 'crm_contact_id', eventPath: 'metadata.contact_id' },
      ],
    });

    await applyEntityLinks({
      connectorKey: 'crm',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'contact_seen',
          metadata: { email: 'alex@example.com', contact_id: 'crm_42' },
        },
      ],
    });

    const rows = await sql<{ namespace: string }[]>`
      SELECT namespace FROM entity_identities
      WHERE entity_id = ${Number(entityId)} ORDER BY namespace
    `;
    // email was matchOnly, so only crm_contact_id is newly persisted alongside the seed email.
    expect(rows.map((r) => r.namespace)).toEqual(['crm_contact_id', 'email']);
  });
});
