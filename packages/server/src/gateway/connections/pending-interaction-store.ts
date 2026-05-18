/**
 * Postgres-backed store for chat-interaction-bridge pending questions.
 *
 * Replaces the in-process `Map<questionId, PendingQuestionEntry>` so a
 * button click that lands on pod B can claim a question registered on
 * pod A. Backed by `public.pending_interactions`.
 *
 * `claimPendingQuestion` is a single atomic `UPDATE … RETURNING` scoped
 * by `(id, organization_id, connection_id, expected_user_id)`:
 *   - cross-tenant: a leaked/forged id in another org cannot match.
 *   - cross-connection: a click on connection X cannot consume a row
 *     registered for connection Y in the same org.
 *   - wrong-user: a click from someone other than the original requester
 *     never sets `claimed_at`, so process death after the SQL check leaves
 *     the row claimable by the rightful owner — no restash needed.
 *
 * Only the serializable parts of `PendingQuestionEntry` (the
 * `PostedQuestion`) live here. The non-serializable platform `SentMessage`
 * handle stays in a small per-pod cache inside the bridge — losing it
 * only degrades the card-edit-on-click UX (the answer routes correctly
 * either way).
 */

import { getDb } from "../../db/client.js";
import type { PostedQuestion } from "../interactions.js";

export interface StoredPendingQuestion {
  question: PostedQuestion;
}

export async function storePendingQuestion(
  questionId: string,
  organizationId: string,
  connectionId: string,
  expectedUserId: string,
  entry: StoredPendingQuestion,
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO pending_interactions (
      id,
      organization_id,
      connection_id,
      expected_user_id,
      entry_payload
    )
    VALUES (
      ${questionId},
      ${organizationId},
      ${connectionId},
      ${expectedUserId},
      ${sql.json(entry as object)}
    )
    ON CONFLICT (id) DO UPDATE SET
      organization_id  = EXCLUDED.organization_id,
      connection_id    = EXCLUDED.connection_id,
      expected_user_id = EXCLUDED.expected_user_id,
      entry_payload    = EXCLUDED.entry_payload,
      created_at       = now(),
      claimed_at       = NULL
  `;
}

/**
 * Atomically mark a pending question as claimed and return its payload.
 *
 * Scoped by `(id, organization_id, connection_id, expected_user_id)` — a
 * click that doesn't match all four leaves the row untouched and returns
 * null. This fixes three classes of bug that a key-by-id-only claim
 * permitted: cross-tenant claim hijacking, cross-connection takeover, and
 * the claim-then-auth race where a wrong-user click would consume the
 * row and rely on an async restash to put it back.
 */
export async function claimPendingQuestion(
  questionId: string,
  organizationId: string,
  connectionId: string,
  expectedUserId: string,
): Promise<StoredPendingQuestion | null> {
  const sql = getDb();
  const rows = await sql`
    UPDATE pending_interactions
       SET claimed_at = now()
     WHERE id               = ${questionId}
       AND organization_id  = ${organizationId}
       AND connection_id    = ${connectionId}
       AND expected_user_id = ${expectedUserId}
       AND claimed_at IS NULL
    RETURNING entry_payload
  `;
  if (rows.length === 0) return null;
  return (
    (rows[0] as { entry_payload: StoredPendingQuestion }).entry_payload ?? null
  );
}

/**
 * Delete pending_interactions rows older than `maxAgeMs` and return their
 * ids. The bridge calls this from the scheduled sweep so it can also evict
 * the corresponding per-pod `SentMessage` cache entries — otherwise that
 * Map would grow unbounded for questions that are never clicked.
 */
export async function sweepStalePendingInteractions(
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<string[]> {
  const sql = getDb();
  const cutoff = new Date(Date.now() - maxAgeMs);
  const rows = await sql<{ id: string }>`
    DELETE FROM pending_interactions
     WHERE created_at < ${cutoff}
    RETURNING id
  `;
  return rows.map((r) => r.id);
}
