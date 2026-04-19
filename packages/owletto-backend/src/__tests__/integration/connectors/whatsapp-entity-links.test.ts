/**
 * WhatsApp connector end-to-end check for the entityLinks rule.
 *
 * Bypasses Baileys (which needs a real phone) — instead we compile the
 * connector file, install it with its real feeds_schema, then feed
 * WhatsApp-shaped synthetic EventEnvelopes through the same
 * `applyEntityLinks` hook the ingestion pipeline uses.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  compileConnectorSource,
  extractConnectorMetadata,
} from '../../../utils/connector-compiler';
import { applyEntityLinks, clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const FEED_KEY = 'messages';

async function setup() {
  await cleanupTestDatabase();
  const org = await createTestOrganization({ name: 'WhatsApp Links Test Org' });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);

  const src = await readFile(path.join(process.cwd(), 'connectors', 'whatsapp.ts'), 'utf-8');
  const { compiledCode } = await compileConnectorSource(src);
  const metadata = await extractConnectorMetadata(compiledCode);

  await createTestConnectorDefinition({
    key: metadata.key,
    name: metadata.name,
    version: metadata.version,
    organization_id: org.id,
    feeds_schema: metadata.feeds as Record<string, unknown>,
  });
  clearEntityLinkRulesCache();

  return { org, metadata };
}

describe('whatsapp connector > entityLinks', () => {
  beforeEach(async () => {
    clearEntityLinkRulesCache();
  });

  it('creates a $member from an incoming message and accretes new identities on subsequent messages', async () => {
    const { org } = await setup();
    const sql = getTestDb();

    // First message: individual chat, someone else sends a hello.
    await applyEntityLinks({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            chat_jid: '14155551234@s.whatsapp.net',
            is_group: false,
            from_me: false,
            sender_jid: '14155551234@s.whatsapp.net',
            sender_phone: '14155551234',
            push_name: 'Alex',
          },
        },
      ],
    });

    const entitiesAfterFirst = await sql<
      { id: number; name: string; metadata: Record<string, unknown> }[]
    >`
      SELECT id, name, metadata FROM entities
      WHERE organization_id = ${org.id} AND entity_type = '$member' AND deleted_at IS NULL
    `;
    expect(entitiesAfterFirst).toHaveLength(1);
    expect(entitiesAfterFirst[0].name).toBe('Alex');
    expect(entitiesAfterFirst[0].metadata.push_name).toBe('Alex');

    const memberId = Number(entitiesAfterFirst[0].id);
    const identsAfterFirst = await sql<{ namespace: string; identifier: string }[]>`
      SELECT namespace, identifier FROM entity_identities
      WHERE entity_id = ${memberId} ORDER BY namespace
    `;
    expect(identsAfterFirst.map((r) => `${r.namespace}:${r.identifier}`)).toEqual([
      'phone:14155551234',
      'wa_jid:14155551234@s.whatsapp.net',
    ]);

    // Second message from the same person via a group — same sender identified
    // by wa_jid, should reuse the entity (no new one created).
    await applyEntityLinks({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            chat_jid: '120363000000000000@g.us',
            is_group: true,
            from_me: false,
            participant: '14155551234@s.whatsapp.net',
            sender_jid: '14155551234@s.whatsapp.net',
            sender_phone: '14155551234',
            push_name: 'Alex',
          },
        },
      ],
    });

    const countAfterSecond = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entities
      WHERE organization_id = ${org.id} AND entity_type = '$member' AND deleted_at IS NULL
    `;
    expect(countAfterSecond[0].count).toBe('1');
  });

  it('skips entity creation for from_me messages (no sender_jid in metadata)', async () => {
    const { org } = await setup();
    const sql = getTestDb();

    await applyEntityLinks({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            chat_jid: '14155551234@s.whatsapp.net',
            is_group: false,
            from_me: true,
            // No sender_jid / sender_phone / push_name — the connector
            // intentionally omits these for outgoing messages.
          },
        },
      ],
    });

    const count = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entities
      WHERE organization_id = ${org.id} AND entity_type = '$member' AND deleted_at IS NULL
    `;
    expect(count[0].count).toBe('0');
  });

  it('respects a per-install override that disables the $member rule', async () => {
    const { org } = await setup();
    const sql = getTestDb();

    await sql`
      UPDATE connector_definitions
      SET entity_link_overrides = ${sql.json({ $member: { disable: true } })}
      WHERE key = 'whatsapp' AND organization_id = ${org.id}
    `;
    clearEntityLinkRulesCache();

    await applyEntityLinks({
      connectorKey: 'whatsapp',
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            chat_jid: '14155551234@s.whatsapp.net',
            from_me: false,
            sender_jid: '14155551234@s.whatsapp.net',
            sender_phone: '14155551234',
            push_name: 'Alex',
          },
        },
      ],
    });

    const count = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entities
      WHERE organization_id = ${org.id} AND entity_type = '$member' AND deleted_at IS NULL
    `;
    expect(count[0].count).toBe('0');
  });
});
