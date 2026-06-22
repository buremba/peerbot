/**
 * Scheduled Job: Refresh built-in connector definitions.
 *
 * `connector_definitions` rows are per-org point-in-time SNAPSHOTS of a
 * connector's code-defined schema, written once when the org first adds the
 * connector (`ensureConnectorInstalled`, which inserts only when no active row
 * exists and never re-syncs an existing one). So when a bundled connector's code
 * gains a capability — e.g. github gaining the `app_installation` auth method —
 * orgs that installed it earlier keep the STALE schema. The GitHub App install
 * callback then rejects with `github_connector_missing` because the org's
 * `auth_schema` still lists only `[oauth, env_keys]` (see
 * `gateway/routes/public/app-install.ts` hasAppInstallMethod).
 *
 * This task re-syncs every org's EXISTING built-in definition through the SAME
 * code→`connector_definitions` write path the install flow uses
 * (`upsertBundledConnectorForOrg` — there is no second writer): for each
 * `(organization_id, key)` that already has an active definition, recompile the
 * bundled source and upsert by `(organization_id, key)`. It is purely a refresh
 * — it never installs a connector into an org that didn't already have it (the
 * shared writer is only invoked for keys an org already holds).
 *
 * Idempotent: a no-op once every row already matches code (the UPDATE just
 * rewrites identical JSON). Org-specific config is preserved by the shared
 * upsert (`login_enabled` re-read and written back; `default_connection_config`
 * never touched).
 *
 * Multi-replica: runs as a single-claimant cron row in the runs queue (one pod
 * per tick), reads/writes Postgres only, no per-pod state. Fires on the first
 * scheduler tick after a deploy, so a schema-changing release converges without
 * an operator step.
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
