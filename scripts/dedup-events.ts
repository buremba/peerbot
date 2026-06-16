#!/usr/bin/env bun
/**
 * Admin maintenance: remove DUPLICATE current event rows.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * A now-fixed concurrency bug (PR #1286, `insert-event.ts` advisory lock) let
 * concurrent ingests of the same item create MULTIPLE CURRENT rows for the same
 * `(organization_id, connection_id, origin_id)`. `current_event_records` is
 * `events e WHERE NOT EXISTS (SELECT 1 FROM events newer WHERE
 * newer.supersedes_event_id = e.id)` — a row is "current" iff nothing supersedes
 * it. The bug therefore surfaces as N>1 *current* rows in a single dedup group.
 *
 * ─── Exact semantics (destructive — get this right) ──────────────────────────
 * For each group `(organization_id, connection_id, origin_id)` with
 * `origin_id IS NOT NULL` and MORE THAN ONE current row:
 *   - survivor = the single newest current row by `(created_at DESC, id DESC)`.
 *   - losers   = the OTHER current rows in the group.
 *   - For each loser, delete the loser AND its entire transitive
 *     supersedes-ancestor chain (follow `supersedes_event_id` upward). Deleting
 *     a loser alone would un-hide the ancestor it superseded (the ancestor would
 *     resurface in current_event_records), so the whole chain must go.
 *   - Result: exactly one current row (survivor) per group; the survivor's own
 *     ancestor chain is LEFT UNTOUCHED.
 * Groups that already have exactly one current row are NOT touched — those are
 * legitimate version history (one current + superseded edits), not duplicates.
 *
 * ─── Append-only guard ───────────────────────────────────────────────────────
 * `events` is append-only: the `trg_events_append_only` BEFORE DELETE trigger
 * blocks direct (depth-1) DELETEs unless `SET LOCAL lobu.allow_event_delete='on'`
 * is set in the transaction. Each batch transaction here sets that override.
 * `event_embeddings` (ON DELETE CASCADE) and the self-ref
 * `supersedes_event_id` (ON DELETE SET NULL) fire at depth>1 and are auto-allowed.
 *
 * ─── Safety ──────────────────────────────────────────────────────────────────
 *   - DRY-RUN by default; pass `--execute` to actually delete.
 *   - Batched: N groups per transaction, each wrapped so an error rolls the whole
 *     batch back and aborts the script (no partial half-chain deletes).
 *   - Idempotent: a second run finds 0 duplicate groups.
 *   - Never deletes a survivor; asserts after each batch that every touched group
 *     has exactly 1 current row.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   bun run scripts/dedup-events.ts                       # dry-run, all orgs
 *   bun run scripts/dedup-events.ts --execute             # delete, all orgs
 *   bun run scripts/dedup-events.ts --org <id>            # filter by org
 *   bun run scripts/dedup-events.ts --connector <key>     # filter by connector_key
 *   bun run scripts/dedup-events.ts --org <id> --execute  # delete, one org
 *   bun run scripts/dedup-events.ts --batch-size 50       # groups per tx (default 100)
 *
 * DATABASE_URL must point at the target database.
 */

import {
  getDb,
  parsePgNumberArray,
  pgBigintArray,
} from "../packages/server/src/db/client";

// ── Types ────────────────────────────────────────────────────────────────────

interface DedupGroup {
  organization_id: string;
  connection_id: number;
  origin_id: string;
  connector_key: string | null;
  /** All current row ids in the group, newest first (created_at DESC, id DESC). */
  current_ids: number[];
}

interface PlannedGroup {
  group: DedupGroup;
  survivorId: number;
  loserIds: number[];
  /** loserIds plus every transitive supersedes-ancestor of each loser. */
  deleteIds: number[];
}

export interface DedupOptions {
  execute: boolean;
  org?: string;
  connector?: string;
  batchSize: number;
  /** Injectable client for tests; defaults to the singleton pool. */
  db?: ReturnType<typeof getDb>;
  /** Sink for progress output; defaults to console.log. */
  log?: (msg: string) => void;
}

export interface DedupReport {
  duplicateGroups: number;
  totalGroupsScanned: number;
  /** Total rows that would be / were deleted (losers + ancestor chains). */
  totalDeletes: number;
  /** Per (organization_id, connector_key) breakdown. */
  perOrgConnector: Array<{
    organization_id: string;
    connector_key: string | null;
    duplicateGroups: number;
    deletes: number;
  }>;
  executed: boolean;
  currentRowsBefore: number;
  currentRowsAfter: number;
}

// ── Group discovery ──────────────────────────────────────────────────────────

/**
 * Find every (organization_id, connection_id, origin_id) group with MORE THAN
 * ONE current row. Returns the current row ids per group, newest first.
 *
 * A row is "current" iff nothing supersedes it — the same predicate as
 * `current_event_records`. We aggregate over that predicate and keep only
 * groups whose current-row count is > 1.
 */
async function findDuplicateGroups(
  sql: ReturnType<typeof getDb>,
  opts: Pick<DedupOptions, "org" | "connector">
): Promise<DedupGroup[]> {
  const orgFilter = opts.org ? sql`AND e.organization_id = ${opts.org}` : sql``;
  const connFilter = opts.connector
    ? sql`AND e.connector_key = ${opts.connector}`
    : sql``;

  const rows = await sql<{
    organization_id: string;
    connection_id: number;
    origin_id: string;
    connector_key: string | null;
    current_ids: number[];
  }>`
    SELECT
      e.organization_id,
      e.connection_id,
      e.origin_id,
      -- connector_key is purely for reporting; take the max (any) within the group.
      MAX(e.connector_key) AS connector_key,
      array_agg(e.id ORDER BY e.created_at DESC, e.id DESC) AS current_ids
    FROM events e
    WHERE e.origin_id IS NOT NULL
      AND e.connection_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id
      )
      ${orgFilter}
      ${connFilter}
    GROUP BY e.organization_id, e.connection_id, e.origin_id
    HAVING COUNT(*) > 1
    ORDER BY e.organization_id, e.connection_id, e.origin_id
  `;

  return rows.map((r) => ({
    organization_id: r.organization_id,
    connection_id: Number(r.connection_id),
    origin_id: r.origin_id,
    connector_key: r.connector_key,
    // Under fetch_types:false, array_agg(bigint) arrives as a PG array literal
    // string (`{1,2,3}`), not a JS array — parse it explicitly.
    current_ids: parsePgNumberArray(r.current_ids),
  }));
}

/**
 * For a batch of groups, resolve each loser's full transitive
 * supersedes-ancestor chain in ONE recursive query, then build the per-group
 * delete plan. The survivor (newest current row) is excluded from every plan
 * and its ancestors are deliberately NOT walked.
 */
async function planBatch(
  sql: ReturnType<typeof getDb>,
  groups: DedupGroup[]
): Promise<PlannedGroup[]> {
  const planned: PlannedGroup[] = [];
  const allLoserIds: number[] = [];

  for (const group of groups) {
    const [survivorId, ...loserIds] = group.current_ids;
    planned.push({ group, survivorId, loserIds, deleteIds: [...loserIds] });
    allLoserIds.push(...loserIds);
  }

  if (allLoserIds.length === 0) return planned;

  // Walk supersedes_event_id upward from every loser, collecting (root_loser_id,
  // ancestor_id) pairs. The recursion seeds at each loser's own supersedes
  // pointer and follows the chain to the top. Cycle protection via the path
  // array guards against any (illegal) self-reference loop in the data.
  const chainRows = await sql<{ root: number; ancestor: number }>`
    WITH RECURSIVE losers(id) AS (
      SELECT unnest(${pgBigintArray(allLoserIds)}::bigint[])
    ),
    chain(root, ancestor, path) AS (
      SELECT l.id, e.supersedes_event_id, ARRAY[l.id, e.supersedes_event_id]
      FROM losers l
      JOIN events e ON e.id = l.id
      WHERE e.supersedes_event_id IS NOT NULL
      UNION ALL
      SELECT c.root, e.supersedes_event_id, c.path || e.supersedes_event_id
      FROM chain c
      JOIN events e ON e.id = c.ancestor
      WHERE e.supersedes_event_id IS NOT NULL
        AND NOT (e.supersedes_event_id = ANY(c.path))
    )
    SELECT root, ancestor FROM chain
  `;

  const ancestorsByLoser = new Map<number, number[]>();
  for (const row of chainRows) {
    const root = Number(row.root);
    const list = ancestorsByLoser.get(root) ?? [];
    list.push(Number(row.ancestor));
    ancestorsByLoser.set(root, list);
  }

  for (const plan of planned) {
    const deletes = new Set<number>(plan.loserIds);
    for (const loserId of plan.loserIds) {
      for (const ancestor of ancestorsByLoser.get(loserId) ?? []) {
        deletes.add(ancestor);
      }
    }
    // Survivor must never be in a delete set. If a survivor's ancestor were
    // reachable from a loser chain it would mean the survivor and loser share
    // history, which the (org, connection, origin) grouping makes impossible for
    // distinct current rows — but assert anyway, this is destructive.
    if (deletes.has(plan.survivorId)) {
      throw new Error(
        `Refusing to delete survivor ${plan.survivorId} for group ` +
          `(${plan.group.organization_id}, ${plan.group.connection_id}, ${plan.group.origin_id})`
      );
    }
    plan.deleteIds = [...deletes];
  }

  return planned;
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Delete the planned rows for one batch inside a single transaction with the
 * append-only override set. After the deletes, re-assert that every touched
 * group has exactly one current row; any violation rolls the whole tx back.
 */
async function executeBatch(
  sql: ReturnType<typeof getDb>,
  batch: PlannedGroup[]
): Promise<number> {
  const deleteIds = batch.flatMap((p) => p.deleteIds);
  if (deleteIds.length === 0) return 0;

  await sql.begin(async (tx: ReturnType<typeof getDb>) => {
    await tx`SET LOCAL lobu.allow_event_delete = 'on'`;

    await tx`
      DELETE FROM events
      WHERE id = ANY(${pgBigintArray(deleteIds)}::bigint[])
    `;

    // Post-condition: every touched group now has exactly ONE current row.
    for (const plan of batch) {
      const current = await tx<{ cnt: number }>`
        SELECT COUNT(*)::int AS cnt
        FROM events e
        WHERE e.organization_id = ${plan.group.organization_id}
          AND e.connection_id = ${plan.group.connection_id}
          AND e.origin_id = ${plan.group.origin_id}
          AND NOT EXISTS (
            SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id
          )
      `;
      const cnt = Number(current[0]?.cnt ?? 0);
      if (cnt !== 1) {
        throw new Error(
          `Post-delete invariant violated for group ` +
            `(${plan.group.organization_id}, ${plan.group.connection_id}, ${plan.group.origin_id}): ` +
            `expected exactly 1 current row, found ${cnt}. Rolling back batch.`
        );
      }
      // Survivor must still exist.
      const survivor = await tx<{ id: number }>`
        SELECT id FROM events WHERE id = ${plan.survivorId}
      `;
      if (survivor.length !== 1) {
        throw new Error(
          `Survivor ${plan.survivorId} missing after delete — rolling back batch.`
        );
      }
    }
  });

  return deleteIds.length;
}

async function countCurrentRows(
  sql: ReturnType<typeof getDb>,
  opts: Pick<DedupOptions, "org" | "connector">
): Promise<number> {
  const orgFilter = opts.org ? sql`AND e.organization_id = ${opts.org}` : sql``;
  const connFilter = opts.connector
    ? sql`AND e.connector_key = ${opts.connector}`
    : sql``;
  const rows = await sql<{ cnt: number }>`
    SELECT COUNT(*)::bigint AS cnt
    FROM events e
    WHERE e.origin_id IS NOT NULL
      AND e.connection_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id
      )
      ${orgFilter}
      ${connFilter}
  `;
  return Number(rows[0]?.cnt ?? 0);
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function dedupEvents(options: DedupOptions): Promise<DedupReport> {
  const sql = options.db ?? getDb();
  const log = options.log ?? ((m: string) => console.log(m));
  const filter = { org: options.org, connector: options.connector };

  const currentRowsBefore = await countCurrentRows(sql, filter);

  const groups = await findDuplicateGroups(sql, filter);
  log(
    `Found ${groups.length} duplicate group(s) ` +
      `(${options.org ? `org=${options.org} ` : ""}` +
      `${options.connector ? `connector=${options.connector} ` : ""}` +
      `mode=${options.execute ? "EXECUTE" : "DRY-RUN"})`
  );

  // Plan every group up front so the dry-run total includes ancestor rows.
  const allPlans: PlannedGroup[] = [];
  for (let i = 0; i < groups.length; i += options.batchSize) {
    const slice = groups.slice(i, i + options.batchSize);
    const planned = await planBatch(sql, slice);
    allPlans.push(...planned);
  }

  // Per (org, connector_key) aggregation for the report.
  const perKey = new Map<
    string,
    {
      organization_id: string;
      connector_key: string | null;
      duplicateGroups: number;
      deletes: number;
    }
  >();
  let totalDeletes = 0;
  for (const plan of allPlans) {
    const key = `${plan.group.organization_id} ${plan.group.connector_key ?? ""}`;
    const entry = perKey.get(key) ?? {
      organization_id: plan.group.organization_id,
      connector_key: plan.group.connector_key,
      duplicateGroups: 0,
      deletes: 0,
    };
    entry.duplicateGroups += 1;
    entry.deletes += plan.deleteIds.length;
    perKey.set(key, entry);
    totalDeletes += plan.deleteIds.length;
  }

  const perOrgConnector = [...perKey.values()].sort(
    (a, b) =>
      a.organization_id.localeCompare(b.organization_id) ||
      (a.connector_key ?? "").localeCompare(b.connector_key ?? "")
  );

  for (const entry of perOrgConnector) {
    log(
      `  org=${entry.organization_id} connector=${entry.connector_key ?? "<null>"}: ` +
        `${entry.duplicateGroups} dup group(s), ${entry.deletes} row(s) to delete`
    );
  }
  log(
    `GRAND TOTAL: ${allPlans.length} duplicate group(s), ` +
      `${totalDeletes} row(s) ${options.execute ? "to delete" : "WOULD be deleted"}`
  );

  let executedDeletes = 0;
  if (options.execute && allPlans.length > 0) {
    let done = 0;
    for (let i = 0; i < allPlans.length; i += options.batchSize) {
      const batch = allPlans.slice(i, i + options.batchSize);
      const deleted = await executeBatch(sql, batch);
      executedDeletes += deleted;
      done += batch.length;
      log(
        `  [progress] ${done}/${allPlans.length} group(s) processed, ` +
          `${executedDeletes} row(s) deleted so far`
      );
    }
  }

  const currentRowsAfter = await countCurrentRows(sql, filter);
  log(`Current rows: before=${currentRowsBefore} after=${currentRowsAfter}`);

  return {
    duplicateGroups: allPlans.length,
    totalGroupsScanned: groups.length,
    totalDeletes,
    perOrgConnector,
    executed: options.execute,
    currentRowsBefore,
    currentRowsAfter,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): DedupOptions {
  const opts: DedupOptions = { execute: false, batchSize: 100 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--execute":
        opts.execute = true;
        break;
      case "--org":
        opts.org = argv[++i];
        break;
      case "--connector":
        opts.connector = argv[++i];
        break;
      case "--batch-size": {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `--batch-size must be a positive integer, got: ${raw}`
          );
        }
        opts.batchSize = n;
        break;
      }
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: bun run scripts/dedup-events.ts [options]",
            "",
            "Options:",
            "  --execute            Actually delete (default: dry-run report only)",
            "  --org <id>           Limit to one organization_id",
            "  --connector <key>    Limit to one connector_key",
            "  --batch-size <n>     Groups per transaction (default: 100)",
            "  -h, --help           Show this help",
          ].join("\n")
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const sql = getDb();
  try {
    const report = await dedupEvents({ ...opts, db: sql });
    if (!opts.execute && report.totalDeletes > 0) {
      console.log("\nDRY-RUN only — re-run with --execute to apply.");
    }
  } finally {
    await sql.end?.();
  }
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error("[dedup-events] FAILED:", err);
    process.exit(1);
  });
}
