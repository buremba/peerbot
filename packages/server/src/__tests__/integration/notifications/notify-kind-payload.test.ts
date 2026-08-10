/**
 * Integration test: notifications with `semantic_type` (kind) render through
 * the event-kind pipeline.
 *
 * A notification is an events row + notification_targets rows. `semantic_type`
 * routes a content notification through the same event-kind machinery as every
 * other event: the kind is validated against `$member.event_kinds`, the event
 * is written with `payload_type='empty'` + `payload_data`, and get_content's
 * render tail resolves the chart template from the kind's `jsonTemplate`.
 *
 * Pinned behavior:
 *   - kind + data writes the event with semantic_type=<kind>, payload_type
 *     'empty', and payload_data, so the render tail synthesizes a chart.
 *   - an unregistered kind is rejected (422), matching save_content.
 *   - `semantic_type` + `input_schema` together are rejected — content vs ask.
 *   - the ask path (`input_schema`) is untouched: the notification keeps
 *     semantic_type='notification' and its interaction-event chain.
 *
 * Vitest CI gap note (mirrors neighbors): runs locally / in the CI integration
 * job against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createNotificationForUsers } from '../../../notifications/service';
import { notify } from '../../../tools/admin/notify';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { primeMemberEventKinds } from '../../../utils/event-kind-validation';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('notify > semantic_type (kind) payload', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;
  const sql = getTestDb();

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Notify Kind Org' });
    user = await createTestUser({ email: 'notify-kind@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

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
          jsonTemplate: {
            root: {
              type: 'bar-chart',
              data: { $ref: '#/data/rows' },
            },
          },
        },
      })}
      WHERE slug = '$member'
        AND organization_id = ${org.id}
        AND deleted_at IS NULL
    `;
    primeMemberEventKinds(org.id, {
      funnel_digest: {
        description: 'Weekly funnel digest',
        jsonTemplate: {
          root: {
            type: 'bar-chart',
            data: { $ref: '#/data/rows' },
          },
        },
      },
    } as never);
  });

  it('writes a kind notification through the event payload columns', async () => {
    const data = {
      rows: [
        { label: 'Mon', value: 10 },
        { label: 'Tue', value: 24 },
      ],
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

    const rows = await sql<{ semantic_type: string; payload_type: string; payload_data: unknown }>`
      SELECT semantic_type, payload_type, payload_data
      FROM events
      WHERE id = ${event_id}
    `;
    expect(rows[0].semantic_type).toBe('funnel_digest');
    expect(rows[0].payload_type).toBe('empty');
    expect(rows[0].payload_data).toEqual(data);

    // The event's metadata carries the render payload too — the render tail
    // binds the chart against it (payload_data = metadata).
    const meta = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM events WHERE id = ${event_id}
    `;
    expect(meta[0].metadata.rows).toEqual(data.rows);
  });

  it('renders a chart template for a kind notification via get_content', async () => {
    await createNotificationForUsers([user.id], {
      organizationId: org.id,
      type: 'agent_message',
      title: 'Chart notification',
      body: 'Daily events',
      semanticType: 'funnel_digest',
      payloadType: 'empty',
      payloadData: {
        rows: [
          { label: 'Mon', value: 10 },
          { label: 'Tue', value: 24 },
        ],
      },
    });

    const content = await getContent(
      {
        limit: 10,
        is_notification: true,
      } as never,
      {} as never,
      ctx
    );

    const chartItem = content.content?.find((item) => item.title === 'Chart notification');
    expect(chartItem).toBeDefined();
    // The render tail synthesized a json_template from the kind's jsonTemplate.
    expect(chartItem!.payload_type).toBe('json_template');
    // resolveEntityRender normalizes the authored `{ root: node }` template and
    // the render tail wraps the result in its own `{ root }`, so the stored
    // template is `{ root: { root: <node> } }` — the renderer's consumed shape.
    expect(chartItem!.payload_template).toEqual({
      root: {
        root: {
          type: 'bar-chart',
          data: { $ref: '#/data/rows' },
        },
      },
    });
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

  it('rejects semantic_type combined with input_schema', async () => {
    await expect(
      notify(
        {
          action: 'send',
          title: 'Mixed',
          semantic_type: 'funnel_digest',
          input_schema: {},
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
