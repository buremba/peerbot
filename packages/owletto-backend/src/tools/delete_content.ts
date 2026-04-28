/**
 * Tool: delete_knowledge
 *
 * Hard-delete one or more knowledge events by id. Cascades clean up embeddings,
 * classifications, and watcher-window links via FK ON DELETE CASCADE; events
 * that supersede the target have their `supersedes_event_id` reset (ON DELETE
 * SET NULL) so historical chains stay intact.
 *
 * Use `save_knowledge` with `supersedes_event_id` when you want to *replace* an
 * event while keeping the audit trail. Use this when you want it gone — for
 * example, to clean up a smoke-test write or remove a row that was never meant
 * to land.
 */

import { type Static, Type } from '@sinclair/typebox';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { getDb } from '../db/client';
import type { Env } from '../index';
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
});

type DeleteContentArgs = Static<typeof DeleteContentSchema>;

interface DeleteContentResult {
  deleted_ids: number[];
  not_found_ids: number[];
}

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

  const deleted = await sql<{ id: number }[]>`
    DELETE FROM events
    WHERE id = ANY(${requested}::bigint[])
      AND organization_id = ${ctx.organizationId}
    RETURNING id
  `;

  const deletedIds = deleted.map((row) => Number(row.id));
  const deletedSet = new Set(deletedIds);
  const notFoundIds = requested.filter((id) => !deletedSet.has(id));

  logger.info(
    { deletedIds, notFoundIds, organizationId: ctx.organizationId },
    'delete_knowledge'
  );

  return { deleted_ids: deletedIds, not_found_ids: notFoundIds };
}

function collectIds(args: DeleteContentArgs): number[] {
  const ids: number[] = [];
  if (typeof args.event_id === 'number') ids.push(args.event_id);
  if (Array.isArray(args.event_ids)) ids.push(...args.event_ids);
  return Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
}
