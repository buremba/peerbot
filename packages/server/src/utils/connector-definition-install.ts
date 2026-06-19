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
import { isInternalUrl } from '../gateway/proxy/ssrf-guard';

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
const MAX_CONNECTOR_SOURCE_REDIRECTS = 5;

function allowedConnectorSourceHosts(): string[] {
  const extra = (process.env.CONNECTOR_SOURCE_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_CONNECTOR_SOURCE_HOSTS, ...extra];
}

/**
 * Validate a connector `source_url` before fetching: https only, host on the
 * allowlist, and not resolving to a private/loopback/reserved address (SSRF).
 * `CONNECTOR_SOURCE_ALLOWLIST` adds hosts (`.example.com` matches subdomains);
 * `*` allows any public host (the SSRF/DNS check still applies). Async because
 * the SSRF guard resolves DNS. Re-run on every redirect hop by the fetcher.
 */
async function assertAllowedConnectorSourceUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid source_url: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`source_url must use https (got '${url.protocol || rawUrl}').`);
  }
  const allow = allowedConnectorSourceHosts();
  if (!allow.includes('*')) {
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
  }
  // DNS-resolving check: catches IP literals (incl. IPv4-mapped IPv6) AND
  // hostnames that resolve to reserved/private ranges (DNS-rebinding).
  if (await isInternalUrl(url.toString())) {
    throw new Error(
      `source_url host '${url.hostname}' is blocked (resolves to a private/loopback/reserved address).`
    );
  }
  return url;
}

/** Read a response body, aborting as soon as it exceeds the byte cap (content-length can lie / be absent). */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Connector source too large (max ${maxBytes} bytes).`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Fetch connector source with a single timeout covering the whole exchange
 * (headers + body), manual redirect following that re-validates EVERY hop with
 * the same scheme/allowlist/SSRF checks, and a streaming byte cap.
 */
async function fetchConnectorSource(initialUrl: URL): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTOR_SOURCE_FETCH_TIMEOUT_MS);
  try {
    let url = initialUrl;
    for (let hop = 0; hop <= MAX_CONNECTOR_SOURCE_REDIRECTS; hop++) {
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`Redirect from ${url.toString()} had no Location header.`);
        url = await assertAllowedConnectorSourceUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) {
        throw new Error(`Failed to fetch source from ${url.toString()}: ${res.status}`);
      }
      const declaredLength = Number(res.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_CONNECTOR_SOURCE_BYTES) {
        throw new Error(
          `Connector source too large: ${declaredLength} bytes (max ${MAX_CONNECTOR_SOURCE_BYTES}).`
        );
      }
      return await readBodyWithCap(res, MAX_CONNECTOR_SOURCE_BYTES);
    }
    throw new Error(
      `Too many redirects fetching connector source (max ${MAX_CONNECTOR_SOURCE_REDIRECTS}).`
    );
  } finally {
    clearTimeout(timeout);
  }
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
    const url = await assertAllowedConnectorSourceUrl(params.sourceUrl);
    sourcePath = url.pathname.replace(/^\//, '') || null;
    sourceCode = await fetchConnectorSource(url);
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
