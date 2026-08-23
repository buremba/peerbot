/**
 * Config-audit emission for tool handlers (manage_* admin tools).
 *
 * Wraps `recordConfigChangeEvent` with the actor fields every tool call site
 * derives the same way from its ToolContext — apply-id grouping, actor
 * source, user, client. Handlers state only WHAT changed; forgetting the
 * apply-id threading (which would silently ungroup a `lobu apply` run's
 * changes in the Deployments feed) stops being possible.
 */

import type { ConfigResourceKind } from '../../../utils/config-redaction';
import { deriveToolActorSource } from '../../../utils/apply-context';
import type { DbClient } from '../../../db/client';
import {
  insertConfigChangeEventInTransaction,
  recordConfigChangeEvent,
} from '../../../utils/insert-event';
import type { ToolContext } from '../../registry';

interface ToolConfigChangeParams {
  /**
   * Override when the mutated row's org is resolved from data rather than
   * the caller (automation tools can act on entity-derived orgs). Defaults to
   * `ctx.organizationId`.
   */
  organizationId?: string;
  resourceKind: ConfigResourceKind;
  resourceId: string | number;
  op: 'created' | 'updated' | 'deleted';
  /** Human-readable summary (e.g. "Automation 'inbox' paused"). */
  summary: string;
  /** Full post-change state (redacted by the writer); null for deletes. */
  state: Record<string, unknown> | null;
  changedFields?: string[];
}

export function recordToolConfigChange(
  ctx: ToolContext,
  params: ToolConfigChangeParams
): void {
  recordConfigChangeEvent({
    organizationId: ctx.organizationId,
    ...params,
    applyId: ctx.applyId ?? null,
    actorSource: deriveToolActorSource(ctx),
    createdBy: ctx.userId ?? null,
    clientId: ctx.clientId ?? null,
  });
}

/** Awaited variant for mutations whose state and audit must share a commit. */
export async function insertToolConfigChange(
  ctx: ToolContext,
  params: ToolConfigChangeParams,
  sql: DbClient
): Promise<void> {
  await insertConfigChangeEventInTransaction(
    {
      organizationId: ctx.organizationId,
      ...params,
      applyId: ctx.applyId ?? null,
      actorSource: deriveToolActorSource(ctx),
      createdBy: ctx.userId ?? null,
      clientId: ctx.clientId ?? null,
    },
    sql
  );
}
