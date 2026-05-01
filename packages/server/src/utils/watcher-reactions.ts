/**
 * Shared helpers for watcher reaction queries and tracking.
 */

import { getDb } from '../db/client';
import { listOperations } from '../operations/catalog';
import logger from './logger';

/**
 * Fetch available connection operations for a set of entity IDs.
 */
export async function getAvailableOperations(
  entityIds: number[],
  organizationId?: string
): Promise<
  Array<{
    connection_id: number;
    operation_key: string;
    name: string;
    kind: 'read' | 'write';
    requires_approval: boolean;
  }>
> {
  if (entityIds.length === 0) return [];
  const sql = getDb();
  const idsLiteral = `{${entityIds.map(Number).join(',')}}`;
  const rows = organizationId
    ? await sql`
        SELECT DISTINCT c.id as connection_id
        FROM connections c
        JOIN feeds f ON f.connection_id = c.id
        WHERE c.status = 'active'
          AND f.entity_ids && ${idsLiteral}::bigint[]
          AND f.deleted_at IS NULL
          AND c.organization_id = ${organizationId}
      `
    : await sql`
        SELECT DISTINCT c.id as connection_id, c.organization_id
        FROM connections c
        JOIN feeds f ON f.connection_id = c.id
        WHERE c.status = 'active'
          AND f.entity_ids && ${idsLiteral}::bigint[]
          AND f.deleted_at IS NULL
      `;

  const result: Array<{
    connection_id: number;
    operation_key: string;
    name: string;
    kind: 'read' | 'write';
    requires_approval: boolean;
  }> = [];
  for (const row of rows as Array<{ connection_id: number; organization_id?: string }>) {
    const orgId = organizationId ?? row.organization_id;
    if (!orgId) continue;
    const { operations } = await listOperations({
      organizationId: orgId,
      connectionId: Number(row.connection_id),
      includeInputSchema: false,
      includeOutputSchema: false,
      limit: 1000,
      offset: 0,
    });
    for (const operation of operations) {
      result.push({
        connection_id: Number(row.connection_id),
        operation_key: operation.operation_key,
        name: operation.name,
        kind: operation.kind,
        requires_approval: operation.requires_approval,
      });
    }
  }
  return result;
}

/**
 * Build a human-readable summary of past watcher reactions.
 */
export async function getPastReactionsSummary(
  watcherId: number | string,
  limit = 20
): Promise<string | undefined> {
  const sql = getDb();
  const reactions = await sql`
    SELECT wr.reaction_type, wr.tool_name, wr.tool_args, wr.created_at,
           ww.window_start, ww.window_end
    FROM watcher_reactions wr
    JOIN watcher_windows ww ON wr.window_id = ww.id
    WHERE wr.watcher_id = ${watcherId}
    ORDER BY wr.created_at DESC
    LIMIT ${limit}
  `;
  if (reactions.length === 0) return undefined;
  const lines: string[] = ['## Past Reactions'];
  for (const r of reactions) {
    const date = new Date(r.window_start as string).toISOString().split('T')[0];
    const toolArgs = r.tool_args as Record<string, unknown> | null;
    const detail = toolArgs ? JSON.stringify(toolArgs) : '';
    lines.push(`- Window ${date}: ${r.reaction_type} via ${r.tool_name} ${detail}`);
  }
  return lines.join('\n');
}

/**
 * Track a watcher reaction (fire-and-forget safe).
 */
export async function trackWatcherReaction(params: {
  organizationId: string;
  watcherId: number;
  windowId: number;
  reactionType: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  entityId?: number;
  runId?: number;
}): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO watcher_reactions (
      organization_id, watcher_id, window_id,
      reaction_type, tool_name, tool_args, tool_result, entity_id, run_id
    ) VALUES (
      ${params.organizationId}, ${params.watcherId}, ${params.windowId},
      ${params.reactionType}, ${params.toolName},
      ${sql.json(params.toolArgs)},
      ${params.toolResult ? sql.json(params.toolResult) : null},
      ${params.entityId ?? null},
      ${params.runId ?? null}
    )
  `.catch((err) => logger.error(err, 'Failed to track watcher reaction'));
}
