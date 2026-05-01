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
 * If compiledCode is already available, returns it directly.
 * Otherwise, compiles from the bundled source file on disk.
 */
export async function resolveConnectorCode(
  connectorKey: string,
  compiledCode: string | null
): Promise<string> {
  if (compiledCode) return compiledCode;
  const filePath = findBundledConnectorFile(connectorKey);
  if (!filePath) {
    throw new Error(`No compiled code for '${connectorKey}' and source not found on disk.`);
  }
  return compileConnectorFromFile(filePath);
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
