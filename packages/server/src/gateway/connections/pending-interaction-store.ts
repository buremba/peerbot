/**
 * Postgres-backed store for chat-interaction-bridge pending questions.
 *
 * Replaces the in-process `Map<questionId, PendingQuestionEntry>` so a
 * button click that lands on pod B can claim a question that was registered
 * on pod A. Backed by `public.pending_interactions`; `claimPendingQuestion`
 * is an atomic `UPDATE … RETURNING` so concurrent clicks (Slack webhook
 * retries, two users racing) serialize on the row.
 *
 * Only the serializable parts of `PendingQuestionEntry` (the `PostedQuestion`)
 * live here. The non-serializable platform `SentMessage` handle stays in a
 * small per-pod cache inside the bridge — losing it only degrades the
 * card-edit-on-click UX (the answer routes correctly either way).
 */

import { getDb } from "../../db/client.js";
import type { PostedQuestion } from "../interactions.js";

export interface StoredPendingQuestion {
  question: PostedQuestion;
}

export async function storePendingQuestion(
  questionId: string,
  organizationId: string | undefined,
  entry: StoredPendingQuestion,
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO pending_interactions (id, organization_id, entry_payload)
    VALUES (
      ${questionId},
      ${organizationId ?? null},
      ${sql.json(entry as object)}
    )
    ON CONFLICT (id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      entry_payload   = EXCLUDED.entry_payload,
      created_at      = now(),
      claimed_at      = NULL
  `;
}

/**
 * Atomically mark a pending question as claimed and return its payload.
 * Returns null if the question doesn't exist or was already claimed —
 * concurrent retries see null and no-op.
 */
export async function claimPendingQuestion(
  questionId: string,
): Promise<StoredPendingQuestion | null> {
  const sql = getDb();
  const rows = await sql`
    UPDATE pending_interactions
       SET claimed_at = now()
     WHERE id = ${questionId}
       AND claimed_at IS NULL
    RETURNING entry_payload
  `;
  if (rows.length === 0) return null;
  return (rows[0] as { entry_payload: StoredPendingQuestion }).entry_payload ?? null;
}

/**
 * Restore a previously-claimed entry — used when the click is rejected
 * (wrong user) so the rightful owner can still answer later. Best-effort:
 * if the row was already swept we re-INSERT it.
 */
export async function restashPendingQuestion(
  questionId: string,
  organizationId: string | undefined,
  entry: StoredPendingQuestion,
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO pending_interactions (id, organization_id, entry_payload)
    VALUES (
      ${questionId},
      ${organizationId ?? null},
      ${sql.json(entry as object)}
    )
    ON CONFLICT (id) DO UPDATE SET
      claimed_at = NULL,
      entry_payload = EXCLUDED.entry_payload
  `;
}

/**
 * Delete pending_interactions rows older than `maxAgeMs`. Called from the
 * scheduled cleanup task so claimed and abandoned rows don't accumulate.
 * Returns the deleted row count.
 */
export async function sweepStalePendingInteractions(
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  const sql = getDb();
  const cutoff = new Date(Date.now() - maxAgeMs);
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM pending_interactions
       WHERE created_at < ${cutoff}
      RETURNING id
    )
    SELECT count(*)::int AS count FROM deleted
  `;
  return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}
