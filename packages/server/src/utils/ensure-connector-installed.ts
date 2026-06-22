/**
 * Auto-install a bundled connector into an org on first use.
 *
 * Looks up connectors/{key}.ts on disk (dots in key become underscores),
 * compiles from the real file path so relative imports resolve, extracts
 * metadata, and installs the definition + version row.
 *
 * compiled_code is NOT stored — at runtime the source is compiled on demand
 * from source_path, so edits to .ts files take effect without reinstalling.
 */

import { getDb } from '../db/client';
import {
  bundledConnectorSourcePath,
  compileConnectorFromFile,
  findBundledConnectorFile,
} from './connector-catalog';
import { extractConnectorMetadata, validateConnectorMetadata } from './connector-compiler';
import { upsertConnectorDefinitionRecords } from './connector-definition-install';
import logger from './logger';

/**
 * Resolve compiled connector code at runtime.
 *
 * If the connector ships as a bundled source file on disk, that file is the
 * source of truth — recompile from it and IGNORE any persisted `compiled_code`.
 * A persisted artifact is only ever produced by an older server build (e.g.
 * before `pino` was bundled instead of externalised); trusting it would shadow
 * the up-to-date source indefinitely and break feed sync. The recompile is
 * cheap because `compileConnectorFromFile` caches by mtime.
 *
 * Only connectors with no on-disk source (genuinely user-uploaded via
 * `source_code` / `source_url`) fall back to the persisted `compiled_code`.
 */
export async function resolveConnectorCode(
  connectorKey: string,
  compiledCode: string | null
): Promise<string> {
  const filePath = findBundledConnectorFile(connectorKey);
  if (filePath) return compileConnectorFromFile(filePath);
  if (compiledCode) return compiledCode;
  throw new Error(`No compiled code for '${connectorKey}' and source not found on disk.`);
}

/**
 * Compile the bundled connector for `connectorKey` and upsert its definition for
 * one org from the on-disk registry: the single code→`connector_definitions`
 * write path. `ensureConnectorInstalled` calls it on first install;
 * `refreshConnectorDefinitions` calls it to re-sync an org's existing definition
 * across deploys. Both share THIS body — there is no second writer.
 *
 * Stores `source_path` (not `compiled_code`) so the runtime recompiles from
 * source on demand (`resolveConnectorCode`); the shared upsert preserves
 * org-specific config (`login_enabled`, `default_connection_config`).
 *
 * Returns false when the key has no bundled source on disk (a genuinely
 * user-uploaded connector — nothing to sync from). Throws on
 * compile/extract/validate/write failure; callers decide how to handle it.
 */
export async function upsertBundledConnectorForOrg(params: {
  organizationId: string;
  connectorKey: string;
}): Promise<boolean> {
  const filePath = findBundledConnectorFile(params.connectorKey);
  if (!filePath) return false;

  // Compile to extract metadata (key, name, feeds, auth schema, etc.).
  const compiledCode = await compileConnectorFromFile(filePath);
  const metadata = await extractConnectorMetadata(compiledCode);
  validateConnectorMetadata(metadata);

  const sourcePath = bundledConnectorSourcePath(filePath);
  await upsertConnectorDefinitionRecords({
    sql: getDb(),
    organizationId: params.organizationId,
    metadata,
    versionRecord: {
      compiledCode: null,
      compiledCodeHash: null,
      sourceCode: null,
      sourcePath,
    },
  });
  return true;
}

export async function ensureConnectorInstalled(params: {
  organizationId: string;
  connectorKey: string;
}): Promise<boolean> {
  const sql = getDb();
  const existing = await sql`
    SELECT 1 FROM connector_definitions
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
      AND status = 'active'
    LIMIT 1
  `;
  if (existing.length > 0) return true;

  try {
    const installed = await upsertBundledConnectorForOrg(params);
    if (!installed) return false;
    logger.info(
      {
        connector_key: params.connectorKey,
        organization_id: params.organizationId,
      },
      'Auto-installed bundled connector for org (source_path only, no compiled_code)'
    );
    return true;
  } catch (err) {
    logger.error(
      { connector_key: params.connectorKey, err },
      'Failed to auto-install bundled connector'
    );
    return false;
  }
}
