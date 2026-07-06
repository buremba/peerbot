/**
 * Tool: save_memory
 *
 * Save content to the workspace, optionally associated with entities.
 * semantic_type is required and validated against $member.event_kinds for the org.
 * Entity metadata is validated against the entity type's schema.
 * Embeddings are left null for background worker backfill.
 */

import { normalizeAuthUserId, normalizeEmail } from '@lobu/connector-sdk/identity-normalize';
import { type Static, Type } from '@sinclair/typebox';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { resolveChannelEntityId } from '../authz/channel-entity';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { autoLinkEvent } from '../utils/auto-linker';
import { ToolUserError } from '../utils/errors';
import { validateSaveContentSemanticType } from '../utils/event-kind-validation';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { ensureMemberEntityType } from '../utils/member-entity-type';
import { requireWriteAccess } from '../utils/organization-access';
import { trackWatcherReaction } from '../utils/watcher-reactions';
import { isSystemContext } from './access-control';
import { MEMBER_ENTITY_TYPE_SLUG } from './constants';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { buildEventViewUrl } from './view-urls';

/**
 * True when a Postgres error is the unique-violation (23505) on the partial
 * index that guards "at most one event supersedes a given target". The loser
 * of a concurrent-supersede race hits this; postgres.js exposes the SQLSTATE
 * on `code` and the index name on `constraint`/`constraint_name`.
 */
function isSupersededByUniqueViolation(error: unknown): boolean {
  const err = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  };
  if (err?.code !== '23505') return false;
  return (
    err.constraint === 'idx_events_superseded_by' ||
    err.constraint_name === 'idx_events_superseded_by' ||
    (typeof err.message === 'string' && err.message.includes('idx_events_superseded_by'))
  );
}

// ============================================
// Typebox Schema
// ============================================

export const SaveContentSchema = Type.Object({
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: 'Entity IDs to associate content with. Omit for org-scoped content.',
    })
  ),
  content: Type.Optional(
    Type.String({
      description: 'The text content to save. Required for text/markdown payload types.',
    })
  ),
  title: Type.Optional(Type.String({ description: 'Short title or summary' })),
  author: Type.Optional(Type.String({ description: 'Author name or identifier' })),
  semantic_type: Type.Optional(
    Type.String({
      description:
        'Semantic type (e.g. note, summary, decision, identity, observation). Preferred.',
    })
  ),
  payload_type: Type.Optional(
    Type.Union(
      [
        Type.Literal('text'),
        Type.Literal('markdown'),
        Type.Literal('json_template'),
        Type.Literal('media'),
        Type.Literal('empty'),
      ],
      {
        description:
          "Content format. 'text' (default): plain text. 'markdown': rendered as rich text. 'json_template': rendered via payload_template + payload_data. 'media': media-focused display. 'empty': metadata only.",
      }
    )
  ),
  payload_data: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'Structured data object. Used as template data for json_template, or structured metadata for media.',
    })
  ),
  payload_template: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'JSON template for rendering. Required when payload_type is json_template. Must have a { root: ... } structure.',
    })
  ),
  attachments: Type.Optional(
    Type.Array(Type.Record(Type.String(), Type.Any()), {
      description: 'Array of attachment objects (e.g. files, images).',
    })
  ),
  source_url: Type.Optional(
    Type.String({ description: 'URL of the original source for this content.' })
  ),
  occurred_at: Type.Optional(
    Type.String({
      description: 'When the event actually happened (ISO 8601). Defaults to now if omitted.',
    })
  ),
  metadata: Type.Record(Type.String(), Type.Any(), {
    description:
      'Structured metadata — validated against the entity type schema or semantic_type schema',
  }),
  supersedes_event_id: Type.Optional(
    Type.Number({
      description:
        'ID of an existing event this content replaces (e.g. updated preference, corrected fact). The old event is marked as superseded and excluded from future searches.',
    })
  ),
  watcher_source: Type.Optional(
    Type.Object(
      {
        watcher_id: Type.Number({ description: 'Watcher that triggered this save' }),
        window_id: Type.Number({ description: 'Window that triggered this save' }),
      },
      { description: 'Attribution source when save is triggered by a watcher reaction' }
    )
  ),
});

type SaveContentArgs = Static<typeof SaveContentSchema>;

// ============================================
// Result Type
// ============================================

interface SaveContentResult {
  id: number;
  entity_ids: number[];
  title: string | null;
  semantic_type: string;
  created_at: string;
  supersedes_event_id?: number;
  view_url?: string;
}

// ============================================
// Handler
// ============================================

export const saveContent = withValidatedArgs('save_memory', SaveContentSchema, saveContentImpl);

async function saveContentImpl(
  args: SaveContentArgs,
  _env: Env,
  ctx: ToolContext
): Promise<SaveContentResult> {
  // SDK delegates (`client.knowledge.save`) skip `checkToolAccess`, so apply
  // the same member+scope gate here. System contexts (userId=null + auth=true)
  // bypass — watcher reactions don't carry a user identity.
  if (!isSystemContext(ctx)) {
    if (!ctx.memberRole) {
      throw new ToolUserError('save_memory requires workspace membership with write access.', 403);
    }
    if (!hasRequiredMcpScope('write', ctx.scopes)) {
      throw new ToolUserError('save_memory requires an MCP session with write access.', 403);
    }
  }

  const sql = getDb();

  // 0. Ensure $member entity type exists for this org
  await ensureMemberEntityType(ctx.organizationId);

  const entityIds: number[] = args.entity_ids ?? [];
  const semanticType = args.semantic_type;
  if (!semanticType) throw new ToolUserError('semantic_type is required');

  const payloadType = args.payload_type ?? 'text';

  // Validate content requirement based on payload_type
  if ((payloadType === 'text' || payloadType === 'markdown') && !args.content) {
    throw new ToolUserError(`content is required for payload_type '${payloadType}'`);
  }
  if (payloadType === 'json_template' && !args.payload_template) {
    throw new ToolUserError("payload_template is required when payload_type is 'json_template'");
  }

  // 1. Require write access for each entity
  for (const eid of entityIds) {
    await requireWriteAccess(sql, eid, ctx);
  }

  // 2. Validate semantic_type against $member.event_kinds + entity type event_kinds
  const kindValidation = await validateSaveContentSemanticType(
    semanticType,
    args.metadata,
    ctx.organizationId,
    entityIds.length > 0 ? entityIds : undefined
  );
  if (!kindValidation.valid) {
    throw new ToolUserError(kindValidation.errors.join('\n'), 422);
  }

  // 3. Validate event metadata against entity type's event kind schema (if entity-associated)
  //    Note: entity type metadata_schema is for entity creation/update, not for events.
  //    Event metadata is already validated against event_kinds metadataSchema in step 2.

  // 4. Resolve $member entity for this user via entity_identities and append to entity_ids.
  //    Identity lookup order:
  //      1) auth_user_id namespace (already linked in a prior call)
  //      2) email namespace (user has a member entity claimed by some connector); claim auth_user_id
  const finalEntityIds = [...entityIds];
  if (ctx.userId) {
    const authId = normalizeAuthUserId(ctx.userId);
    let memberRows: Array<{ id: number | string }> = [];

    if (authId) {
      memberRows = await sql`
        SELECT e.id
        FROM entity_identities ei
        JOIN entities e ON e.id = ei.entity_id
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE ei.organization_id = ${ctx.organizationId}
          AND ei.namespace = 'auth_user_id'
          AND ei.identifier = ${authId}
          AND ei.deleted_at IS NULL
          AND et.slug = ${MEMBER_ENTITY_TYPE_SLUG}
          AND e.deleted_at IS NULL
        LIMIT 1
      `;
    }

    if (memberRows.length === 0 && authId) {
      const userRows = await sql`SELECT email FROM "user" WHERE id = ${ctx.userId} LIMIT 1`;
      const userEmail =
        userRows.length > 0 ? normalizeEmail(userRows[0].email as string | null) : null;
      if (userEmail) {
        memberRows = await sql`
          SELECT e.id
          FROM entity_identities ei
          JOIN entities e ON e.id = ei.entity_id
          JOIN entity_types et ON et.id = e.entity_type_id
          WHERE ei.organization_id = ${ctx.organizationId}
            AND ei.namespace = 'email'
            AND ei.identifier = ${userEmail}
            AND ei.deleted_at IS NULL
            AND et.slug = ${MEMBER_ENTITY_TYPE_SLUG}
            AND e.deleted_at IS NULL
          LIMIT 1
        `;
        if (memberRows.length > 0) {
          const memberId = Number(memberRows[0].id);
          await sql`
            INSERT INTO entity_identities (
              organization_id, entity_id, namespace, identifier, source_connector
            ) VALUES (
              ${ctx.organizationId}, ${memberId}, 'auth_user_id', ${authId}, 'save_content'
            )
            ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
            DO NOTHING
          `;
          logger.info(
            { memberId, userId: ctx.userId, email: userEmail },
            '$member linked via email → auth_user_id claim'
          );
        }
      }
    }

    if (memberRows.length > 0) {
      const memberId = Number(memberRows[0].id);
      if (!finalEntityIds.includes(memberId)) {
        finalEntityIds.push(memberId);
      }
    }
  }

  // 4b. Stamp the source CHANNEL entity when this save originates from a chat
  //     session (worker-originated, carries team + channel in sourceContext).
  //     This makes distilled channel knowhow inherit the channel's per-member
  //     visibility gate (resource-visibility) instead of being org-visible —
  //     so a member of #eng recalls what the agent learned there, but #exec
  //     knowhow never leaks into #eng recall. Best-effort: a channel with no
  //     graphed entity (never synced) resolves to null and the save proceeds
  //     with the existing org/$member scoping.
  const channelEntityId = await resolveChannelEntityId(
    ctx.organizationId,
    ctx.sourceContext?.teamId,
    ctx.sourceContext?.channelId,
    sql
  );
  if (channelEntityId !== null && !finalEntityIds.includes(channelEntityId)) {
    finalEntityIds.push(channelEntityId);
  }

  // 5. Validate supersedes target exists and belongs to this org
  if (args.supersedes_event_id) {
    const existing = await sql`
      SELECT id FROM events
      WHERE id = ${args.supersedes_event_id}
        AND organization_id = ${ctx.organizationId}
    `;
    if (existing.length === 0) {
      // Stale supersede target (already gone / wrong org) is a user fault, not
      // an infra error — ToolUserError so it doesn't fire a Sentry alert.
      throw new ToolUserError(
        `Cannot supersede event ${args.supersedes_event_id}: not found in this organization`,
        404
      );
    }
    const superseding = await sql`
      SELECT id FROM events
      WHERE supersedes_event_id = ${args.supersedes_event_id}
      LIMIT 1
    `;
    if (superseding.length > 0) {
      throw new ToolUserError(
        `Cannot supersede event ${args.supersedes_event_id}: already superseded by event ${superseding[0].id}`,
        409
      );
    }
  }

  // 6. Insert into events
  const externalId = `uc_${crypto.randomUUID()}`;

  let row: Awaited<ReturnType<typeof insertEvent>>;
  try {
    row = await insertEvent({
      entityIds: finalEntityIds,
      organizationId: ctx.organizationId,
      originId: externalId,
      title: args.title,
      payloadType,
      content: args.content ?? null,
      payloadData: args.payload_data,
      payloadTemplate: args.payload_template ?? null,
      attachments: args.attachments,
      authorName: args.author,
      sourceUrl: args.source_url ?? null,
      // The schema promises "Defaults to now if omitted" — honor it. A NULL
      // occurred_at makes the event invisible to watcher windows (window
      // content filters on occurred_at within [window_start, window_end)).
      occurredAt: args.occurred_at ?? new Date().toISOString(),
      semanticType,
      metadata: args.metadata,
      createdBy: ctx.userId,
      clientId: ctx.clientId,
      supersedesEventId: args.supersedes_event_id ?? null,
    });
  } catch (error) {
    // The "already superseded?" SELECT above is non-atomic: two concurrent
    // supersedes of the same target both pass the read, both INSERT, and the
    // loser hits the partial unique index idx_events_superseded_by with a raw
    // 23505. The unique index protects the invariant (no data loss) — surface
    // it as a clean 409 user error instead of a raw DB error + Sentry alert.
    if (
      args.supersedes_event_id &&
      isSupersededByUniqueViolation(error)
    ) {
      throw new ToolUserError(
        `Cannot supersede event ${args.supersedes_event_id}: already superseded by a concurrent write`,
        409
      );
    }
    throw error;
  }

  // 6b. Auto-link: scan content for entity name mentions.
  // Awaited so the background work doesn't outlive the tool call and reject
  // into an unhandled promise after the DB pool has been torn down.
  if (finalEntityIds.length > 0) {
    await autoLinkEvent({
      eventId: Number(row.id),
      entityIds: finalEntityIds,
      content: args.content ?? '',
      title: args.title,
      organizationId: ctx.organizationId,
    }).catch((err) => {
      logger.warn({ err, eventId: row.id }, 'autoLinkEvent failed');
    });
  }

  logger.info(
    {
      id: row.id,
      entity_ids: finalEntityIds,
      semantic_type: semanticType,
      supersedes: args.supersedes_event_id,
    },
    'Content saved via save_memory'
  );

  // Track watcher reaction if attribution source is provided
  if (args.watcher_source) {
    await trackWatcherReaction({
      organizationId: ctx.organizationId,
      watcherId: args.watcher_source.watcher_id,
      windowId: args.watcher_source.window_id,
      reactionType: 'content_saved',
      toolName: 'save_memory',
      toolArgs: { entity_ids: finalEntityIds, semantic_type: semanticType, title: args.title },
      entityId: finalEntityIds[0],
    }).catch((err) => {
      logger.warn({ err, watcherSource: args.watcher_source }, 'trackWatcherReaction failed');
    });
  }

  const result: SaveContentResult = {
    id: Number(row.id),
    entity_ids: Array.isArray(row.entity_ids) ? row.entity_ids.map(Number) : finalEntityIds,
    title: row.title as string | null,
    semantic_type: semanticType,
    created_at: String(row.created_at),
  };
  if (args.supersedes_event_id) {
    result.supersedes_event_id = args.supersedes_event_id;
  }

  const viewUrl = await buildEventViewUrl(ctx, result.id);
  if (viewUrl) {
    result.view_url = viewUrl;
  }

  return result;
}
