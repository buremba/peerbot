/** Integration coverage for kind-backed notification write, render, and filtering. */

import { beforeAll, describe, expect, it } from 'vitest';
import { createNotificationForUsers } from '../../../notifications/service';
import { notify } from '../../../tools/admin/notify';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { primeMemberEventKinds } from '../../../utils/event-kind-validation';
import { insertEvent } from '../../../utils/insert-event';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('notify > semantic_type (kind) payload', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let ctx: ToolContext;
  const sql = getTestDb();

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Notify Kind Org' });
    user = await createTestUser({ email: 'notify-kind@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entity = await createTestEntity({
      name: 'Notify Kind Entity',
      organization_id: org.id,
    });
    // A notification is validated against $member kinds even when entity-anchored.
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({
        funnel_digest: {
          description: 'Entity-scoped digest with an incompatible renderer',
          jsonTemplate: { type: 'markdown', content: 'Wrong registry' },
        },
      })}
      WHERE id = (
        SELECT entity_type_id FROM entities WHERE id = ${entity.id}
      )
    `;

    const { client_id } = await createTestOAuthClient({
      client_name: 'notify-kind-test',
      owner_user_id: user.id,
    });
    await createTestAccessToken(user.id, org.id, client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      clientId: client_id,
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    };

    // Register a kind with a bar-chart template so the render tail can resolve it.
    await ensureMemberEntityType(org.id);
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({
        funnel_digest: {
          description: 'Weekly funnel digest',
          metadataSchema: {
            type: 'object',
            properties: {
              rows: { type: 'array' },
            },
            required: ['rows'],
          },
          jsonTemplate: {
            type: 'bar-chart',
            data: '{{rows}}',
          },
        },
        static_digest: {
          description: 'Static digest',
          metadataSchema: { type: 'object' },
          jsonTemplate: { type: 'bar-chart', data: [] },
        },
      })}
      WHERE slug = '$member'
        AND organization_id = ${org.id}
        AND deleted_at IS NULL
    `;
    primeMemberEventKinds(org.id, {
      funnel_digest: {
        description: 'Weekly funnel digest',
        metadataSchema: {
          type: 'object',
          properties: {
            rows: { type: 'array' },
          },
          required: ['rows'],
        },
        jsonTemplate: {
          type: 'bar-chart',
          data: '{{rows}}',
        },
      },
      static_digest: {
        description: 'Static digest',
        metadataSchema: { type: 'object' },
        jsonTemplate: { type: 'bar-chart', data: [] },
      },
    } as never);
  });

  it('writes a kind notification through the event payload columns', async () => {
    const data = {
      rows: [
        { label: 'Mon', value: 10 },
        { label: 'Tue', value: 24 },
      ],
      _lobu_idempotency_key: 'caller-controlled',
      card: { type: 'caller-controlled' },
      mcp_session_id: 'caller-controlled',
    };
    const { notified_count, event_id } = await notify({
      action: 'send',
      title: 'Funnel digest',
      body: 'Two new leads this week.',
      semantic_type: 'funnel_digest',
      data,
    }, {} as never, ctx);

    expect(notified_count).toBe(1);
    expect(event_id).not.toBeNull();

    const rows = await sql<{
      semantic_type: string;
      payload_type: string;
      payload_text: string;
      payload_data: unknown;
    }>`
      SELECT semantic_type, payload_type, payload_text, payload_data
      FROM events
      WHERE id = ${event_id}
    `;
    expect(rows[0].semantic_type).toBe('funnel_digest');
    expect(rows[0].payload_type).toBe('empty');
    expect(rows[0].payload_text).toBe('Two new leads this week.');
    expect(rows[0].payload_data).toEqual(data);

    const meta = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM events WHERE id = ${event_id}
    `;
    expect(meta[0].metadata.notification_type).toBe('agent_message');
    expect(meta[0].metadata).not.toHaveProperty('rows');
    expect(meta[0].metadata).not.toHaveProperty('_lobu_idempotency_key');
    expect(meta[0].metadata).not.toHaveProperty('card');
    expect(meta[0].metadata).not.toHaveProperty('mcp_session_id');
  });

  it('renders a chart template for a kind notification via get_content', async () => {
    await insertEvent({
      organizationId: org.id,
      originId: 'notify-kind-non-notification-control',
      title: 'only-nonnotification-control-94721',
      entityIds: [entity.id],
      semanticType: 'funnel_digest',
      payloadType: 'empty',
      payloadData: { rows: [{ label: 'Wed', value: 7 }] },
      metadata: { rows: [{ label: 'Wed', value: 7 }] },
    });
    await createNotificationForUsers([user.id], {
      organizationId: org.id,
      type: 'agent_message',
      title: 'Chart notification',
      body: 'Daily events',
      entityIds: [entity.id],
      semanticType: 'funnel_digest',
      payloadData: {
        rows: [
          { label: 'Mon', value: 10 },
          { label: 'Tue', value: 24 },
        ],
      },
    });
    await notify({
      action: 'send',
      title: 'Kind notification without data',
      semantic_type: 'static_digest',
      data: {},
    }, {} as never, ctx);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'notify-kind-summary-control',
      title: 'Summary control',
      semanticType: 'summary',
      payloadType: 'text',
      content: 'A normal summary',
    });
    const content = await getContent(
      {
        limit: 10,
        semantic_type: 'notification',
      } as never,
      {} as never,
      ctx
    );

    const chartItem = content.content?.find((item) => item.title === 'Chart notification');
    expect(chartItem).toBeDefined();
    expect(
      content.content?.some((item) => item.title === 'only-nonnotification-control-94721')
    ).toBe(false);
    expect(chartItem?.payload_type).toBe('json_template');
    expect(chartItem?.payload_data).toEqual({
      rows: [
        { label: 'Mon', value: 10 },
        { label: 'Tue', value: 24 },
      ],
    });
    expect(chartItem?.payload_template).toEqual({
      root: {
        type: 'bar-chart',
        data: '{{rows}}',
      },
    });
    const noDataItem = content.content?.find(
      (item) => item.title === 'Kind notification without data'
    );
    expect(noDataItem?.payload_type).toBe('json_template');
    expect(noDataItem?.payload_template).toEqual({
      root: { type: 'bar-chart', data: [] },
    });
    expect(noDataItem?.payload_data).toEqual({});

    const search = await getContent(
      {
        query: 'only-nonnotification-control-94721',
        sort_by: 'date',
        semantic_type: 'notification',
      } as never,
      {} as never,
      ctx
    );
    expect(search.content).toEqual([]);

    const mixedKinds = await getContent(
      {
        limit: 20,
        semantic_type: ['notification', 'summary'],
      } as never,
      {} as never,
      ctx
    );
    expect(mixedKinds.content?.some((item) => item.title === 'Chart notification')).toBe(true);
    expect(mixedKinds.content?.some((item) => item.title === 'Summary control')).toBe(true);
    expect(
      mixedKinds.content?.some((item) => item.title === 'only-nonnotification-control-94721')
    ).toBe(false);

    const scoreSorted = await getContent(
      {
        limit: 20,
        sort_by: 'score',
        semantic_type: 'notification',
      } as never,
      {} as never,
      ctx
    );
    expect(scoreSorted.content?.some((item) => item.title === 'Chart notification')).toBe(true);
    expect(
      scoreSorted.content?.some((item) => item.title === 'only-nonnotification-control-94721')
    ).toBe(false);

    const history = await getContent(
      {
        entity_id: entity.id,
        limit: 20,
        include_superseded: true,
        semantic_type: 'notification',
      } as never,
      {} as never,
      ctx
    );
    expect(history.content?.some((item) => item.title === 'Chart notification')).toBe(true);
    expect(
      history.content?.some((item) => item.title === 'only-nonnotification-control-94721')
    ).toBe(false);
  });

  it('rejects an unregistered kind', async () => {
    await expect(
      notify(
        {
          action: 'send',
          title: 'Bad kind',
          semantic_type: 'does_not_exist',
          data: {},
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/Invalid kind 'does_not_exist'/);
  });

  it('rejects data that does not match the kind metadata schema', async () => {
    await expect(
      notify(
        {
          action: 'send',
          title: 'Bad data',
          semantic_type: 'funnel_digest',
          data: { total: 12 },
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/Metadata validation failed for kind 'funnel_digest'/);
  });

  it('rejects semantic_type combined with input_schema', async () => {
    await expect(
      notify(
        {
          action: 'send',
          title: 'Mixed',
          semantic_type: 'funnel_digest',
          input_schema: {},
          recipients: ['missing-user'],
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('leaves the ask path untouched: notification stays semantic_type=notification', async () => {
    await notify(
      {
        action: 'send',
        title: 'Approve this?',
        input_schema: {},
      } as never,
      {} as never,
      ctx
    );

    const rows = await sql<{ semantic_type: string }>`
      SELECT semantic_type
      FROM events
      WHERE title = 'Approve this?'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows[0].semantic_type).toBe('notification');
  });
});
