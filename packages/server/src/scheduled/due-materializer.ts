/**
 * Generic "materialize due items into runs" loop.
 *
 * Three schedulers share the same shape — scan for due rows (each query
 * carries its own status filters / NOT EXISTS active-run dedup / LIMIT),
 * then create one run per row, counting created vs skipped and isolating
 * per-item failures so one bad row can't abort the batch:
 *
 *   - scheduled/check-due-feeds.ts        → sync runs for due feeds
 *   - watchers/automation.ts              → watcher runs for due watchers
 *   - scheduled/trigger-embed-backfill.ts → embed_backfill runs per org batch
 *
 * The SQL stays entirely in each caller's `fetchDue` / `createRun` callbacks;
 * this module only owns the orchestration (empty short-circuit, loop,
 * counters, per-item error isolation).
 */

import logger from '../utils/logger';

interface DueMaterializeCounts {
  /** Rows returned by `fetchDue` this pass. */
  due: number;
  /** Items whose `createRun` reported 'created'. */
  runsCreated: number;
  /** Items whose `createRun` reported 'skipped' (lost a race / deduped). */
  skipped: number;
}

interface MaterializeDueItemsOptions<T> {
  /** Job label for the default per-item failure log (e.g. 'CheckDueFeeds'). */
  label: string;
  /** Scan for due rows. Throws propagate to the caller untouched. */
  fetchDue: () => Promise<readonly T[]>;
  /**
   * Create the run for one due item. Return 'created' on success, 'skipped'
   * when another pass/pod already covered the item (dedupe, unique-index
   * race). Per-item success logging belongs here.
   */
  createRun: (item: T) => Promise<'created' | 'skipped'>;
  /**
   * Per-item failure hook (logging + any compensation, e.g. advancing a
   * schedule so a broken item isn't re-selected every tick). Failed items
   * count as neither created nor skipped. Defaults to a generic error log.
   */
  onError?: (item: T, error: unknown) => void | Promise<void>;
  /** Called once when due items were found, before the create loop. */
  onFound?: (items: readonly T[]) => void;
  /** Called once after the loop with the final counts (only when due > 0). */
  onDone?: (counts: DueMaterializeCounts) => void;
}

export async function materializeDueItems<T>(
  options: MaterializeDueItemsOptions<T>
): Promise<DueMaterializeCounts> {
  const items = await options.fetchDue();

  if (items.length === 0) {
    return { due: 0, runsCreated: 0, skipped: 0 };
  }

  options.onFound?.(items);

  let runsCreated = 0;
  let skipped = 0;

  for (const item of items) {
    try {
      const outcome = await options.createRun(item);
      if (outcome === 'created') runsCreated++;
      else skipped++;
    } catch (error) {
      if (options.onError) {
        await options.onError(item, error);
      } else {
        logger.error({ error }, `[${options.label}] Failed to create run for due item`);
      }
    }
  }

  const counts: DueMaterializeCounts = { due: items.length, runsCreated, skipped };
  options.onDone?.(counts);
  return counts;
}
