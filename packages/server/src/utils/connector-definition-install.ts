import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { getDb } from '../db/client';
import { computeCodeHash } from './compiler-core';
import {
  compileConnectorFromFile,
  getDefaultConnectorCatalogDir,
  normalizeFileSourceUri,
  resolveFileSourcePath,
} from './connector-catalog';
import {
  type ConnectorMetadata,
  compileConnectorSource,
  extractConnectorMetadata,
  validateConnectorMetadata,
} from './connector-compiler';

type SqlClient = ReturnType<typeof getDb>;

export type ConnectorInstallResult = {
  connectorKey: string;
  name: string;
  version: string;
  codeHash: string;
  updated: boolean;
  authSchema: Record<string, unknown> | null;
  mcpConfig?: Record<string, unknown> | null;
  openapiConfig?: Record<string, unknown> | null;
};

type ConnectorVersionPersistence = {
  compiledCode: string | null;
  compiledCodeHash: string | null;
  sourceCode: string | null;
  sourcePath: string | null;
};

type ResolvedConnectorInstallSource = Omit<
  ConnectorVersionPersistence,
  'compiledCode' | 'compiledCodeHash' | 'sourceCode'
> & {
  compiledCode: string;
  compiledCodeHash: string;
  sourceCode: string;
  metadata: ConnectorMetadata;
};

/**
 * Detect whether source code is already compiled JavaScript (not TypeScript).
 * Checks for common esbuild/CJS output markers and absence of TypeScript syntax.
 */
function isPreCompiledJs(code: string): boolean {
  const trimmed = code.trimStart();

  if (
    trimmed.startsWith('"use strict"') ||
    trimmed.startsWith("'use strict'") ||
    trimmed.startsWith('var __defProp') ||
    trimmed.startsWith('var __getOwnPropNames') ||
    trimmed.startsWith('// src/')
  ) {
    return true;
  }

  if (trimmed.startsWith('import { createRequire')) {
    return true;
  }

  return false;
}

export function connectorSourcePathToUri(sourcePath?: string | null): string | null {
  if (!sourcePath) return null;

  if (sourcePath.includes('://')) {
    return normalizeFileSourceUri(sourcePath);
  }

  if (isAbsolute(sourcePath) && existsSync(sourcePath)) {
    return pathToFileURL(sourcePath).toString();
  }

  const bundledSourcePath = resolve(getDefaultConnectorCatalogDir(), sourcePath);
  if (existsSync(bundledSourcePath)) {
    return pathToFileURL(bundledSourcePath).toString();
  }

  return null;
}

// Hosts a connector's `source_url` may be fetched from out of the box. Installing
// from a URL fetches + compiles + runs remote code, so it must be locked down to
// known-good sources. Extend per-deployment via CONNECTOR_SOURCE_ALLOWLIST.
const DEFAULT_CONNECTOR_SOURCE_HOSTS = [
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.com',
];

const MAX_CONNECTOR_SOURCE_BYTES = 5 * 1024 * 1024;
const CONNECTOR_SOURCE_FETCH_TIMEOUT_MS = 30_000;

/** Block loopback/private/link-local hosts to prevent SSRF (e.g. cloud metadata 169.254.169.254). */
function isBlockedSourceHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h === '0.0.0.0') {
    return true;
  }
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function allowedConnectorSourceHosts(): string[] {
  const extra = (process.env.CONNECTOR_SOURCE_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_CONNECTOR_SOURCE_HOSTS, ...extra];
}

/**
 * Validate a connector `source_url` before fetching: https only, no
 * private/loopback hosts (SSRF), and host on the allowlist. `CONNECTOR_SOURCE_ALLOWLIST`
 * adds hosts (`.example.com` matches subdomains); `*` allows any public host.
 * Note: redirects are followed, so the SSRF guard binds the initial host — keep
 * `*` for trusted environments only.
 */
function assertAllowedConnectorSourceUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid source_url: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`source_url must use https (got '${url.protocol || rawUrl}').`);
  }
  if (isBlockedSourceHost(url.hostname)) {
    throw new Error(
      `source_url host '${url.hostname}' is blocked (private/loopback/link-local address).`
    );
  }
  const allow = allowedConnectorSourceHosts();
  if (allow.includes('*')) return url;
  const host = url.hostname.toLowerCase();
  const ok = allow.some((entry) =>
    entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : host === entry
  );
  if (!ok) {
    throw new Error(
      `source_url host '${host}' is not in the connector source allowlist (${allow.join(', ')}). ` +
        `Set CONNECTOR_SOURCE_ALLOWLIST to add hosts, or '*' to allow any public host.`
    );
  }
  return url;
}

export async function resolveConnectorInstallSource(params: {
  sourceUrl?: string;
  sourceUri?: string;
  sourceCode?: string;
  compiled?: boolean;
}): Promise<ResolvedConnectorInstallSource> {
  let sourceCode: string;
  let sourcePath: string | null = null;

  if (params.sourceUri) {
    const filePath = resolveFileSourcePath(params.sourceUri);
    if (!filePath) {
      throw new Error(
        `Unsupported source_uri '${params.sourceUri}'. Only local file URIs are supported.`
      );
    }

    sourcePath = filePath;
    sourceCode = await readFile(filePath, 'utf-8');
  } else if (params.sourceUrl) {
    const url = assertAllowedConnectorSourceUrl(params.sourceUrl);
    sourcePath = url.pathname.replace(/^\//, '') || null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECTOR_SOURCE_FETCH_TIMEOUT_MS);
    let sourceResponse: Response;
    try {
      sourceResponse = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!sourceResponse.ok) {
      throw new Error(`Failed to fetch source from ${url.toString()}: ${sourceResponse.status}`);
    }
    const declaredLength = Number(sourceResponse.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CONNECTOR_SOURCE_BYTES) {
      throw new Error(
        `Connector source too large: ${declaredLength} bytes (max ${MAX_CONNECTOR_SOURCE_BYTES}).`
      );
    }
    sourceCode = await sourceResponse.text();
    if (Buffer.byteLength(sourceCode) > MAX_CONNECTOR_SOURCE_BYTES) {
      throw new Error(`Connector source too large (max ${MAX_CONNECTOR_SOURCE_BYTES} bytes).`);
    }
  } else if (params.sourceCode) {
    sourceCode = params.sourceCode;
  } else {
    throw new Error('Provide source_url or source_code to install a connector.');
  }

  const alreadyCompiled = params.compiled || isPreCompiledJs(sourceCode);

  let compiledCode: string;
  let compiledCodeHash: string;

  if (alreadyCompiled) {
    compiledCode = sourceCode;
    compiledCodeHash = computeCodeHash(sourceCode);
  } else if (params.sourceUri && sourcePath) {
    compiledCode = await compileConnectorFromFile(sourcePath);
    compiledCodeHash = computeCodeHash(compiledCode);
  } else {
    const compiled = await compileConnectorSource(sourceCode);
    compiledCode = compiled.compiledCode;
    compiledCodeHash = compiled.compiledCodeHash;
  }

  const metadata = await extractConnectorMetadata(compiledCode);
  validateConnectorMetadata(metadata);

  return {
    metadata,
    sourceCode,
    sourcePath,
    compiledCode,
    compiledCodeHash,
  };
}

export async function upsertConnectorDefinitionRecords(params: {
  sql: SqlClient;
  organizationId: string;
  metadata: ConnectorMetadata;
  versionRecord: ConnectorVersionPersistence;
}): Promise<{ updated: boolean }> {
  const { sql } = params;
  const { metadata } = params;

  const existing = await sql`
    SELECT id, status, login_enabled
    FROM connector_definitions
    WHERE key = ${metadata.key}
      AND organization_id = ${params.organizationId}
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      updated_at DESC,
      id DESC
    LIMIT 1
  `;

  const existingRow = existing[0] as
    | { id: number; status: string; login_enabled: boolean }
    | undefined;
  const preservedLoginEnabled = existingRow?.login_enabled ?? false;

  const authSchemaJson = metadata.authSchema ? sql.json(metadata.authSchema) : null;
  const feedsSchemaJson = metadata.feeds ? sql.json(metadata.feeds) : null;
  const actionsSchemaJson = metadata.actions ? sql.json(metadata.actions) : null;
  const optionsSchemaJson = metadata.optionsSchema ? sql.json(metadata.optionsSchema) : null;
  const mcpConfigJson = metadata.mcpConfig ? sql.json(metadata.mcpConfig) : null;
  const openapiConfigJson = metadata.openapiConfig ? sql.json(metadata.openapiConfig) : null;
  const runtimeJson = metadata.runtime ? sql.json(metadata.runtime) : null;

  if (existingRow?.status === 'active') {
    await sql`
      UPDATE connector_definitions
      SET name = ${metadata.name},
          description = ${metadata.description ?? null},
          version = ${metadata.version},
          auth_schema = ${authSchemaJson},
          feeds_schema = ${feedsSchemaJson},
          actions_schema = ${actionsSchemaJson},
          options_schema = ${optionsSchemaJson},
          mcp_config = ${mcpConfigJson},
          openapi_config = ${openapiConfigJson},
          favicon_domain = ${metadata.faviconDomain ?? null},
          required_capability = ${metadata.requiredCapability ?? null},
          runtime = ${runtimeJson},
          login_enabled = ${preservedLoginEnabled},
          updated_at = NOW()
      WHERE id = ${existingRow.id}
    `;
  } else {
    await sql`
      INSERT INTO connector_definitions (
        organization_id, key, name, description, version,
        auth_schema, feeds_schema, actions_schema, options_schema,
        mcp_config, openapi_config, favicon_domain, required_capability,
        runtime, status, login_enabled
      ) VALUES (
        ${params.organizationId}, ${metadata.key}, ${metadata.name},
        ${metadata.description ?? null}, ${metadata.version},
        ${authSchemaJson}, ${feedsSchemaJson}, ${actionsSchemaJson}, ${optionsSchemaJson},
        ${mcpConfigJson}, ${openapiConfigJson},
        ${metadata.faviconDomain ?? null}, ${metadata.requiredCapability ?? null},
        ${runtimeJson}, 'active', ${preservedLoginEnabled}
      )
    `;
  }

  await sql`
    INSERT INTO connector_versions (
      connector_key, version, compiled_code, compiled_code_hash,
      source_code, source_path
    ) VALUES (
      ${metadata.key}, ${metadata.version}, ${params.versionRecord.compiledCode},
      ${params.versionRecord.compiledCodeHash}, ${params.versionRecord.sourceCode},
      ${params.versionRecord.sourcePath}
    )
    ON CONFLICT (connector_key, version) DO UPDATE
    SET compiled_code = COALESCE(EXCLUDED.compiled_code, connector_versions.compiled_code),
        compiled_code_hash = COALESCE(
          EXCLUDED.compiled_code_hash,
          connector_versions.compiled_code_hash
        ),
        source_code = COALESCE(EXCLUDED.source_code, connector_versions.source_code),
        source_path = COALESCE(EXCLUDED.source_path, connector_versions.source_path)
  `;

  return { updated: existingRow?.status === 'active' };
}
