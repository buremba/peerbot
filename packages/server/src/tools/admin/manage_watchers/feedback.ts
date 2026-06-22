/**
 * Feedback action handlers for manage_watchers:
 *   submit_feedback, get_feedback
 */

import { getDb } from '../../../db/client';
import { feedbackViaCorrections } from '../../../utils/watcher-feedback';
import type { ToolContext } from '../../registry';
import type { ManageWatchersArgs, ManageWatchersResult } from '../manage_watchers';

type CorrectionInput = {
  field_path: string;
  mutation?: 'set' | 'remove' | 'add';
  value?: unknown;
  note?: string;
};

// ============================================
// handleSubmitFeedback
// ============================================

export async function handleSubmitFeedback(
  args: ManageWatchersArgs,
  ctx: ToolContext
): Promise<ManageWatchersResult> {
  if (!args.watcher_id) throw new Error('watcher_id is required');
  if (!args.window_id) throw new Error('window_id is required');
  if (!ctx.userId) {
    throw new Error('Authentication required to submit feedback');
  }
  const corrections = args.corrections as CorrectionInput[] | undefined;
  if (!Array.isArray(corrections) || corrections.length === 0) {
    throw new Error('corrections must be a non-empty array of {field_path, ...} entries');
  }

  for (const c of corrections) {
    if (!c.field_path || typeof c.field_path !== 'string') {
      throw new Error('each correction requires a string field_path');
    }
    const m = c.mutation ?? 'set';
    if (m !== 'set' && m !== 'remove' && m !== 'add') {
      throw new Error(`unsupported mutation "${m}" for ${c.field_path}`);
    }
    if ((m === 'set' || m === 'add') && c.value === undefined) {
      throw new Error(`${m} correction for ${c.field_path} requires a value`);
    }
  }

  const sql = getDb();
  const watcherId = Number(args.watcher_id);

  // Scope to the caller's current org so a member of org A can't write
  // feedback against a watcher in org B by passing its watcher_id.
  const windowCheck = await sql`
    SELECT ww.id, w.organization_id
    FROM watcher_windows ww
    JOIN watchers w ON ww.watcher_id = w.id
    WHERE ww.id = ${args.window_id}
      AND ww.watcher_id = ${watcherId}
      AND w.organization_id = ${ctx.organizationId}
  `;
  if (windowCheck.length === 0) {
    throw new Error(`Window ${args.window_id} not found for watcher ${watcherId}`);
  }
  const organizationId = windowCheck[0].organization_id as string;

  // Insert in one transaction so a partial failure never leaks half-applied
  // corrections — submit_feedback is naturally a batch operation from the UI.
  const feedbackIds = await sql.begin(async (tx) => {
    const ids: number[] = [];
    for (const c of corrections) {
      const mutation = c.mutation ?? 'set';
      const correctedValueJson =
        mutation === 'remove' || c.value === undefined ? null : tx.json(c.value);
      const result = await tx`
        INSERT INTO watcher_window_field_feedback (
          window_id, watcher_id, organization_id,
          field_path, mutation, corrected_value, note, created_by
        )
        VALUES (
          ${args.window_id}, ${watcherId}, ${organizationId},
          ${c.field_path}, ${mutation}, ${correctedValueJson},
          ${c.note ?? null}, ${ctx.userId}
        )
        RETURNING id
      `;
      ids.push(Number(result[0].id));
    }
    return ids;
  });

  return {
    action: 'submit_feedback',
    watcher_id: args.watcher_id,
    window_id: args.window_id,
    feedback_ids: feedbackIds,
  };
}

// ============================================
// handleGetFeedback
// ============================================

export async function handleGetFeedback(
  args: ManageWatchersArgs,
  ctx: ToolContext
): Promise<ManageWatchersResult> {
  if (!args.watcher_id) throw new Error('watcher_id is required');

  const sql = getDb();
  const watcherId = Number(args.watcher_id);
  const limit = args.limit ?? 50;

  // Scope to the caller's current org so a member of org A can't enumerate
  // feedback for a watcher in org B by passing its watcher_id. Correction-events (P1) phase 2:
  // read from the events mirror behind FEEDBACK_VIA_CORRECTIONS (the feedback id is recovered
  // from origin_id 'wwff_<id>' so the response is equivalent; org-scoping stays identical).
  // created_by is equivalent on the happy path; it only differs AFTER the author user is deleted
  // (the table keeps the dangling id, the event shows NULL via events.created_by's FK SET NULL —
  // the event is arguably more correct). Accepted: the mirror can't store a non-user id without
  // breaking the feedback submit on events_created_by_fkey (the reason for the phase-1 resolve).
  const feedback = feedbackViaCorrections()
    ? args.window_id
      ? await sql`
          SELECT (substring(e.origin_id from 6))::bigint AS id,
                 (e.metadata->>'window_id')::bigint AS window_id,
                 e.metadata->>'field_path' AS field_path, e.metadata->>'mutation' AS mutation,
                 e.metadata->'corrected_value' AS corrected_value, e.metadata->>'note' AS note,
                 e.created_by, e.created_at, w.window_start, w.window_end
          FROM events e
          JOIN watcher_windows w ON (e.metadata->>'window_id')::bigint = w.id
          WHERE e.semantic_type = 'correction'
            AND (e.metadata->>'watcher_id')::bigint = ${watcherId}
            AND (e.metadata->>'window_id')::bigint = ${args.window_id}
            AND e.organization_id = ${ctx.organizationId}
          ORDER BY e.created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT (substring(e.origin_id from 6))::bigint AS id,
                 (e.metadata->>'window_id')::bigint AS window_id,
                 e.metadata->>'field_path' AS field_path, e.metadata->>'mutation' AS mutation,
                 e.metadata->'corrected_value' AS corrected_value, e.metadata->>'note' AS note,
                 e.created_by, e.created_at, w.window_start, w.window_end
          FROM events e
          JOIN watcher_windows w ON (e.metadata->>'window_id')::bigint = w.id
          WHERE e.semantic_type = 'correction'
            AND (e.metadata->>'watcher_id')::bigint = ${watcherId}
            AND e.organization_id = ${ctx.organizationId}
          ORDER BY e.created_at DESC
          LIMIT ${limit}
        `
    : args.window_id
      ? await sql`
        SELECT f.id, f.window_id, f.field_path, f.mutation, f.corrected_value,
               f.note, f.created_by, f.created_at,
               w.window_start, w.window_end
        FROM watcher_window_field_feedback f
        JOIN watcher_windows w ON f.window_id = w.id
        WHERE f.watcher_id = ${watcherId}
          AND f.window_id = ${args.window_id}
          AND f.organization_id = ${ctx.organizationId}
        ORDER BY f.created_at DESC
        LIMIT ${limit}
      `
      : await sql`
        SELECT f.id, f.window_id, f.field_path, f.mutation, f.corrected_value,
               f.note, f.created_by, f.created_at,
               w.window_start, w.window_end
        FROM watcher_window_field_feedback f
        JOIN watcher_windows w ON f.window_id = w.id
        WHERE f.watcher_id = ${watcherId}
          AND f.organization_id = ${ctx.organizationId}
        ORDER BY f.created_at DESC
        LIMIT ${limit}
      `;

  return {
    action: 'get_feedback',
    watcher_id: args.watcher_id,
    feedback: feedback.map((row) => ({
      id: Number(row.id),
      window_id: Number(row.window_id),
      field_path: row.field_path as string,
      mutation: row.mutation as 'set' | 'remove' | 'add',
      corrected_value: row.corrected_value as unknown,
      note: row.note as string | null,
      created_by: row.created_by as string,
      created_at: (row.created_at as Date).toISOString(),
      window_start: row.window_start ? (row.window_start as Date).toISOString() : undefined,
      window_end: row.window_end ? (row.window_end as Date).toISOString() : undefined,
    })),
  };
}
