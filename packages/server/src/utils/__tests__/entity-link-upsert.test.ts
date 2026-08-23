import type { EntityIdentitySpec, EntityLinkPredicate, EntityTraitSpec, EventAttributionRule } from '@lobu/connector-sdk';
import GmailConnector from '@lobu/connectors/google_gmail';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
  resolveEventAttributionsForItems,
  resolveSenderIdentity,
} from '../entity-link-upsert';
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

type TestAttributionRule = {
  entityType: string;
  autoCreate?: boolean;
  createWhen?: EntityLinkPredicate;
  titlePath?: string;
  identities: EntityIdentitySpec[];
  traits?: Record<string, EntityTraitSpec>;
};

function toAttribution(rule: TestAttributionRule): EventAttributionRule {
  return {
    role: 'authored_by',
    autoCreate: rule.autoCreate,
    target: {
      entityType: rule.entityType,
      createWhen: rule.createWhen,
      titlePath: rule.titlePath,
      identities: rule.identities,
    },
    traits: rule.traits,
  };
}

async function installRule(
  orgId: string,
  connectorKey: string,
  originType: string,
  rule: TestAttributionRule
) {
  await createTestConnectorDefinition({
    key: connectorKey,
    name: connectorKey,
    organization_id: orgId,
    feeds_schema: {
      [FEED_KEY]: {
        eventKinds: {
          [originType]: { attributions: [toAttribution(rule)] },
        },
      },
    },
  });
  clearEntityLinkRulesCache();
}

async function installAttributionRule(
  orgId: string,
  connectorKey: string,
  originType: string,
  rule: EventAttributionRule
) {
  await createTestConnectorDefinition({
    key: connectorKey,
    name: connectorKey,
    organization_id: orgId,
    feeds_schema: {
      [FEED_KEY]: {
        eventKinds: {
          [originType]: { attributions: [rule] },
        },
      },
    },
  });
  clearEntityLinkRulesCache();
}

describe('applyEventAttributions', () => {
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
        push_name: { eventPath: 'metadata.push_name', mergeStrategy: 'prefer_non_empty' },
      },
    });

    await applyEventAttributions({
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

  it('consumes event attributions directly', async () => {
    const { org } = await setupOrg('attribution org');

    await installAttributionRule(org.id, 'x', 'tweet', {
      role: 'authored_by',
      autoCreate: true,
      target: {
        entityType: '$member',
        titlePath: 'metadata.author_name',
        identities: [{ namespace: 'x_user_id', eventPath: 'metadata.author_id' }],
      },
      traits: {
        x_handle: { eventPath: 'metadata.author_handle', mergeStrategy: 'prefer_non_empty' },
      },
    });

    await applyEventAttributions({
      connectorKey: 'x',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'tweet',
          metadata: { author_id: '00123', author_name: 'Alice', author_handle: 'alice' },
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
    expect(entities[0].name).toBe('Alice');
    expect((entities[0].metadata as { x_handle?: string }).x_handle).toBe('alice');

    const idents = await sql<{ namespace: string; identifier: string }[]>`
      SELECT namespace, identifier FROM entity_identities
      WHERE organization_id = ${org.id} AND entity_id = ${entities[0].id}
    `;
    expect(idents).toEqual([{ namespace: 'x_user_id', identifier: '123' }]);
  });

  it('materializes an idempotent relationship between named event attributions', async () => {
    const { org } = await setupOrg('named relationship org');
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
    `;
    await sql`
      INSERT INTO entity_relationship_types
        (organization_id, slug, name, description, is_symmetric, status, created_at, updated_at)
      VALUES
        (${org.id}, 'engaged_with', 'Engaged With', 'Explicit social engagement', false, 'active', current_timestamp, current_timestamp)
    `;
    await createTestConnectorDefinition({
      key: 'x-likes',
      name: 'X Likes',
      organization_id: org.id,
      feeds_schema: {
        [FEED_KEY]: {
          eventKinds: {
            liked_tweet: {
              attributions: [
                {
                  name: 'author',
                  role: 'authored_by',
                  autoCreate: true,
                  target: {
                    entityType: 'person',
                    titlePath: 'metadata.author_name',
                    identities: [
                      {
                        namespace: 'x_user_id',
                        eventPath: 'metadata.author_id',
                        primary: true,
                      },
                      {
                        namespace: 'x_handle',
                        eventPath: 'metadata.author_handle',
                      },
                    ],
                  },
                },
                {
                  name: 'liker',
                  role: 'performed_by',
                  autoCreate: true,
                  target: {
                    entityType: 'person',
                    titlePath: 'metadata.liked_by_name',
                    identities: [
                      {
                        namespace: 'x_user_id',
                        eventPath: 'metadata.liked_by_id',
                        primary: true,
                      },
                      {
                        namespace: 'x_handle',
                        eventPath: 'metadata.liked_by_handle',
                      },
                    ],
                  },
                },
              ],
              relationships: [{ type: 'engaged_with', from: 'liker', to: 'author' }],
            },
          },
        },
      },
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'x-likes',
      createDefaultFeed: false,
    });
    clearEntityLinkRulesCache();
    const item: { origin_type: string; metadata: Record<string, unknown> } = {
      origin_type: 'liked_tweet',
      metadata: {
        liked_by_id: '369272762',
        liked_by_handle: 'bu7emba',
        liked_by_name: 'burak emre',
        author_id: '123',
        author_handle: 'alice',
        author_name: 'Alice',
      },
    };

    await applyEventAttributions({
      connectorKey: 'x-likes',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [item],
    });
    await applyEventAttributions({
      connectorKey: 'x-likes',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [item],
    });

    const edges = await sql<{
      from_name: string;
      to_name: string;
      relationship_type: string;
      source: string;
      metadata: Record<string, unknown>;
    }>`
      SELECT source_entity.name AS from_name,
             target_entity.name AS to_name,
             relationship_type.slug AS relationship_type,
             relationship.source,
             relationship.metadata
      FROM entity_relationships relationship
      JOIN entity_relationship_types relationship_type
        ON relationship_type.id = relationship.relationship_type_id
      JOIN entities source_entity ON source_entity.id = relationship.from_entity_id
      JOIN entities target_entity ON target_entity.id = relationship.to_entity_id
      WHERE relationship.organization_id = ${org.id}
        AND relationship.deleted_at IS NULL
    `;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from_name: 'burak emre',
      to_name: 'Alice',
      relationship_type: 'engaged_with',
      source: 'feed',
      metadata: {
        connector_key: 'x-likes',
        connection_id: connection.id,
        feed_key: FEED_KEY,
      },
    });
    expect(item.metadata.x_handle).toBe('alice');
  });

  it('first-writer-wins when two rules stamp the same namespace on one event', async () => {
    // An X DM carries two person attributions that both resolve `x_user_id`:
    // the `authored_by` sender and the `about` counterparty. The event metadata
    // has ONE `x_user_id` slot and read-time recall JOINs on it, so the earliest
    // rule (the author, declared first) keeps the slot; a later rule must not
    // overwrite it. Both people are still created/linked via entity_identities —
    // only the single flat recall slot is contended. (Role-aware recall that would
    // let the counterparty recall too is a separate, deliberate follow-up.)
    const { org } = await setupOrg('slot collision org');
    const sql = getTestDb();

    await createTestConnectorDefinition({
      key: 'x-dm',
      name: 'x-dm',
      organization_id: org.id,
      feeds_schema: {
        [FEED_KEY]: {
          eventKinds: {
            dm: {
              attributions: [
                {
                  role: 'authored_by',
                  autoCreate: true,
                  target: {
                    entityType: '$member',
                    titlePath: 'metadata.sender_name',
                    identities: [{ namespace: 'x_user_id', eventPath: 'metadata.sender_id' }],
                  },
                },
                {
                  role: 'about',
                  autoCreate: true,
                  target: {
                    entityType: '$member',
                    titlePath: 'metadata.participant_name',
                    identities: [{ namespace: 'x_user_id', eventPath: 'metadata.participant_id' }],
                  },
                },
              ],
            },
          },
        },
      },
    });
    clearEntityLinkRulesCache();

    const item: { origin_type: string; metadata: Record<string, unknown> } = {
      origin_type: 'dm',
      metadata: { sender_id: '111', sender_name: 'Sender', participant_id: '222', participant_name: 'Counterparty' },
    };
    await applyEventAttributions({ connectorKey: 'x-dm', feedKey: FEED_KEY, orgId: org.id, items: [item] });

    // Both people are still created/linked (entity_identities is unaffected)...
    const idents = await sql<{ identifier: string }[]>`
      SELECT identifier FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'x_user_id'
      ORDER BY identifier
    `;
    expect(idents.map((r) => r.identifier)).toEqual(['111', '222']);

    // ...but the single metadata slot keeps the FIRST (author) id.
    expect(item.metadata.x_user_id).toBe('111');
  });

  it('a later rule resolves an entity an earlier rule minted in the same batch', async () => {
    // Match maps are resolved for every rule up front (so the prelock can order
    // them), which means a later rule can no longer re-read an intra-batch
    // create from the DB. It must see the mint through the shared claim instead
    // — otherwise a non-autoCreate rule silently drops the edge and its traits.
    const { org } = await setupOrg('cross rule mint org');
    const sql = getTestDb();

    await createTestConnectorDefinition({
      key: 'self-dm',
      name: 'self-dm',
      organization_id: org.id,
      feeds_schema: {
        [FEED_KEY]: {
          eventKinds: {
            dm: {
              attributions: [
                {
                  role: 'authored_by',
                  autoCreate: true,
                  target: {
                    entityType: '$member',
                    identities: [{ namespace: 'phone', eventPath: 'metadata.sender_phone' }],
                  },
                },
                {
                  role: 'about',
                  autoCreate: false,
                  target: {
                    entityType: '$member',
                    identities: [{ namespace: 'phone', eventPath: 'metadata.subject_phone' }],
                  },
                  traits: {
                    nickname: { eventPath: 'metadata.nickname', mergeStrategy: 'overwrite' },
                  },
                },
              ],
            },
          },
        },
      },
    });
    clearEntityLinkRulesCache();

    // Both rules resolve the SAME phone: the author rule mints the entity, the
    // counterparty rule must land its trait on that same row.
    await applyEventAttributions({
      connectorKey: 'self-dm',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'dm',
          metadata: {
            sender_phone: '14155559111',
            subject_phone: '14155559111',
            nickname: 'Robin',
          },
        },
      ],
    });

    const rows = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT e.metadata
      FROM entities e
      JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.organization_id = ${org.id} AND ei.identifier = '14155559111'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.nickname).toBe('Robin');
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
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'whatsapp',
      display_name: 'WhatsApp',
      created_by: user.id,
      createDefaultFeed: false,
    });

    await applyEventAttributions({
      connectorKey: 'whatsapp',
      connectionId: connection.id,
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

    const idents = await sql<{ namespace: string; connection_id: number | string | null }[]>`
      SELECT namespace, connection_id FROM entity_identities
      WHERE organization_id = ${org.id} AND entity_id = ${Number(entityId)}
      ORDER BY namespace
    `;
    expect(idents.map((r) => r.namespace)).toEqual(['phone', 'wa_jid']);
    expect(idents.map((r) => Number(r.connection_id))).toEqual([
      connection.id,
      connection.id,
    ]);
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

    await applyEventAttributions({
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

    await applyEventAttributions({
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

  it('two concurrent auto-creates for the same new actor → one entity, no orphan', async () => {
    const { org } = await setupOrg('concurrent autocreate org');
    const sql = getTestDb();

    const rule: TestAttributionRule = {
      entityType: '$member',
      autoCreate: true,
      titlePath: 'metadata.push_name',
      identities: [{ namespace: 'phone', eventPath: 'metadata.phone' }],
      traits: {
        push_name: { eventPath: 'metadata.push_name', mergeStrategy: 'prefer_non_empty' },
      },
    };
    const item = {
      origin_type: 'msg',
      metadata: { phone: '14155559999', push_name: 'Casey' },
    };

    // Both calls race to auto-create the SAME brand-new actor. One wins the
    // identity insert; the loser's freshly-inserted entity row gets zero
    // identities (ON CONFLICT) and must be discarded (no orphan), not used.
    await Promise.all([
      resolveEventAttributionsForItems({
        connectorKey: 'whatsapp',
        orgId: org.id,
        items: [{ ...item, metadata: { ...item.metadata } }],
        rules: { msg: [rule] },
      }),
      resolveEventAttributionsForItems({
        connectorKey: 'whatsapp',
        orgId: org.id,
        items: [{ ...item, metadata: { ...item.metadata } }],
        rules: { msg: [rule] },
      }),
    ]);

    // Exactly one entity OWNS the identity. (A lost-race orphan would be an extra
    // $member row with no entity_identities — assert there is none.)
    const withIdentity = await sql<{ id: number }[]>`
      SELECT e.id FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      JOIN entity_identities ei ON ei.entity_id = e.id AND ei.deleted_at IS NULL
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
        AND ei.namespace = 'phone' AND ei.identifier = '14155559999'
    `;
    expect(withIdentity).toHaveLength(1);

    const orphans = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM entity_identities ei WHERE ei.entity_id = e.id AND ei.deleted_at IS NULL
        )
    `;
    expect(orphans[0].count).toBe('0');

    // Traits landed on the real (identity-owning) entity.
    const winner = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM entities WHERE id = ${withIdentity[0].id}
    `;
    expect(winner[0].metadata.push_name).toBe('Casey');
  });

  it('locks existing entities in one order across reversed concurrent batches', async () => {
    const { org, user } = await setupOrg('concurrent existing batch org');
    const sql = getTestDb();
    const [type] = await sql<{ id: number }[]>`
      SELECT id FROM entity_types
      WHERE organization_id = ${org.id} AND slug = '$member' AND deleted_at IS NULL
    `;
    const entities = await sql<{ id: number; name: string }[]>`
      INSERT INTO entities (
        organization_id, entity_type_id, name, slug, metadata, created_by
      ) VALUES
        (${org.id}, ${type.id}, 'First', 'deadlock-first', '{"deadlock_probe":true}'::jsonb, ${user.id}),
        (${org.id}, ${type.id}, 'Second', 'deadlock-second', '{"deadlock_probe":true}'::jsonb, ${user.id})
      RETURNING id, name
    `;
    const byName = new Map(entities.map((entity) => [entity.name, Number(entity.id)]));
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      ) VALUES
        (${org.id}, ${byName.get('First')!}, 'phone', '14155553001', 'test'),
        (${org.id}, ${byName.get('Second')!}, 'phone', '14155553002', 'test')
    `;

    // Hold the first updated row briefly. Without the resolver's ascending-id
    // prelock, the reversed batches each hold one row and then wait for the
    // other, producing a real PostgreSQL deadlock.
    //
    // Created idempotently: a run killed before the `finally` below would
    // otherwise leave the function behind and make every later run red.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION entity_link_deadlock_probe_sleep() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.metadata->>'deadlock_probe' = 'true' THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await sql.unsafe('DROP TRIGGER IF EXISTS entity_link_deadlock_probe ON entities');
    await sql.unsafe(`
      CREATE TRIGGER entity_link_deadlock_probe
      BEFORE UPDATE ON entities
      FOR EACH ROW EXECUTE FUNCTION entity_link_deadlock_probe_sleep()
    `);

    const rule: TestAttributionRule = {
      entityType: '$member',
      identities: [{ namespace: 'phone', eventPath: 'metadata.phone' }],
    };
    const first = { origin_type: 'msg', metadata: { phone: '14155553001' } };
    const second = { origin_type: 'msg', metadata: { phone: '14155553002' } };
    try {
      await Promise.all([
        resolveEventAttributionsForItems({
          connectorKey: 'whatsapp',
          orgId: org.id,
          items: [first, second],
          rules: { msg: [rule] },
        }),
        resolveEventAttributionsForItems({
          connectorKey: 'whatsapp',
          orgId: org.id,
          items: [second, first],
          rules: { msg: [rule] },
        }),
      ]);
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS entity_link_deadlock_probe ON entities');
      await sql.unsafe('DROP FUNCTION IF EXISTS entity_link_deadlock_probe_sleep()');
    }

    const rows = await sql<{ metadata: { aliases?: string[] } }[]>`
      SELECT metadata FROM entities
      WHERE id = ANY(${`{${entities.map((entity) => entity.id).join(',')}}`}::bigint[])
      ORDER BY id
    `;
    expect(rows.map((row) => row.metadata.aliases)).toEqual([
      ['14155553001'],
      ['14155553002'],
    ]);
  });

  it('createWhen gates auto-create: group message mints nothing, 1:1 mints a contact', async () => {
    const { org } = await setupOrg('createWhen gate org');
    const sql = getTestDb();

    await installRule(org.id, 'whatsapp', 'message', {
      entityType: '$member',
      autoCreate: true,
      createWhen: { path: 'metadata.is_group', equals: false },
      titlePath: 'metadata.push_name',
      identities: [{ namespace: 'wa_jid', eventPath: 'metadata.sender_jid' }],
    });

    await applyEventAttributions({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        // group sender → gated out, no entity
        {
          origin_type: 'message',
          metadata: { sender_jid: '99@lid', is_group: true, push_name: 'Group Member' },
        },
        // 1:1 partner → minted
        {
          origin_type: 'message',
          metadata: { sender_jid: '14155551234@s.whatsapp.net', is_group: false, push_name: 'Rob' },
        },
      ],
    });

    const rows = await sql<{ name: string }[]>`
      SELECT e.name FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
    `;
    expect(rows.map((r) => r.name)).toEqual(['Rob']);

    // The gated-out group sender's identifier is NOT claimed by any entity.
    const groupIdent = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'wa_jid' AND identifier = '99@lid'
    `;
    expect(groupIdent[0].count).toBe('0');
  });

  it('createWhen gates only CREATE: a group message still accretes onto an existing contact', async () => {
    const { org, user } = await setupOrg('createWhen match org');
    const sql = getTestDb();

    const [{ id: entityId }] = await sql<{ id: number | string }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      VALUES (
        ${org.id},
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        'Rob', 'member-rob', '{"aliases":["14155551234@s.whatsapp.net"]}'::jsonb, ${user.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${Number(entityId)}, 'wa_jid', '14155551234@s.whatsapp.net', 'seed')
    `;

    await installRule(org.id, 'whatsapp', 'message', {
      entityType: '$member',
      autoCreate: true,
      createWhen: { path: 'metadata.is_group', equals: false },
      identities: [
        { namespace: 'wa_jid', eventPath: 'metadata.sender_jid' },
        { namespace: 'phone', eventPath: 'metadata.sender_phone' },
      ],
    });

    // A GROUP message from the known contact, carrying a new phone identifier.
    await applyEventAttributions({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            sender_jid: '14155551234@s.whatsapp.net',
            sender_phone: '14155551234',
            is_group: true,
          },
        },
      ],
    });

    // Matched the existing entity (gate doesn't block match) and accreted phone.
    const idents = await sql<{ namespace: string }[]>`
      SELECT namespace FROM entity_identities
      WHERE organization_id = ${org.id} AND entity_id = ${Number(entityId)} ORDER BY namespace
    `;
    expect(idents.map((r) => r.namespace)).toEqual(['phone', 'wa_jid']);
    // No SECOND entity was created from the group message.
    const count = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
    `;
    expect(count[0].count).toBe('1');
  });

  it('seeds metadata.aliases from identifiers on create (metric resolution path)', async () => {
    const { org } = await setupOrg('aliases-on-create org');
    const sql = getTestDb();

    await installRule(org.id, 'whatsapp', 'message', {
      entityType: '$member',
      autoCreate: true,
      identities: [
        { namespace: 'wa_jid', eventPath: 'metadata.sender_jid' },
        { namespace: 'phone', eventPath: 'metadata.sender_phone' },
      ],
    });

    await applyEventAttributions({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: { sender_jid: '14155551234@s.whatsapp.net', sender_phone: '+1 (415) 555-1234' },
        },
      ],
    });

    const rows = await sql<{ metadata: { aliases?: string[] } }[]>`
      SELECT e.metadata FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect([...(rows[0].metadata.aliases ?? [])].sort()).toEqual([
      '14155551234',
      '14155551234@s.whatsapp.net',
    ]);
  });

  it('appends a cross-channel identifier to metadata.aliases on accrete', async () => {
    const { org, user } = await setupOrg('aliases-accrete org');
    const sql = getTestDb();

    const [{ id: entityId }] = await sql<{ id: number | string }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      VALUES (
        ${org.id},
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        'Rob', 'member-rob2', '{"aliases":["14155551234@s.whatsapp.net"]}'::jsonb, ${user.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${Number(entityId)}, 'wa_jid', '14155551234@s.whatsapp.net', 'seed')
    `;

    await installRule(org.id, 'whatsapp', 'message', {
      entityType: '$member',
      autoCreate: true,
      identities: [
        { namespace: 'wa_jid', eventPath: 'metadata.sender_jid' },
        { namespace: 'phone', eventPath: 'metadata.sender_phone' },
      ],
    });

    await applyEventAttributions({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: { sender_jid: '14155551234@s.whatsapp.net', sender_phone: '14155551234' },
        },
      ],
    });

    const rows = await sql<{ metadata: { aliases?: string[] } }[]>`
      SELECT metadata FROM entities WHERE id = ${Number(entityId)}
    `;
    expect([...(rows[0].metadata.aliases ?? [])].sort()).toEqual([
      '14155551234',
      '14155551234@s.whatsapp.net',
    ]);
  });

  it('backfills metadata.aliases on a normal match for a legacy entity that has none', async () => {
    const { org, user } = await setupOrg('aliases-backfill org');
    const sql = getTestDb();

    // Legacy entity: has the identity row but NO aliases key in metadata (created
    // by the pre-aliases path). A plain matching message must repair it.
    const [{ id: entityId }] = await sql<{ id: number | string }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      VALUES (
        ${org.id},
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        'Rob', 'member-legacy', '{"push_name":"Rob"}'::jsonb, ${user.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${Number(entityId)}, 'wa_jid', '14155551234@s.whatsapp.net', 'seed')
    `;

    await installRule(org.id, 'whatsapp', 'message', {
      entityType: '$member',
      autoCreate: true,
      createWhen: { path: 'metadata.is_group', equals: false },
      identities: [
        { namespace: 'wa_jid', eventPath: 'metadata.sender_jid' },
        { namespace: 'phone', eventPath: 'metadata.sender_phone' },
      ],
    });

    await applyEventAttributions({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            sender_jid: '14155551234@s.whatsapp.net',
            sender_phone: '14155551234',
            is_group: false,
          },
        },
      ],
    });

    const rows = await sql<{ metadata: { aliases?: string[] } }[]>`
      SELECT metadata FROM entities WHERE id = ${Number(entityId)}
    `;
    // The matched-on wa_jid AND the newly-accreted phone are both repaired in.
    expect([...(rows[0].metadata.aliases ?? [])].sort()).toEqual([
      '14155551234',
      '14155551234@s.whatsapp.net',
    ]);
  });

  it('resolveEventAttributionsForItems writes through the passed transaction handle', async () => {
    const { org } = await setupOrg('tx-threaded org');
    const sql = getTestDb();

    const rule: TestAttributionRule = {
      entityType: '$member',
      autoCreate: true,
      identities: [{ namespace: 'phone', eventPath: 'metadata.phone' }],
    };

    // Run resolution inside a tx we then ROLL BACK — if the resolver wrote
    // through the passed handle, the entity must NOT survive the rollback.
    await sql
      .begin(async (tx) => {
        await resolveEventAttributionsForItems(
          {
            connectorKey: 'whatsapp',
            orgId: org.id,
            items: [{ origin_type: 'msg', metadata: { phone: '14155551111' } }],
            rules: { msg: [rule] },
          },
          tx as unknown as ReturnType<typeof getTestDb>,
        );
        throw new Error('rollback');
      })
      .catch((e) => {
        if (e.message !== 'rollback') throw e;
      });

    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'phone' AND identifier = '14155551111'
    `;
    expect(rows[0].count).toBe('0');
  });

  it('opens a transaction for a passed pool so a late identity failure rolls back the entity', async () => {
    const { org } = await setupOrg('pool transaction org');
    const sql = getTestDb();

    const rule: TestAttributionRule = {
      entityType: '$member',
      autoCreate: true,
      identities: [{ namespace: 'phone', eventPath: 'metadata.phone' }],
    };
    // No such connections row, so the identity insert trips the
    // entity_identities → connections FK — a failure that lands AFTER the
    // entity row was inserted. Passing the pool (not a tx) is the point: the
    // resolver has to open its own transaction for the entity to roll back.
    const missingConnectionId = 2_147_483_647;

    await expect(
      resolveEventAttributionsForItems(
        {
          connectorKey: 'whatsapp',
          connectionId: missingConnectionId,
          orgId: org.id,
          items: [{ origin_type: 'msg', metadata: { phone: '14155552222' } }],
          rules: { msg: [rule] },
        },
        sql
      )
    ).rejects.toThrow();

    const rows = await sql<{ entityCount: string; identityCount: string }[]>`
      SELECT
        (SELECT COUNT(*)::text FROM entities
         WHERE organization_id = ${org.id} AND name = '14155552222') AS "entityCount",
        (SELECT COUNT(*)::text FROM entity_identities
         WHERE organization_id = ${org.id}
           AND namespace = 'phone'
           AND identifier = '14155552222') AS "identityCount"
    `;
    expect(rows[0]).toEqual({ entityCount: '0', identityCount: '0' });
  });

  it('returns an existing sender identity without opening a transaction', async () => {
    const { org, user } = await setupOrg('sender fast path org');
    const sql = getTestDb();
    const [type] = await sql<{ id: number }[]>`
      SELECT id FROM entity_types
      WHERE organization_id = ${org.id} AND slug = '$member' AND deleted_at IS NULL
    `;
    const [entity] = await sql<{ id: number }[]>`
      INSERT INTO entities (
        organization_id, entity_type_id, name, slug, metadata, created_by
      ) VALUES (
        ${org.id}, ${type.id}, 'Known sender', 'known-sender', '{}'::jsonb, ${user.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      ) VALUES (${org.id}, ${entity.id}, 'phone', '14155554444', 'test')
    `;

    let beginCalls = 0;
    const observedSql = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === 'begin') {
          return (...args: Parameters<typeof sql.begin>) => {
            beginCalls += 1;
            return sql.begin(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const resolved = await resolveSenderIdentity(observedSql, {
      orgId: org.id,
      connectorKey: 'whatsapp',
      mintEntityType: '$member',
      identities: [{ namespace: 'phone', identifier: '14155554444' }],
    });
    expect(resolved).toBe(Number(entity.id));
    expect(beginCalls).toBe(0);
  });
});

/**
 * End-to-end promote-on-interaction (#1626) against the REAL Gmail connector
 * rule — not a hand-built test rule — so a regression in the connector's
 * declared gate (e.g. flipping autoCreate back on ungated) fails here, at the
 * pipeline level where the raw-sender person flood would actually re-appear.
 * The gate is `metadata.person_relevant` (replied in default mode; stricter
 * counterparty selection under human_senders_only).
 */
describe('gmail promote-on-interaction (real connector rule)', () => {
  const GMAIL_KEY = 'google.gmail';
  const GMAIL_FEED = 'threads';

  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  async function setupGmailOrg() {
    const { org, user } = await setupOrg('gmail promote org');
    const sql = getTestDb();
    // The gmail rule targets `person`; fresh test orgs only have `$member`.
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
    `;
    await createTestConnectorDefinition({
      key: GMAIL_KEY,
      name: 'Gmail',
      organization_id: org.id,
      feeds_schema: new GmailConnector().definition.feeds as Record<string, unknown>,
    });
    clearEntityLinkRulesCache();
    return { org, user, sql };
  }

  const thread = (metadata: Record<string, unknown>) => ({
    origin_type: 'thread',
    metadata,
  });

  async function personRows(sql: ReturnType<typeof getTestDb>, orgId: string) {
    return sql<{ name: string; metadata: { aliases?: string[] } }[]>`
      SELECT e.name, e.metadata FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${orgId} AND et.slug = 'person' AND e.deleted_at IS NULL
      ORDER BY e.name
    `;
  }

  it('promotes only person-relevant counterparties: no raw-sender rows, bidirectional contact minted with metric aliases', async () => {
    const { org, sql } = await setupGmailOrg();

    await applyEventAttributions({
      connectorKey: GMAIL_KEY,
      feedKey: GMAIL_FEED,
      orgId: org.id,
      items: [
        // Inbound-only brand blast — has a from_name, still must NOT mint.
        thread({
          from_email: 'promo@brand.example',
          from_name: 'Brand',
          replied: false,
          person_relevant: false,
        }),
        // Genuine bidirectional exchange — promotes.
        thread({
          from_email: 'alice@example.com',
          from_name: 'Alice',
          replied: true,
          person_relevant: true,
        }),
      ],
    });

    const people = await personRows(sql, org.id);
    expect(people.map((p) => p.name)).toEqual(['Alice']);
    // The promoted contact keeps participating in metrics: its email identifier
    // is seeded into metadata.aliases (the metric compiler's resolution surface).
    expect(people[0].metadata.aliases).toEqual(['alice@example.com']);

    // The brand's identifier is not claimed by any entity.
    const brandIdent = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'email' AND identifier = 'promo@brand.example'
    `;
    expect(brandIdent[0].count).toBe('0');
  });

  it('promotion is idempotent: re-syncing the same replied thread never duplicates the contact', async () => {
    const { org, sql } = await setupGmailOrg();
    const items = [
      thread({
        from_email: 'alice@example.com',
        from_name: 'Alice',
        replied: true,
        person_relevant: true,
      }),
    ];

    await applyEventAttributions({ connectorKey: GMAIL_KEY, feedKey: GMAIL_FEED, orgId: org.id, items });
    await applyEventAttributions({ connectorKey: GMAIL_KEY, feedKey: GMAIL_FEED, orgId: org.id, items });

    const people = await personRows(sql, org.id);
    expect(people.map((p) => p.name)).toEqual(['Alice']);
  });

  it('an inbound-only thread from an already-promoted contact still links to it (match is never gated)', async () => {
    const { org, sql } = await setupGmailOrg();

    // Promote Alice via a replied thread, then receive an inbound-only one.
    await applyEventAttributions({
      connectorKey: GMAIL_KEY,
      feedKey: GMAIL_FEED,
      orgId: org.id,
      items: [
        thread({
          from_email: 'alice@example.com',
          from_name: 'Alice',
          replied: true,
          person_relevant: true,
        }),
      ],
    });
    const later = thread({
      from_email: 'alice@example.com',
      from_name: 'Alice',
      replied: false,
      person_relevant: false,
    });
    await applyEventAttributions({
      connectorKey: GMAIL_KEY,
      feedKey: GMAIL_FEED,
      orgId: org.id,
      items: [later],
    });

    // Still exactly one person, and the inbound event was stamped with the
    // matched identity slot (the read-time JOIN key).
    const people = await personRows(sql, org.id);
    expect(people.map((p) => p.name)).toEqual(['Alice']);
    expect((later.metadata as Record<string, unknown>).email).toBe('alice@example.com');
  });

  it('a legacy v1.0.3 {replied:true} payload still mints a person under the new definition', async () => {
    const { org, sql } = await setupGmailOrg();

    // Pre-refresh run payloads carry `replied` but not `person_relevant`. The
    // server loads the current definition by connector key, so the legacy rule
    // must keep minting during a rolling deploy — otherwise in-flight old runs
    // silently skip person creation.
    await applyEventAttributions({
      connectorKey: GMAIL_KEY,
      feedKey: GMAIL_FEED,
      orgId: org.id,
      items: [
        thread({
          from_email: 'alice@example.com',
          from_name: 'Alice',
          replied: true,
        }),
      ],
    });

    const people = await personRows(sql, org.id);
    expect(people.map((p) => p.name)).toEqual(['Alice']);
  });
});
