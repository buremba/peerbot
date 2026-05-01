import { createHash } from 'node:crypto';
import { getLoginProviderScopes } from '../../auth/config';
import { getDb } from '../../db/client';
import { probeMcpServer } from '../../mcp-proxy/client';
import {
  type ConnectorInstallResult,
  resolveConnectorInstallSource,
  upsertConnectorDefinitionRecords,
} from '../../utils/connector-definition-install';
import logger from '../../utils/logger';

type AuthSchema =
  | { methods?: Array<Record<string, unknown>> }
  | Record<string, unknown>
  | null
  | undefined;

type OAuthAuthMethod = {
  type: 'oauth';
  provider: string;
  loginScopes?: string[];
};

export type ScopedConnectorDefinitionRow = {
  id?: number;
  key: string;
  name: string;
  description: string | null;
  version: string;
  auth_schema: AuthSchema;
  feeds_schema: Record<string, unknown> | null;
  actions_schema: Record<string, unknown> | null;
  options_schema: Record<string, unknown> | null;
  mcp_config?: Record<string, unknown> | null;
  openapi_config?: Record<string, unknown> | null;
  favicon_domain?: string | null;
  source_path?: string | null;
  default_connection_config?: Record<string, unknown> | null;
  default_repair_agent_id?: string | null;
  status: string;
  login_enabled?: boolean | null;
  created_at?: string;
  updated_at?: string;
};

function getOAuthMethods(authSchema: AuthSchema | string): OAuthAuthMethod[] {
  const parsedAuthSchema =
    typeof authSchema === 'string'
      ? (() => {
          try {
            return JSON.parse(authSchema) as { methods?: unknown };
          } catch {
            return null;
          }
        })()
      : authSchema;

  const methods = (parsedAuthSchema as { methods?: unknown } | null)?.methods;
  if (!Array.isArray(methods)) return [];

  return methods.filter(
    (method): method is OAuthAuthMethod =>
      typeof method === 'object' &&
      method !== null &&
      (method as { type?: unknown }).type === 'oauth' &&
      typeof (method as { provider?: unknown }).provider === 'string'
  );
}

export async function listScopedConnectorDefinitions(params: {
  organizationId: string;
}): Promise<ScopedConnectorDefinitionRow[]> {
  const sql = getDb();

  const rows = await sql`
    SELECT
      d.key,
      d.name,
      d.description,
      d.version,
      d.auth_schema,
      d.feeds_schema,
      d.actions_schema,
      d.options_schema,
      d.mcp_config,
      d.openapi_config,
      d.favicon_domain,
      d.default_connection_config,
      d.default_repair_agent_id,
      d.status,
      d.login_enabled,
      d.created_at,
      d.updated_at,
      cv.source_path
    FROM connector_definitions d
    LEFT JOIN connector_versions cv ON cv.connector_key = d.key AND cv.version = d.version
    WHERE d.status = 'active'
      AND d.organization_id = ${params.organizationId}
    ORDER BY d.name ASC
  `;

  return rows as unknown as ScopedConnectorDefinitionRow[];
}

export async function getScopedConnectorDefinition(params: {
  organizationId: string;
  connectorKey: string;
}): Promise<ScopedConnectorDefinitionRow | null> {
  const sql = getDb();

  const rows = await sql`
    SELECT *
    FROM connector_definitions
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  return (rows[0] as ScopedConnectorDefinitionRow | undefined) ?? null;
}

export async function installConnectorDefinitionFromSource(params: {
  organizationId: string;
  sourceUrl?: string;
  sourceUri?: string;
  sourceCode?: string;
  compiled?: boolean;
}): Promise<ConnectorInstallResult> {
  const sql = getDb();
  const resolved = await resolveConnectorInstallSource({
    sourceUrl: params.sourceUrl,
    sourceUri: params.sourceUri,
    sourceCode: params.sourceCode,
    compiled: params.compiled,
  });
  const { updated } = await upsertConnectorDefinitionRecords({
    sql,
    organizationId: params.organizationId,
    metadata: resolved.metadata,
    versionRecord: {
      compiledCode: resolved.compiledCode,
      compiledCodeHash: resolved.compiledCodeHash,
      sourceCode: resolved.sourceCode,
      sourcePath: resolved.sourcePath,
    },
  });

  logger.info(
    {
      connector_key: resolved.metadata.key,
      version: resolved.metadata.version,
    },
    'Connector installed from source'
  );

  return {
    connectorKey: resolved.metadata.key,
    name: resolved.metadata.name,
    version: resolved.metadata.version,
    codeHash: resolved.compiledCodeHash,
    updated,
    authSchema: resolved.metadata.authSchema ?? null,
    mcpConfig: resolved.metadata.mcpConfig ?? null,
    openapiConfig: resolved.metadata.openapiConfig ?? null,
  };
}

export async function installConnectorFromMcpUrl(params: {
  organizationId: string;
  mcpUrl: string;
}): Promise<ConnectorInstallResult> {
  const sql = getDb();
  const probed = await probeMcpServer(params.mcpUrl);

  const serverName = probed.serverInfo.name || new URL(params.mcpUrl).hostname;
  const connectorKey = `mcp.${serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;
  const toolPrefix = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const metadata = {
    key: connectorKey,
    name: serverName,
    description: probed.instructions,
    version: probed.serverInfo.version || '0.0.0',
    authSchema: null,
    feeds: null,
    actions: null,
    optionsSchema: null,
    faviconDomain: (() => {
      try {
        return new URL(params.mcpUrl).hostname;
      } catch {
        return null;
      }
    })(),
    mcpConfig: { upstream_url: params.mcpUrl, tool_prefix: toolPrefix },
  };

  const { updated } = await upsertConnectorDefinitionRecords({
    sql,
    organizationId: params.organizationId,
    metadata,
    versionRecord: {
      compiledCode: null,
      compiledCodeHash: null,
      sourceCode: null,
      sourcePath: null,
    },
  });

  // Clear stale compiled code if overwriting a source-based connector.
  if (updated) {
    await sql`
      UPDATE connector_versions
      SET compiled_code = NULL, compiled_code_hash = NULL,
          source_code = NULL, source_path = NULL
      WHERE connector_key = ${connectorKey} AND version = ${metadata.version}
    `;
  }

  logger.info(
    {
      connector_key: connectorKey,
      version: metadata.version,
      tool_count: probed.tools.length,
    },
    'Connector installed from MCP URL'
  );

  return {
    connectorKey,
    name: metadata.name,
    version: metadata.version,
    codeHash: createHash('sha256').update(params.mcpUrl).digest('hex').slice(0, 16),
    updated,
    authSchema: null,
    mcpConfig: metadata.mcpConfig,
  };
}

export async function uninstallConnectorDefinition(params: {
  organizationId: string;
  connectorKey: string;
}): Promise<boolean> {
  const sql = getDb();

  // Block uninstall while ANY non-deleted connection references the connector.
  // Filtering on `status = 'active'` alone let pending_auth connections slip
  // through during an in-flight OAuth flow: uninstall would succeed mid-flow
  // and the callback would later activate the connection, leaving an active
  // connection with no matching connector_definitions row.
  const blockingConns = await sql`
    SELECT COUNT(*)::int AS count
    FROM connections
    WHERE connector_key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
      AND deleted_at IS NULL
  `;

  const count = Number((blockingConns[0] as { count: number }).count);
  if (count > 0) {
    throw new Error(
      `Cannot uninstall connector '${params.connectorKey}': ${count} connection(s) still reference it. Delete them first.`
    );
  }

  const archived = await sql`
    UPDATE connector_definitions
    SET status = 'archived', updated_at = NOW()
    WHERE key = ${params.connectorKey}
      AND status = 'active'
      AND organization_id = ${params.organizationId}
    RETURNING key
  `;

  return archived.length > 0;
}

export async function toggleConnectorLoginEnabled(params: {
  organizationId: string;
  connectorKey: string;
  enabled: boolean;
}): Promise<ScopedConnectorDefinitionRow | null> {
  const sql = getDb();

  const connector = await getScopedConnectorDefinition({
    organizationId: params.organizationId,
    connectorKey: params.connectorKey,
  });

  if (!connector) {
    return null;
  }

  if (connector.status !== 'active') {
    throw new Error(`Connector is ${connector.status}, must be active to be a login provider`);
  }

  const oauthMethods = getOAuthMethods(connector.auth_schema);
  if (oauthMethods.length === 0) {
    throw new Error('Connector must have an OAuth auth method to be a login provider');
  }

  const providers = [
    ...new Set(oauthMethods.map((method) => method.provider.trim().toLowerCase())),
  ];
  if (providers.length !== 1) {
    throw new Error('Connector must expose exactly one OAuth provider to be a login provider');
  }

  const loginMethod = oauthMethods[0];
  const provider = loginMethod?.provider?.trim().toLowerCase();
  if (!provider || !getLoginProviderScopes(provider, loginMethod.loginScopes)) {
    throw new Error(
      `OAuth provider '${provider ?? 'unknown'}' cannot be used as a login provider: ` +
        `the connector's oauth method must declare 'loginScopes'.`
    );
  }

  if (params.enabled) {
    const rows = await sql`
      SELECT key, auth_schema
      FROM connector_definitions
      WHERE login_enabled = true
        AND status = 'active'
        AND organization_id = ${params.organizationId}
        AND key <> ${params.connectorKey}
    `;

    const conflictingConnectors = rows
      .filter((row) => {
        const rowProviders = new Set(
          getOAuthMethods((row as { auth_schema: AuthSchema }).auth_schema).map((method) =>
            method.provider.trim().toLowerCase()
          )
        );
        return rowProviders.has(provider);
      })
      .map((row) => String((row as { key: string }).key));

    if (conflictingConnectors.length > 0) {
      throw new Error(
        `Login provider '${provider}' is already enabled on connector(s): ${conflictingConnectors.join(', ')}. ` +
          'Disable the existing connector first.'
      );
    }
  }

  await sql`
    UPDATE connector_definitions
    SET login_enabled = ${params.enabled}, updated_at = NOW()
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
  `;

  return connector;
}
