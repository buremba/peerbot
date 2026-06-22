/**
 * `connector_definitions` are per-org snapshots written once at install and
 * never re-synced, so a connector gaining a capability in code (e.g. github's
 * `app_installation` auth method) leaves earlier installers on a stale schema.
 * This single-claimant cron re-syncs every org's EXISTING built-in definition
 * through the install write path so a deploy converges without an operator step.
 */

import { getDb } from '../db/client';
import { upsertBundledConnectorForOrg } from '../utils/ensure-connector-installed';
import logger from '../utils/logger';

interface RefreshResult {
  /** Distinct (org, key) active definitions considered. */
  scanned: number;
  /** Definitions whose schema was re-synced from code. */
  refreshed: number;
  /** Keys skipped because they have no bundled source on disk (user-uploaded). */
  skippedNoSource: number;
  /** Definitions that errored during recompile/upsert (logged, not fatal). */
  errored: number;
}

interface DefRow {
  organization_id: string;
  key: string;
}

export async function refreshConnectorDefinitions(): Promise<RefreshResult> {
  const sql = getDb();

  // Every (org, key) that currently has an ACTIVE built-in definition. We only
  // refresh what an org already installed — never auto-install a new connector.
  const rows = (await sql`
    SELECT DISTINCT organization_id, key
    FROM connector_definitions
    WHERE status = 'active'
      AND organization_id IS NOT NULL
    ORDER BY key
  `) as unknown as DefRow[];

  const result: RefreshResult = {
    scanned: rows.length,
    refreshed: 0,
    skippedNoSource: 0,
    errored: 0,
  };

  // Keys already known to have no bundled source (genuinely user-uploaded) —
  // skip the repeated registry lookup across the org rows sharing that key.
  const noSourceKeys = new Set<string>();

  for (const row of rows) {
    if (noSourceKeys.has(row.key)) {
      result.skippedNoSource += 1;
      continue;
    }
    try {
      // SAME write path as install (upsertBundledConnectorForOrg): recompile
      // bundled source → upsert this org's definition. compileConnectorFromFile
      // is mtime-LRU-cached, so re-resolving the same key across orgs is cheap.
      const refreshed = await upsertBundledConnectorForOrg({
        organizationId: row.organization_id,
        connectorKey: row.key,
      });
      if (!refreshed) {
        noSourceKeys.add(row.key);
        result.skippedNoSource += 1;
        continue;
      }
      result.refreshed += 1;
    } catch (err) {
      result.errored += 1;
      logger.error(
        { connector_key: row.key, organization_id: row.organization_id, err },
        '[refresh-connector-definitions] Failed to refresh definition for org'
      );
    }
  }

  return result;
}
