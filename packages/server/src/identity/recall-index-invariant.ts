/**
 * Recall-index invariant — the guard that keeps the connector recall-namespace
 * DECLARATION in sync with the physical event-recall INDEXES.
 *
 * Read-time recall (utils/content-search/entity-link.ts) builds one UNION branch
 * per namespace in `STANDARD_IDENTITY_NAMESPACES`, and each branch relies on the
 * partial BTREE index `idx_events_metadata_<ns>` to avoid seq-scanning the
 * (multi-GB) events table. That index is created by a hand-written migration,
 * while the namespace set is now assembled in code from the generic SDK registry
 * plus each connector's `recallNamespaces`. Nothing structurally ties the two
 * together — a connector could declare a recall namespace with no index (silent
 * seq-scan) or a migration could add an index no one declares (dead index).
 *
 * This module closes that gap: `assertRecallIndexInvariant` compares the two
 * sets and throws on any mismatch. It runs at server startup and is asserted in
 * CI against the migrated test DB.
 */

import type { DbClient } from '../db/client.js';
import { STANDARD_IDENTITY_NAMESPACES } from '../utils/content-search/entity-link.js';

/** Prefix every event-recall index shares (`idx_events_metadata_<ns>`). */
const RECALL_INDEX_PREFIX = 'idx_events_metadata_';

/** The namespaces code declares as recall-indexed (generic + every connector). */
export function declaredRecallNamespaces(): string[] {
  return [...STANDARD_IDENTITY_NAMESPACES];
}

/** The recall namespaces that physically have an `idx_events_metadata_<ns>` index. */
export async function indexedRecallNamespaces(sql: DbClient): Promise<string[]> {
  const rows = await sql<{ indexname: string }>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'events'
      AND indexname LIKE ${`${RECALL_INDEX_PREFIX}%`}
  `;
  return rows.map((r) => r.indexname.slice(RECALL_INDEX_PREFIX.length));
}

export interface RecallIndexDrift {
  /** Declared recall namespaces with NO physical index → would seq-scan events. */
  missingIndexes: string[];
  /** Physical indexes with NO declaring namespace → dead index / stale migration. */
  orphanIndexes: string[];
}

/** Compute the drift between declared recall namespaces and physical indexes. */
export function computeRecallIndexDrift(
  declared: string[],
  indexed: string[],
): RecallIndexDrift {
  const declaredSet = new Set(declared);
  const indexedSet = new Set(indexed);
  return {
    missingIndexes: declared.filter((ns) => !indexedSet.has(ns)).sort(),
    orphanIndexes: indexed.filter((ns) => !declaredSet.has(ns)).sort(),
  };
}

/**
 * Throw if the declared recall namespaces and the physical `idx_events_metadata_*`
 * indexes disagree. A missing index would silently seq-scan the events table on
 * every recall; an orphan index is a stale migration that should be dropped.
 * Called at startup and in CI.
 */
export async function assertRecallIndexInvariant(sql: DbClient): Promise<void> {
  const declared = declaredRecallNamespaces();
  const indexed = await indexedRecallNamespaces(sql);
  const { missingIndexes, orphanIndexes } = computeRecallIndexDrift(declared, indexed);
  if (missingIndexes.length === 0 && orphanIndexes.length === 0) return;

  const parts: string[] = [];
  if (missingIndexes.length > 0) {
    parts.push(
      `recall namespaces declared with NO idx_events_metadata_ index (would seq-scan events): ${missingIndexes.join(', ')} — add the migration or drop the recallNamespaces declaration`,
    );
  }
  if (orphanIndexes.length > 0) {
    parts.push(
      `idx_events_metadata_ indexes with NO declaring recall namespace (dead index): ${orphanIndexes.join(', ')} — drop the index migration or declare the namespace`,
    );
  }
  throw new Error(`recall-index invariant violated: ${parts.join('; ')}`);
}
