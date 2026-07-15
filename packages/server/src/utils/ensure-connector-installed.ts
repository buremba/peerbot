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

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { getDb } from '../db/client';
import {
  bundledConnectorSourcePath,
  compileConnectorFromFile,
  findBundledConnectorFile,
} from './connector-catalog';
import {
  compileConnectorSource,
  extractConnectorMetadata,
  validateConnectorMetadata,
} from './connector-compiler';
import {
  type ConnectorInstallResult,
  upsertConnectorDefinitionRecords,
} from './connector-definition-install';
import { computeCodeHash } from './compiler-core';
import logger from './logger';

/**
 * The `connector_versions` columns every executing reader must select and
 * hand to `resolveConnectorCode`. `compile_config_hash` is the fingerprint of
 * the compile configuration (EXTERNAL_RUNTIME_DEPS + pipeline version) that
 * produced `compiled_code`.
 */
export type StoredConnectorVersion = {
  version: string | null;
  compiled_code: string | null;
  compile_config_hash: string | null;
};

/**
 * Resolve compiled connector code at runtime.
 *
 * Resolution order:
 * 1. Org-installed `compiled_code` from `connector_versions` (via
 *    `install_connector` / `source_url` / `source_code`) — an explicit
 *    per-org override must beat the bundled registry copy — but ONLY when its
 *    `compile_config_hash` matches the current compile configuration. An
 *    artifact compiled under a different externals list may bare-import a
 *    package the runtime image no longer ships (the pino outage), so a stale
 *    artifact is never executed: it is recompiled from the row's stored
 *    `source_code` and the fresh artifact is persisted (Postgres-mediated, so
 *    every replica converges after the first resolution).
 * 2. Bundled source on disk (recompiled on demand; mtime-cached — always
 *    reflects the current compile configuration since the compiler and the
 *    externals list ship in the same image).
 *
 * Bundled-only connectors never populate `compiled_code` on their version row
 * (`upsertBundledConnectorForOrg` stores `source_path` instead), so the
 * bundled path still runs for the default registry.
 */
export async function resolveConnectorCode(
  connectorKey: string,
  stored: StoredConnectorVersion | null
): Promise<string> {
  if (stored?.compiled_code) {
    if (stored.compile_config_hash === COMPILE_CONFIG_HASH) return stored.compiled_code;
    if (stored.version) {
      const recompiled = await recompileStoredConnectorVersion(connectorKey, stored.version);
      if (recompiled) return recompiled;
    }
    // No stored source to recompile from (legacy row) — fall through to the
    // bundled on-disk source; the stale artifact itself must never execute.
  }
  const filePath = findBundledConnectorFile(connectorKey);
  if (filePath) return compileConnectorFromFile(filePath);
  throw new Error(
    stored?.compiled_code
      ? `Compiled artifact for '${connectorKey}' predates the current compile configuration and no source is available to recompile — reinstall the connector.`
      : `No compiled code for '${connectorKey}' and source not found on disk.`
  );
}

/**
 * Fetch the stored artifact row for a connector (a specific `version`, or the
 * most recently created row when omitted) and resolve executable code from it.
 * Shared by the pushdown / webhook / inline-operation paths, which don't carry
 * a version row of their own.
 */
export async function resolveConnectorCodeForKey(
  connectorKey: string,
  version?: string | null
): Promise<string> {
  const sql = getDb();
  const rows = version
    ? await sql`
        SELECT version, compiled_code, compile_config_hash FROM connector_versions
        WHERE connector_key = ${connectorKey} AND version = ${version}
        LIMIT 1
      `
    : await sql`
        SELECT version, compiled_code, compile_config_hash FROM connector_versions
        WHERE connector_key = ${connectorKey}
        ORDER BY created_at DESC
        LIMIT 1
      `;
  return resolveConnectorCode(connectorKey, (rows[0] as StoredConnectorVersion | undefined) ?? null);
}

/**
 * Recompile a stale org-installed artifact from its stored `source_code` and
 * persist the result with the current compile-config fingerprint. Returns
 * null when the row keeps no source (legacy bundled-era rows).
 */
async function recompileStoredConnectorVersion(
  connectorKey: string,
  version: string
): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT source_code FROM connector_versions
    WHERE connector_key = ${connectorKey} AND version = ${version}
    LIMIT 1
  `;
  const sourceCode = (rows[0] as { source_code: string | null } | undefined)?.source_code ?? null;
  if (!sourceCode) return null;

  const { compiledCode, compiledCodeHash } = await compileConnectorSource(sourceCode);
  await sql`
    UPDATE connector_versions
    SET compiled_code = ${compiledCode},
        compiled_code_hash = ${compiledCodeHash},
        compile_config_hash = ${COMPILE_CONFIG_HASH}
    WHERE connector_key = ${connectorKey} AND version = ${version}
  `;
  logger.info(
    { connector_key: connectorKey, version },
    'Recompiled stale connector artifact (compile configuration changed)'
  );
  return compiledCode;
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
      compileConfigHash: null,
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
