/**
 * Tool: manage_connections
 *
 * Manage integration connections (auth bindings to external services).
 *
 * Actions:
 * - list: List connections for the organization
 * - list_connector_definitions: List available connector definitions for picker UIs
 * - get: Get a specific connection by ID
 * - create: Create a new connection (requires pre-existing auth profiles)
 * - connect: Create connection + auth link in one call (recommended for MCP clients).
 *            Returns a connect_url for the user to complete OAuth auth for a reusable profile.
 *            Poll with get until status='active'.
 * - update: Update connection settings
 * - delete: Delete a connection
 * - test: Test connection credentials
 * - install_connector: Install connector from URL, inline source, or MCP server URL into the current org
 * - uninstall_connector: Archive the org-scoped connector definition
 * - toggle_connector_login: Toggle connector as a login provider
 * - update_connector_auth: Update reusable default auth profiles for an installed org connector
 */

import type { Env } from '../../index';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';
import { handleList, handleGet, handleCreate, handleUpdate, handleDelete } from './manage_connections/handlers/crud';
import { handleConnect } from './manage_connections/handlers/connect';
import { handleReauthenticate, handleTest } from './manage_connections/handlers/auth-actions';
import {
  handleListConnectorDefinitions,
  handleInstallConnector,
  handleUninstallConnector,
  handleToggleConnectorLogin,
  handleUpdateConnectorAuth,
  handleUpdateConnectorDefaultConfig,
  handleUpdateConnectorDefaultRepairAgent,
  handleSetConnectorEntityLinkOverrides,
} from './manage_connections/handlers/connector-management';

export { ManageConnectionsSchema } from './manage_connections/schemas';
export type { ManageConnectionsResult } from './manage_connections/schemas';

import type { ConnectionsArgs, ManageConnectionsResult } from './manage_connections/schemas';

// ============================================
// Main Function (Action Router)
// ============================================

export async function manageConnections(
  args: ConnectionsArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  return routeAction<ManageConnectionsResult>('manage_connections', args.action, ctx, {
    list_connector_definitions: () =>
      handleListConnectorDefinitions(
        args as Extract<ConnectionsArgs, { action: 'list_connector_definitions' }>,
        env,
        ctx
      ),
    list: () => handleList(args as Extract<ConnectionsArgs, { action: 'list' }>, ctx),
    get: () => handleGet(args as Extract<ConnectionsArgs, { action: 'get' }>, ctx),
    create: () => handleCreate(args as Extract<ConnectionsArgs, { action: 'create' }>, ctx),
    connect: () => handleConnect(args as Extract<ConnectionsArgs, { action: 'connect' }>, ctx),
    update: () => handleUpdate(args as Extract<ConnectionsArgs, { action: 'update' }>, ctx),
    delete: () => handleDelete(args as Extract<ConnectionsArgs, { action: 'delete' }>, ctx),
    reauthenticate: () =>
      handleReauthenticate(args as Extract<ConnectionsArgs, { action: 'reauthenticate' }>, ctx),
    test: () => handleTest(args as Extract<ConnectionsArgs, { action: 'test' }>, ctx),
    install_connector: () =>
      handleInstallConnector(
        args as Extract<ConnectionsArgs, { action: 'install_connector' }>,
        ctx
      ),
    uninstall_connector: () =>
      handleUninstallConnector(
        args as Extract<ConnectionsArgs, { action: 'uninstall_connector' }>,
        ctx
      ),
    toggle_connector_login: () =>
      handleToggleConnectorLogin(
        args as Extract<ConnectionsArgs, { action: 'toggle_connector_login' }>,
        ctx
      ),
    update_connector_auth: () =>
      handleUpdateConnectorAuth(
        args as Extract<ConnectionsArgs, { action: 'update_connector_auth' }>,
        ctx
      ),
    update_connector_default_config: () =>
      handleUpdateConnectorDefaultConfig(
        args as Extract<ConnectionsArgs, { action: 'update_connector_default_config' }>,
        ctx
      ),
    update_connector_default_repair_agent: () =>
      handleUpdateConnectorDefaultRepairAgent(
        args as Extract<
          ConnectionsArgs,
          { action: 'update_connector_default_repair_agent' }
        >,
        ctx
      ),
    set_connector_entity_link_overrides: () =>
      handleSetConnectorEntityLinkOverrides(
        args as Extract<ConnectionsArgs, { action: 'set_connector_entity_link_overrides' }>,
        ctx
      ),
  });
}
