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

import { basename } from 'node:path';
import { getDb } from '../db/client';
import { compileConnectorFromFile, findBundledConnectorFile } from './connector-catalog';
import { extractConnectorMetadata } from './connector-compiler';
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

  const filePath = findBundledConnectorFile(params.connectorKey);
  if (!filePath) return false;

  try {
    // Compile temporarily to extract metadata (key, name, feeds, etc.)
    const compiledCode = await compileConnectorFromFile(filePath);
    const metadata = await extractConnectorMetadata(compiledCode);

    if (!metadata.key || !metadata.name || !metadata.version) {
      throw new Error('Connector must have key, name, and version.');
    }

    const sourcePath = basename(filePath);
    await upsertConnectorDefinitionRecords({
      sql,
      organizationId: params.organizationId,
      metadata,
      versionRecord: {
        compiledCode: null,
        compiledCodeHash: null,
        sourceCode: null,
        sourcePath,
      },
    });

    logger.info(
      {
        connector_key: params.connectorKey,
        organization_id: params.organizationId,
        source_path: sourcePath,
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
