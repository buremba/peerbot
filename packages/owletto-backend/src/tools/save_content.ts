/**
 * Tool: save_knowledge
 *
 * Save content to the workspace, optionally associated with entities.
 * semantic_type is required and validated against $member.event_kinds for the org.
 * Entity metadata is validated against the entity type's schema.
 * Embeddings are left null for background worker backfill.
 */

import { normalizeAuthUserId, normalizeEmail } from '@lobu/owletto-sdk';
import { type Static, Type } from '@sinclair/typebox';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { autoLinkEvent } from '../utils/auto-linker';
import { validateSaveContentSemanticType } from '../utils/event-kind-validation';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { ensureMemberEntityType } from '../utils/member-entity-type';
import { requireWriteAccess } from '../utils/organization-access';
import { buildEventPermalink, getOrganizationSlug, getPublicWebUrl } from '../utils/url-builder';
import { trackWatcherReaction } from '../utils/watcher-reactions';
import type { ToolContext } from './registry';

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

export async function saveContent(
  args: SaveContentArgs,
  _env: Env,
  ctx: ToolContext
): Promise<SaveContentResult> {
  // SDK delegates (`client.knowledge.save`) skip `checkToolAccess`, so apply
  // the same member+scope gate here. System contexts (userId=null + auth=true)
  // bypass — watcher reactions don't carry a user identity.
  const isSystem = ctx.userId === null && ctx.isAuthenticated;
  if (!isSystem) {
    if (!ctx.memberRole) {
      throw new Error('save_knowledge requires workspace membership with write access.');
    }
    if (!hasRequiredMcpScope('write', ctx.scopes)) {
      throw new Error('save_knowledge requires an MCP session with write access.');
    }
  }

  const sql = getDb();

  // 0. Ensure $member entity type exists for this org
  await ensureMemberEntityType(ctx.organizationId);

  const entityIds: number[] = args.entity_ids ?? [];
  const semanticType = args.semantic_type;
  if (!semanticType) throw new Error('semantic_type is required');

  const payloadType = args.payload_type ?? 'text';

  // Validate content requirement based on payload_type
  if ((payloadType === 'text' || payloadType === 'markdown') && !args.content) {
    throw new Error(`content is required for payload_type '${payloadType}'`);
  }
  if (payloadType === 'json_template' && !args.payload_template) {
    throw new Error("payload_template is required when payload_type is 'json_template'");
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
    throw new Error(kindValidation.errors.join('\n'));
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
          AND et.slug = '$member'
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
            AND et.slug = '$member'
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

  // 5. Validate supersedes target exists and belongs to this org
  if (args.supersedes_event_id) {
    const existing = await sql`
      SELECT id FROM events
      WHERE id = ${args.supersedes_event_id}
        AND organization_id = ${ctx.organizationId}
    `;
    if (existing.length === 0) {
      throw new Error(
        `Cannot supersede event ${args.supersedes_event_id}: not found in this organization`
      );
    }
    const superseding = await sql`
      SELECT id FROM events
      WHERE supersedes_event_id = ${args.supersedes_event_id}
      LIMIT 1
    `;
    if (superseding.length > 0) {
      throw new Error(
        `Cannot supersede event ${args.supersedes_event_id}: already superseded by event ${superseding[0].id}`
      );
    }
  }

  // 6. Insert into events
  const externalId = `uc_${crypto.randomUUID()}`;

  const row = await insertEvent({
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
    occurredAt: args.occurred_at ?? null,
    semanticType,
    metadata: args.metadata,
    createdBy: ctx.userId,
    clientId: ctx.clientId,
    supersedesEventId: args.supersedes_event_id ?? null,
  });

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
    'Content saved via save_knowledge'
  );

  // Track watcher reaction if attribution source is provided
  if (args.watcher_source) {
    await trackWatcherReaction({
      organizationId: ctx.organizationId,
      watcherId: args.watcher_source.watcher_id,
      windowId: args.watcher_source.window_id,
      reactionType: 'content_saved',
      toolName: 'save_knowledge',
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

  const ownerSlug = await getOrganizationSlug(ctx.organizationId);
  if (ownerSlug) {
    const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
    result.view_url = buildEventPermalink(ownerSlug, result.id, baseUrl);
  }

  return result;
}
