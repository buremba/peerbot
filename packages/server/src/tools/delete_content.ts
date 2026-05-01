/**
 * Tool: delete_knowledge
 *
 * The `events` table is append-only — no row is ever physically removed. To
 * "delete" an event we insert a small tombstone event whose
 * `supersedes_event_id` points at the target. The `current_event_records`
 * view filters out events that have a newer superseder, so the original
 * disappears from default search/query/read paths. The full history stays
 * recoverable via `include_superseded` and direct `events`-table reads.
 *
 * This matches the contract advertised by `save_knowledge`:
 *   "Storage is append-only — pass `supersedes_event_id` to replace an
 *    existing fact (the old event is hidden from future searches without
 *    losing history)."
 *
 * Authorization mirrors `save_knowledge` since the underlying primitive is
 * the same (insert an event with `supersedes_event_id`).
 */

import { type Static, Type } from '@sinclair/typebox';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { getDb, pgBigintArray } from '../db/client';
import type { Env } from '../index';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import type { ToolContext } from './registry';

export const DeleteContentSchema = Type.Object({
  event_id: Type.Optional(
    Type.Number({
      description: 'Single event id to delete. Provide either this or `event_ids`.',
    })
  ),
  event_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: 'Batch of event ids to delete. Provide either this or `event_id`.',
    })
  ),
  reason: Type.Optional(
    Type.String({
      description:
        'Optional human-readable reason; persisted on the tombstone for audit trails.',
    })
  ),
});

type DeleteContentArgs = Static<typeof DeleteContentSchema>;

export interface DeleteContentResult {
  deleted_ids: number[];
  tombstone_ids: number[];
  not_found_ids: number[];
  already_superseded_ids: number[];
}

const TOMBSTONE_SEMANTIC_TYPE = 'tombstone';

export async function deleteContent(
  args: DeleteContentArgs,
  _env: Env,
  ctx: ToolContext
): Promise<DeleteContentResult> {
  const isSystem = ctx.userId === null && ctx.isAuthenticated;
  if (!isSystem) {
    if (!ctx.memberRole) {
      throw new Error('delete_knowledge requires workspace membership with write access.');
    }
    if (!hasRequiredMcpScope('write', ctx.scopes)) {
      throw new Error('delete_knowledge requires an MCP session with write access.');
    }
  }

  const requested = collectIds(args);
  if (requested.length === 0) {
    throw new Error('Provide event_id or a non-empty event_ids array');
  }

  const sql = getDb();

  const inOrg = await sql<{ id: number }>`
    SELECT id FROM events
    WHERE id = ANY(${pgBigintArray(requested)}::bigint[])
      AND organization_id = ${ctx.organizationId}
  `;
  const inOrgIds = new Set(inOrg.map((row) => Number(row.id)));
  const notFoundIds = requested.filter((id) => !inOrgIds.has(id));

  const candidateIds = [...inOrgIds];
  const alreadySupersededRows =
    candidateIds.length > 0
      ? await sql<{ supersedes_event_id: number }>`
        SELECT supersedes_event_id FROM events
        WHERE supersedes_event_id = ANY(${pgBigintArray(candidateIds)}::bigint[])
      `
      : [];
  const alreadySupersededIds = Array.from(
    new Set(alreadySupersededRows.map((row) => Number(row.supersedes_event_id)))
  );
  const alreadySupersededSet = new Set(alreadySupersededIds);

  const targetIds = candidateIds.filter((id) => !alreadySupersededSet.has(id));

  const tombstoneIds: number[] = [];
  for (const targetId of targetIds) {
    const tombstone = await insertEvent({
      entityIds: [],
      organizationId: ctx.organizationId,
      originId: `tomb_${crypto.randomUUID()}`,
      semanticType: TOMBSTONE_SEMANTIC_TYPE,
      payloadType: 'empty',
      content: null,
      metadata: {
        tombstone: true,
        deleted_event_id: targetId,
        ...(args.reason ? { reason: args.reason } : {}),
      },
      supersedesEventId: targetId,
      createdBy: ctx.userId,
      clientId: ctx.clientId,
    });
    tombstoneIds.push(Number(tombstone.id));
  }

  logger.info(
    {
      organizationId: ctx.organizationId,
      deletedIds: targetIds,
      tombstoneIds,
      notFoundIds,
      alreadySupersededIds,
    },
    'delete_knowledge'
  );

  return {
    deleted_ids: targetIds,
    tombstone_ids: tombstoneIds,
    not_found_ids: notFoundIds,
    already_superseded_ids: alreadySupersededIds,
  };
}

function collectIds(args: DeleteContentArgs): number[] {
  const ids: number[] = [];
  if (typeof args.event_id === 'number') ids.push(args.event_id);
  if (Array.isArray(args.event_ids)) ids.push(...args.event_ids);
  return Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
}
