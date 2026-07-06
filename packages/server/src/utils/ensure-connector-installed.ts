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
import {
  type ConnectorInstallResult,
  upsertConnectorDefinitionRecords,
} from './connector-definition-install';
import { computeCodeHash } from './compiler-core';
import logger from './logger';

/**
 * Resolve compiled connector code at runtime.
 *
 * Resolution order:
 * 1. Org-installed `compiled_code` from `connector_versions` (via
 *    `install_connector` / `source_url` / `source_code`) — an explicit
 *    per-org override must beat the bundled registry copy.
 * 2. Bundled source on disk (recompiled on demand; mtime-cached).
 *
 * Bundled-only connectors never populate `compiled_code` on their version row
 * (`upsertBundledConnectorForOrg` stores `source_path` instead), so the
 * bundled path still runs for the default registry.
 */
export async function resolveConnectorCode(
  connectorKey: string,
  compiledCode: string | null
): Promise<string> {
  if (compiledCode) return compiledCode;
  const filePath = findBundledConnectorFile(connectorKey);
  if (filePath) return compileConnectorFromFile(filePath);
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
 * Returns null when the key has no bundled source on disk (a genuinely
 * user-uploaded connector — nothing to sync from). Throws on
 * compile/extract/validate/write failure; callers decide how to handle it.
 */
export async function upsertBundledConnectorForOrg(params: {
  organizationId: string;
  connectorKey: string;
}): Promise<ConnectorInstallResult | null> {
  const filePath = findBundledConnectorFile(params.connectorKey);
  if (!filePath) return null;

  // Compile to extract metadata (key, name, feeds, auth schema, etc.).
  const compiledCode = await compileConnectorFromFile(filePath);
  const metadata = await extractConnectorMetadata(compiledCode);
  validateConnectorMetadata(metadata);

  const sourcePath = bundledConnectorSourcePath(filePath);
  const { updated } = await upsertConnectorDefinitionRecords({
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
  return {
    connectorKey: metadata.key,
    name: metadata.name,
    version: metadata.version,
    codeHash: computeCodeHash(compiledCode),
    updated,
    authSchema: metadata.authSchema ?? null,
    mcpConfig: metadata.mcpConfig ?? null,
    openapiConfig: metadata.openapiConfig ?? null,
  };
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
