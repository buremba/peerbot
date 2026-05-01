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
 * Returns only the most-recent correction per (field_path) — earlier
 * superseded corrections are dropped so the prompt does not accumulate
 * historical noise. Returns undefined if no feedback exists.
 */
export async function getRecentFeedbackSummary(
  watcherId: number | string,
  limit = 20
): Promise<string | undefined> {
  const sql = getDb();
  const feedback = await sql`
    SELECT DISTINCT ON (f.field_path)
           f.field_path, f.mutation, f.corrected_value, f.note, f.created_at,
           w.window_start, w.window_end
    FROM watcher_window_field_feedback f
    JOIN watcher_windows w ON f.window_id = w.id
    WHERE f.watcher_id = ${watcherId}
    ORDER BY f.field_path, f.created_at DESC
    LIMIT ${limit}
  `;

  if (feedback.length === 0) return undefined;

  const lines: string[] = ['## Past Corrections from User Feedback'];
  for (const row of feedback) {
    const start = new Date(row.window_start as string).toISOString().split('T')[0];
    const end = new Date(row.window_end as string).toISOString().split('T')[0];
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
