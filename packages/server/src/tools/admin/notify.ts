/**
 * Tool: notify
 *
 * Send notifications to organization members from agents.
 *
 * Actions:
 * - send: Send a notification to org members
 */

import { type Static, Type } from '@sinclair/typebox';
import type { CardElement } from 'chat';
import { getDb, pgTextArray } from '../../db/client';
import { WATCHER_CANVAS_NAMESPACE } from '../../utils/canvas-events';
import { emit } from '../../events/emitter';
import { createNotificationForUsers } from '../../notifications/service';
import logger from '../../utils/logger';
import { trackWatcherReaction } from '../../utils/watcher-reactions';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';

// ============================================
// Schema
// ============================================

const SendAction = Type.Object({
  action: Type.Literal('send'),
  title: Type.String({ description: 'Notification title', maxLength: 200 }),
  body: Type.Optional(Type.String({ description: 'Notification body text', maxLength: 1000 })),
  recipients: Type.Optional(
    Type.Union(
      [
        Type.Literal('admins'),
        Type.Literal('all'),
        Type.Array(Type.String({ description: 'User ID' })),
      ],
      {
        default: 'admins',
        description:
          "Who to notify. 'admins' (default): org admins/owners. 'all': all org members. Or an array of specific user IDs.",
      }
    )
  ),
  resource_url: Type.Optional(
    Type.String({ description: 'Relative URL to link the notification to (e.g. /acme/entities)' })
  ),
  connection_id: Type.Optional(
    Type.String({
      description:
        'Connection ID for targeted delivery (e.g. Telegram bot connection). When set, notification is delivered through this specific bot connection.',
    })
  ),
  data: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: 'Arbitrary JSON payload stored in notification body as formatted JSON',
    })
  ),
  card: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'A `chat` CardElement (built with the card primitives) for rich bot-connection delivery. When set, the bound channel gets this card instead of the markdown body.',
    })
  ),
  watcher_source: Type.Optional(
    Type.Object(
      {
        watcher_id: Type.Number({ description: 'Watcher that triggered this notification' }),
        window_id: Type.Number({ description: 'Window that triggered this notification' }),
      },
      { description: 'Attribution source when notification is triggered by a watcher reaction' }
    )
  ),
});

// ============================================
// Handler
// ============================================

const notifyTool = defineActionTool('notify', {
  send: action(SendAction, handleSend),
});

export const NotifySchema = notifyTool.schema;
export const notify = notifyTool.run;

async function handleSend(
  args: Static<typeof SendAction>,
  ctx: ToolContext
): Promise<{ notified_count: number }> {
  const sql = getDb();
  const recipients = args.recipients ?? 'admins';

  let userIds: string[];
  if (Array.isArray(recipients)) {
    // Validate that the provided user IDs are actual members of the org
    const rows = await sql<{ userId: string }>`
      SELECT "userId"
      FROM "member"
      WHERE "organizationId" = ${ctx.organizationId}
        AND "userId" = ANY(${pgTextArray(recipients)}::text[])
    `;
    userIds = rows.map((r) => r.userId);
  } else if (recipients === 'all') {
    const rows = await sql<{ userId: string }>`
      SELECT "userId"
      FROM "member"
      WHERE "organizationId" = ${ctx.organizationId}
    `;
    userIds = rows.map((r) => r.userId);
  } else {
    // 'admins' (default)
    const rows = await sql<{ userId: string }>`
      SELECT "userId"
      FROM "member"
      WHERE "organizationId" = ${ctx.organizationId}
        AND role IN ('admin', 'owner')
    `;
    userIds = rows.map((r) => r.userId);
  }

  if (userIds.length === 0) {
    return { notified_count: 0 };
  }

  // Build body: prefer explicit body, append data as JSON if provided
  let body = args.body ?? null;
  if (args.data) {
    const dataStr = JSON.stringify(args.data, null, 2);
    body = body ? `${body}\n\n${dataStr}` : dataStr;
  }

  // Anchor watcher-sourced notifications to the watcher's canvas entity so they
  // thread under the canvas. watcher_source is caller input, so validate the
  // (watcher_id, window_id) pair against the caller's org before anchoring —
  // otherwise any org member could thread a notification under an unrelated
  // watcher's canvas. Resolve the lazy canvas entity via its entity_identities
  // claim; a mismatched pair or a watcher with no canvas yet anchors nothing.
  let canvasEntityIds: number[] | undefined;
  if (args.watcher_source) {
    const rows = await getDb()<{ entity_id: number | string }>`
      SELECT ei.entity_id
      FROM entity_identities ei
      JOIN watchers w
        ON w.id = ${args.watcher_source.watcher_id}
       AND w.organization_id = ${ctx.organizationId}
      WHERE ei.organization_id = ${ctx.organizationId}
        AND ei.namespace = ${WATCHER_CANVAS_NAMESPACE}
        AND ei.identifier = ${String(args.watcher_source.watcher_id)}
        AND ei.deleted_at IS NULL
        AND (
          ${args.watcher_source.window_id ?? null}::bigint IS NULL
          OR EXISTS (
            SELECT 1 FROM watcher_windows ww
            WHERE ww.id = ${args.watcher_source.window_id ?? null}
              AND ww.watcher_id = w.id
          )
        )
      LIMIT 1
    `;
    if (rows.length > 0) canvasEntityIds = [Number(rows[0].entity_id)];
  }

  await createNotificationForUsers(userIds, {
    organizationId: ctx.organizationId,
    type: 'agent_message',
    title: args.title,
    body,
    resourceUrl: args.resource_url ?? null,
    connectionId: args.connection_id ?? null,
    card: (args.card as CardElement | undefined) ?? null,
    entityIds: canvasEntityIds,
  });

  emit(ctx.organizationId, { keys: ['notifications', 'notifications-unread-count'] });

  // Track watcher reaction if attribution source is provided
  if (args.watcher_source) {
    await trackWatcherReaction({
      organizationId: ctx.organizationId,
      watcherId: args.watcher_source.watcher_id,
      windowId: args.watcher_source.window_id,
      reactionType: 'notification_sent',
      toolName: 'notify',
      toolArgs: { title: args.title, recipients: args.recipients },
    }).catch((err) => {
      logger.warn({ err, watcherSource: args.watcher_source }, 'trackWatcherReaction failed');
    });
  }

  return { notified_count: userIds.length };
}
