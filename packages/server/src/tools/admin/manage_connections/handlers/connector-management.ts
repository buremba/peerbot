/**
 * Connector management action handlers:
 * install_connector, uninstall_connector, toggle_connector_login,
 * update_connector_auth, update_connector_default_config,
 * update_connector_default_repair_agent, set_connector_entity_link_overrides,
 * list_connector_definitions.
 */

import type { Env } from '../../../../index';
import { getDb } from '../../../../db/client';
import { getOperationsSummaryBatch } from '../../../../operations/catalog';
import { normalizeAuthValues } from '../../../../utils/auth-profiles';
import { applyEntityLinkOverrides } from '../../../../utils/entity-link-validation';
import logger from '../../../../utils/logger';
import {
  installConnectorDefinitionFromSource,
  installConnectorFromMcpUrl,
  listScopedConnectorDefinitions,
  toggleConnectorLoginEnabled,
  uninstallConnectorDefinition,
  updateActiveConnectorDefinitionField,
} from '../../connector-definition-helpers';
import { buildConnectorDefinitionList } from '../../helpers/connector-definition-list';
import { maybeUpsertAuthAfterInstall, upsertConnectorAuthProfiles } from '../../helpers/connection-helpers';
import type { ToolContext } from '../../../registry';
import type { ManageConnectionsResult, ConnectionsArgs } from '../schemas';
import { getErrorMessage } from "@lobu/core";

// ============================================
// handleListConnectorDefinitions
// ============================================

export async function handleListConnectorDefinitions(
  args: Extract<ConnectionsArgs, { action: 'list_connector_definitions' }>,
  env: Env,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const { organizationId } = ctx;

  const rows = await listScopedConnectorDefinitions({ organizationId });
  const connectorKeys = rows.map((r) => r.key);
  const summaries = await getOperationsSummaryBatch(organizationId, connectorKeys);
  const connectorDefinitions = await buildConnectorDefinitionList({
    installedRows: rows,
    summaries,
    includeInstallable: args.include_installable,
    catalogUris: env.CONNECTOR_CATALOG_URIS,
  });

  return { action: 'list_connector_definitions', connector_definitions: connectorDefinitions };
}

// ============================================
// handleInstallConnector
// ============================================

export async function handleInstallConnector(
  args: Extract<ConnectionsArgs, { action: 'install_connector' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  try {
    const installed = args.mcp_url
      ? await installConnectorFromMcpUrl({
          organizationId: ctx.organizationId,
          mcpUrl: args.mcp_url,
        })
      : await installConnectorDefinitionFromSource({
          organizationId: ctx.organizationId,
          sourceUrl: args.source_url,
          sourceUri: args.source_uri,
          sourceCode: args.source_code,
          compiled: args.compiled,
        });

    await maybeUpsertAuthAfterInstall(installed, args.auth_values, ctx);

    if (args.entity_link_overrides !== undefined) {
      const err = await applyEntityLinkOverrides(
        ctx.organizationId,
        installed.connectorKey,
        args.entity_link_overrides
      );
      if (err) return { error: err };
    }

    return {
      action: 'install_connector',
      installed: true,
      connector_key: installed.connectorKey,
      name: installed.name,
      version: installed.version,
      code_hash: installed.codeHash,
      updated: installed.updated,
    };
  } catch (error) {
    return {
      error: `Install failed: ${getErrorMessage(error)}`,
    };
  }
}

// ============================================
// handleUninstallConnector
// ============================================

export async function handleUninstallConnector(
  args: Extract<ConnectionsArgs, { action: 'uninstall_connector' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  try {
    const archived = await uninstallConnectorDefinition({
      organizationId: ctx.organizationId,
      connectorKey: args.connector_key,
    });
    if (!archived) {
      return { error: `Connector '${args.connector_key}' not found or already archived` };
    }
  } catch (error) {
    return { error: getErrorMessage(error) };
  }

  return { action: 'uninstall_connector', uninstalled: true, connector_key: args.connector_key };
}

// ============================================
// handleToggleConnectorLogin
// ============================================

/**
 * Toggle connector as a login provider.
 * Requires OAuth auth method in the connector's auth_schema.
 */
export async function handleToggleConnectorLogin(
  args: Extract<ConnectionsArgs, { action: 'toggle_connector_login' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  try {
    const connector = await toggleConnectorLoginEnabled({
      organizationId: ctx.organizationId,
      connectorKey: args.connector_key,
      enabled: args.enabled,
    });

    if (!connector) {
      return {
        error: `Connector '${args.connector_key}' not found for this organization. Install it first.`,
      };
    }

    logger.info(
      { connector_key: args.connector_key, login_enabled: args.enabled },
      'Connector login provider toggled'
    );

    return {
      action: 'toggle_connector_login',
      success: true,
      connector_key: args.connector_key,
      login_enabled: args.enabled,
    };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

// ============================================
// handleUpdateConnectorAuth
// ============================================

export async function handleUpdateConnectorAuth(
  args: Extract<ConnectionsArgs, { action: 'update_connector_auth' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const organizationId = ctx.organizationId;
  const userId = ctx.userId ?? 'api';

  const authValues = normalizeAuthValues(args.auth_values);
  if (Object.keys(authValues).length === 0) {
    return { error: 'No auth values provided.' };
  }

  const connectorRows = await sql`
    SELECT key, name, auth_schema
    FROM connector_definitions
    WHERE key = ${args.connector_key}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  if (connectorRows.length === 0) {
    return { error: `Connector '${args.connector_key}' not found for this organization.` };
  }

  const connector = connectorRows[0] as {
    key: string;
    name: string;
    auth_schema: Record<string, unknown> | null;
  };

  await upsertConnectorAuthProfiles({
    organizationId,
    connectorKey: args.connector_key,
    connectorName: connector.name,
    authSchema: connector.auth_schema,
    authValues,
    createdBy: userId,
  });

  logger.info(
    { connector_key: args.connector_key, keys: Object.keys(authValues) },
    'Connector auth profiles updated'
  );

  return {
    action: 'update_connector_auth',
    success: true,
    connector_key: args.connector_key,
    keys_updated: Object.keys(authValues),
  };
}

// ============================================
// handleUpdateConnectorDefaultConfig
// ============================================

export async function handleUpdateConnectorDefaultConfig(
  args: Extract<ConnectionsArgs, { action: 'update_connector_default_config' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const updated = await updateActiveConnectorDefinitionField(
    args.connector_key,
    ctx.organizationId,
    (sql) => sql`default_connection_config = ${sql.json(args.default_connection_config)}`
  );

  if (!updated) {
    return { error: `Connector '${args.connector_key}' not found` };
  }

  return {
    action: 'update_connector_default_config',
    success: true,
    connector_key: args.connector_key,
  };
}

// ============================================
// handleUpdateConnectorDefaultRepairAgent
// ============================================

export async function handleUpdateConnectorDefaultRepairAgent(
  args: Extract<ConnectionsArgs, { action: 'update_connector_default_repair_agent' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const updated = await updateActiveConnectorDefinitionField(
    args.connector_key,
    ctx.organizationId,
    (sql) => sql`default_repair_agent_id = ${args.default_repair_agent_id}::text`
  );

  if (!updated) {
    return { error: `Connector '${args.connector_key}' not found` };
  }

  return {
    action: 'update_connector_default_repair_agent',
    success: true,
    connector_key: args.connector_key,
    default_repair_agent_id: args.default_repair_agent_id,
  };
}

// ============================================
// handleSetConnectorEntityLinkOverrides
// ============================================

export async function handleSetConnectorEntityLinkOverrides(
  args: Extract<ConnectionsArgs, { action: 'set_connector_entity_link_overrides' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const err = await applyEntityLinkOverrides(
    ctx.organizationId,
    args.connector_key,
    args.overrides
  );
  if (err) return { error: err };

  return {
    action: 'set_connector_entity_link_overrides',
    success: true,
    connector_key: args.connector_key,
    overrides: (args.overrides ?? null) as Record<string, unknown> | null,
  };
}
