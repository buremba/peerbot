/**
 * Watcher Feedback Utilities
 *
 * Queries user-submitted corrections on watcher extraction results
 * and formats them for injection into future LLM prompts.
 */

import { getDb } from '../db/client';

/**
 * Check whether any feedback exists for a watcher (cheap EXISTS query).
 */
export async function hasFeedback(watcherId: number | string): Promise<boolean> {
  const sql = getDb();
  const result = await sql`
    SELECT 1 FROM watcher_window_feedback WHERE watcher_id = ${watcherId} LIMIT 1
  `;
  return result.length > 0;
}

/**
 * Build a human-readable summary of past user corrections for a watcher.
 * Returns undefined if no feedback exists.
 */
export async function getRecentFeedbackSummary(
  watcherId: number | string,
  limit = 10
): Promise<string | undefined> {
  const sql = getDb();
  const feedback = await sql`
    SELECT f.corrections, f.notes, f.created_at,
           w.window_start, w.window_end
    FROM watcher_window_feedback f
    JOIN watcher_windows w ON f.window_id = w.id
    WHERE f.watcher_id = ${watcherId}
    ORDER BY f.created_at DESC
    LIMIT ${limit}
  `;

  if (feedback.length === 0) return undefined;

  const lines: string[] = ['## Past Corrections from User Feedback'];
  for (const row of feedback) {
    const start = new Date(row.window_start as string).toISOString().split('T')[0];
    const end = new Date(row.window_end as string).toISOString().split('T')[0];
    const corrections = row.corrections as Record<string, unknown>;

    for (const [field, correctedValue] of Object.entries(corrections)) {
      let line = `- Window ${start} to ${end}: "${field}" corrected to "${correctedValue}"`;
      if (row.notes) {
        line += ` (note: "${row.notes}")`;
      }
      lines.push(line);
    }
  }

  return lines.join('\n');
}
