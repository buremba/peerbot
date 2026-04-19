import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageConnections } from '../../../tools/admin/manage_connections';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('manage_connections > set_connector_entity_link_overrides', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;
  const env = {} as Env;

  beforeAll(async () => {
    await cleanupTestDatabase();

    org = await createTestOrganization({ name: 'Entity Link Overrides Org' });
    user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    ctx = {
      organizationId: org.id,
      userId: user.id,
      accessLevel: 'admin',
    } as unknown as ToolContext;

    await createTestConnectorDefinition({
      key: 'whatsapp',
      name: 'WhatsApp',
      version: '1.0.0',
      organization_id: org.id,
      feeds_schema: {
        messages: {
          eventKinds: {
            message: {
              entityLinks: [
                {
                  entityType: '$member',
                  autoCreate: true,
                  identities: [
                    { namespace: 'wa_jid', eventPath: 'metadata.sender_jid' },
                    { namespace: 'phone', eventPath: 'metadata.sender_phone' },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });

  it('writes overrides to the connector definition and reads them back', async () => {
    const result = (await manageConnections(
      {
        action: 'set_connector_entity_link_overrides',
        connector_key: 'whatsapp',
        overrides: { $member: { autoCreate: false, maskIdentities: ['phone'] } },
      },
      env,
      ctx
    )) as {
      action: string;
      success: boolean;
      overrides: unknown;
    };

    expect(result.action).toBe('set_connector_entity_link_overrides');
    expect(result.success).toBe(true);
    expect(result.overrides).toEqual({
      $member: { autoCreate: false, maskIdentities: ['phone'] },
    });

    const sql = getTestDb();
    const rows = await sql<{ entity_link_overrides: Record<string, unknown> | null }[]>`
      SELECT entity_link_overrides FROM connector_definitions
      WHERE key = 'whatsapp' AND organization_id = ${org.id}
    `;
    expect(rows[0].entity_link_overrides).toEqual({
      $member: { autoCreate: false, maskIdentities: ['phone'] },
    });
  });

  it('clears overrides when given null', async () => {
    const result = (await manageConnections(
      {
        action: 'set_connector_entity_link_overrides',
        connector_key: 'whatsapp',
        overrides: null,
      },
      env,
      ctx
    )) as { overrides: unknown };

    expect(result.overrides).toBe(null);

    const sql = getTestDb();
    const rows = await sql<{ entity_link_overrides: Record<string, unknown> | null }[]>`
      SELECT entity_link_overrides FROM connector_definitions
      WHERE key = 'whatsapp' AND organization_id = ${org.id}
    `;
    expect(rows[0].entity_link_overrides).toBe(null);
  });

  it('rejects malformed overrides', async () => {
    const result = (await manageConnections(
      {
        action: 'set_connector_entity_link_overrides',
        connector_key: 'whatsapp',
        overrides: { $member: { disable: 'yes' as unknown as boolean } },
      },
      env,
      ctx
    )) as { error?: string };

    expect(result.error).toMatch(/Invalid overrides/);
  });

  it('rejects unknown connector_key', async () => {
    const result = (await manageConnections(
      {
        action: 'set_connector_entity_link_overrides',
        connector_key: 'nonexistent',
        overrides: {},
      },
      env,
      ctx
    )) as { error?: string };

    expect(result.error).toMatch(/not found/);
  });
});
