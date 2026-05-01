/**
 * Connector entity-link contract.
 *
 * Uses a minimal WhatsApp-shaped connector definition instead of importing the
 * real connector runtime, so the test is stable under raw CI runners while
 * preserving the important ingestion behavior: auto-create $member identities
 * and honor per-install overrides.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { applyEntityLinks, clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const connectorKey = 'whatsapp-contract';
const feedKey = 'messages';

async function seedConnector(options: { disableMemberRule?: boolean } = {}) {
  await cleanupTestDatabase();
  clearEntityLinkRulesCache();

  const org = await createTestOrganization({ name: 'Entity Link Contract Org' });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);

  await createTestConnectorDefinition({
    key: connectorKey,
    name: 'WhatsApp Contract',
    organization_id: org.id,
    entity_link_overrides: options.disableMemberRule ? { $member: { disable: true } } : null,
    feeds_schema: {
      [feedKey]: {
        eventKinds: {
          message: {
            entityLinks: [
              {
                entityType: '$member',
                autoCreate: true,
                titlePath: 'metadata.push_name',
                identities: [
                  { namespace: 'wa_jid', eventPath: 'metadata.sender_jid' },
                  { namespace: 'phone', eventPath: 'metadata.sender_phone' },
                ],
                traits: {
                  push_name: {
                    eventPath: 'metadata.push_name',
                    behavior: 'prefer_non_empty',
                  },
                },
              },
            ],
          },
        },
      },
    },
  });

  clearEntityLinkRulesCache();
  return { org };
}

describe('connector entity-link contract', () => {
  beforeEach(() => {
    clearEntityLinkRulesCache();
  });

  it('auto-creates a $member and persists declared identities', async () => {
    const { org } = await seedConnector();
    const sql = getTestDb();

    await applyEntityLinks({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            sender_jid: '14155551234@s.whatsapp.net',
            sender_phone: '14155551234',
            push_name: 'Alex',
          },
        },
      ],
    });

    const members = await sql<{ id: number; name: string; metadata: Record<string, unknown> }[]>`
      SELECT e.id, e.name, e.metadata
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id}
        AND et.slug = '$member'
        AND e.deleted_at IS NULL
    `;
    expect(members).toHaveLength(1);
    expect(members[0].name).toBe('Alex');
    expect(members[0].metadata.push_name).toBe('Alex');

    const identities = await sql<{ namespace: string; identifier: string }[]>`
      SELECT namespace, identifier
      FROM entity_identities
      WHERE entity_id = ${members[0].id}
      ORDER BY namespace
    `;
    expect(identities.map((r) => `${r.namespace}:${r.identifier}`)).toEqual([
      'phone:14155551234',
      'wa_jid:14155551234@s.whatsapp.net',
    ]);
  });

  it('honors connector entity-link overrides that disable a rule', async () => {
    const { org } = await seedConnector({ disableMemberRule: true });
    const sql = getTestDb();

    await applyEntityLinks({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [
        {
          origin_type: 'message',
          metadata: {
            sender_jid: '14155551234@s.whatsapp.net',
            sender_phone: '14155551234',
            push_name: 'Alex',
          },
        },
      ],
    });

    const count = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id}
        AND et.slug = '$member'
        AND e.deleted_at IS NULL
    `;
    expect(count[0].count).toBe('0');
  });
});
