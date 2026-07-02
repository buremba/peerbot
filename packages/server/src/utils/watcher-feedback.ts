/**
 * Watcher Feedback Utilities
 *
 * Queries user-submitted corrections on watcher extraction results
 * and formats them for injection into future LLM prompts.
 */

import { getDb } from '../db/client';

/**
 * Build a human-readable summary of past user corrections for a watcher.
 *
 * Reads window-field corrections from the events spine (semantic_type='correction'). Returns
 * only the most-recent correction per (field_path) — earlier superseded corrections are dropped
 * so the prompt does not accumulate historical noise. Returns undefined if no feedback exists.
 */
export async function getRecentFeedbackSummary(
  watcherId: number | string,
  limit = 20
): Promise<string | undefined> {
  const sql = getDb();
  // A correction's metadata.window_id is the canvas ROOT event id; the
  // canvas_windows view resolves the period (LEFT JOIN — tombstoned roots null).
  const feedback = await sql`
        SELECT DISTINCT ON (e.metadata->>'field_path')
               e.metadata->>'field_path' AS field_path,
               e.metadata->>'mutation' AS mutation,
               e.metadata->'corrected_value' AS corrected_value,
               e.metadata->>'note' AS note,
               e.created_at, w.window_start, w.window_end
        FROM events e
        LEFT JOIN canvas_windows w
          ON w.id = (e.metadata->>'window_id')::bigint
        WHERE e.semantic_type = 'correction'
          AND (e.metadata->>'watcher_id')::bigint = ${watcherId}
        ORDER BY e.metadata->>'field_path', e.created_at DESC
        LIMIT ${limit}
      `;

  if (feedback.length === 0) return undefined;

  const lines: string[] = ['## Past Corrections from User Feedback'];
  for (const row of feedback) {
    // window_start/window_end come from the canvas root event; guard against a
    // correction whose root was tombstoned (LEFT JOIN → null).
    const start = row.window_start
      ? new Date(row.window_start as string).toISOString().split('T')[0]
      : '?';
    const end = row.window_end
      ? new Date(row.window_end as string).toISOString().split('T')[0]
      : '?';
    const path = row.field_path as string;
    const mutation = row.mutation as 'set' | 'remove' | 'add';
    const value = row.corrected_value;

    let line: string;
    if (mutation === 'remove') {
      line = `- Window ${start}–${end}: drop "${path}"`;
    } else if (mutation === 'add') {
      line = `- Window ${start}–${end}: append to "${path}" — ${JSON.stringify(value)}`;
    } else {
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      line = `- Window ${start}–${end}: "${path}" → ${rendered}`;
    }
    if (row.note) {
      line += ` (note: "${row.note}")`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}
