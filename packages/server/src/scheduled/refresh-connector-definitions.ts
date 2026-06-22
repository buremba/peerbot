/**
 * Scheduled Job: Refresh built-in connector definitions.
 *
 * `connector_definitions` rows are per-org, point-in-time SNAPSHOTS of a
 * connector's code-defined schema, written once when the org first adds the
 * connector (`ensureConnectorInstalled`, which inserts only when no active row
 * exists and never re-syncs an existing one). So when a bundled connector's code
 * gains a capability — e.g. github gaining the `app_installation` auth method —
 * orgs that installed it earlier keep the STALE schema. The GitHub App install
 * callback then rejects with `github_connector_missing` because the org's
 * `auth_schema` still lists only `[oauth, env_keys]` (see
 * `gateway/routes/public/app-install.ts` hasAppInstallMethod).
 *
 * This task re-syncs every org's existing built-in definition from the on-disk
 * connector registry: for each bundled connector key that some org has an active
 * definition for, recompile the bundled source, extract its metadata, and upsert
 * (`auth_schema`/`feeds_schema`/`actions_schema`/`version`/…) by
 * `(organization_id, key)`. It is purely a refresh — it never installs a
 * connector into an org that didn't already have it.
 *
 * Idempotent: a no-op once every row already matches code (the UPDATE just
 * rewrites identical JSON). Org-specific config is preserved — the shared
 * `upsertConnectorDefinitionRecords` UPDATE re-reads and writes back
 * `login_enabled` and never touches `default_connection_config`.
 *
 * Multi-replica: runs as a single-claimant cron row in the runs queue (one pod
 * per tick), reads/writes Postgres only, no per-pod state. Fires on the first
 * scheduler tick after a deploy, so a schema-changing release converges without
 * an operator step.
 */

import { getDb } from '../db/client';
import {
  compileConnectorFromFile,
  findBundledConnectorFile,
} from '../utils/connector-catalog';
import {
  extractConnectorMetadata,
  validateConnectorMetadata,
} from '../utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../utils/connector-definition-install';
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

  // Compile each bundled connector once per refresh (mtime-cached anyway) and
  // reuse the metadata across every org that has that key. null = no bundled
  // source (genuinely user-uploaded connector) — those carry no code to sync
  // from, so they're left untouched.
  const metadataByKey = new Map<
    string,
    Awaited<ReturnType<typeof extractConnectorMetadata>> | null
  >();

  for (const row of rows) {
    let metadata = metadataByKey.get(row.key);
    if (metadata === undefined) {
      const filePath = findBundledConnectorFile(row.key);
      if (!filePath) {
        metadataByKey.set(row.key, null);
        metadata = null;
      } else {
        try {
          const compiled = await compileConnectorFromFile(filePath);
          metadata = await extractConnectorMetadata(compiled);
          validateConnectorMetadata(metadata);
          metadataByKey.set(row.key, metadata);
        } catch (err) {
          logger.error(
            { connector_key: row.key, err },
            '[refresh-connector-definitions] Failed to compile bundled connector; skipping all orgs for this key'
          );
          metadataByKey.set(row.key, null);
          metadata = null;
        }
      }
    }

    if (!metadata) {
      result.skippedNoSource += 1;
      continue;
    }

    try {
      // Source row is NOT rewritten here (versionRecord all-null): the runtime
      // recompiles bundled connectors from source_path on demand
      // (resolveConnectorCode), so we only need the definition's schema columns
      // re-synced. upsertConnectorDefinitionRecords' connector_versions upsert
      // COALESCEs nulls, leaving any existing version row intact.
      await upsertConnectorDefinitionRecords({
        sql,
        organizationId: row.organization_id,
        metadata,
        versionRecord: {
          compiledCode: null,
          compiledCodeHash: null,
          sourceCode: null,
          sourcePath: null,
        },
      });
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
