/**
 * Automation Feedback Utilities
 *
 * Queries user-submitted corrections on automation extraction results
 * and formats them for injection into future LLM prompts.
 */

import { getDb } from '../db/client';

/**
 * Build a human-readable summary of past user corrections for an automation.
 *
 * Reads window-field corrections from the events spine (semantic_type='correction'). Returns
 * only the most-recent correction per (field_path) — earlier superseded corrections are dropped
 * so the prompt does not accumulate historical noise. Returns undefined if no feedback exists.
 */
export async function getRecentFeedbackSummary(
  automationId: number | string,
  limit = 20
): Promise<string | undefined> {
  const sql = getDb();
  const feedback = await sql`
        SELECT DISTINCT ON (e.metadata->>'field_path')
               e.metadata->>'field_path' AS field_path,
               e.metadata->>'mutation' AS mutation,
               e.metadata->'corrected_value' AS corrected_value,
               e.metadata->>'note' AS note,
               e.created_at,
               (w.approved_input->>'window_start')::timestamptz AS window_start,
               (w.approved_input->>'window_end')::timestamptz AS window_end
        FROM events e
        LEFT JOIN runs w
          ON w.id = e.run_id
        WHERE e.semantic_type = 'correction'
          AND (e.metadata->>'automation_id')::bigint = ${automationId}
        ORDER BY e.metadata->>'field_path', e.created_at DESC
        LIMIT ${limit}
      `;

  if (feedback.length === 0) return undefined;

  const lines: string[] = ['## Past Corrections from User Feedback'];
  for (const row of feedback) {
    // Guard historical corrections whose source run is no longer available.
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
    // A whole-run rejection (manage_operations.reject_batch) rather than a
    // single-field correction: the user turned down the run's proposals with a
    // reason (in `note`). Render it as guidance for the next run, not a field set.
    if (path === '$batch_reject') {
      line = `- Window ${start}–${end}: the user REJECTED this run's proposed changes${
        row.note ? ` — ${row.note}` : ''
      }. Revise your extraction accordingly.`;
      lines.push(line);
      continue;
    }
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
