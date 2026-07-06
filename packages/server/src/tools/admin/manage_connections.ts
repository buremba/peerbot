/**
 * Tool: manage_connections
 *
 * Manage integration connections (auth bindings to external services).
 *
 * Actions:
 * - list: List connections for the organization

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

import { action, defineActionTool } from "./action-tool";
import {
	handleReauthenticate,
	handleTest,
} from "./manage_connections/handlers/auth-actions";
import {
	handleBindChannel,
	handleConnectChannelDm,
	handleListChannelBindings,
	handleSyncChannelBindings,
	handleUnbindChannel,
} from "./manage_connections/handlers/channel-bindings";
import { handleConnect } from "./manage_connections/handlers/connect";
import {
	handleInstallConnector,
	handleToggleConnectorLogin,
	handleUninstallConnector,
	handleUpdateConnectorAuth,
	handleUpdateConnectorDefaultConfig,
	handleUpdateConnectorDefaultRepairAgent,
} from "./manage_connections/handlers/connector-management";
import {
	handleApplyChatConnection,
	handleCreate,
	handleDelete,
	handleGet,
	handleList,
	handleListConnectorGroups,
	handleUpdate,
} from "./manage_connections/handlers/crud";
import {
	ApplyChatConnectionAction,
	BindChannelAction,
	ConnectAction,
	ConnectChannelDmAction,
	CreateAction,
	DeleteAction,
	GetAction,
	InstallConnectorAction,
	ListAction,
	ListChannelBindingsAction,
	ListConnectorGroupsAction,
	ReauthenticateAction,
	SyncChannelBindingsAction,
	TestAction,
	ToggleConnectorLoginAction,
	UnbindChannelAction,
	UninstallConnectorAction,
	UpdateAction,
	UpdateConnectorAuthAction,
	UpdateConnectorDefaultConfigAction,
	UpdateConnectorDefaultRepairAgentAction,
} from "./manage_connections/schemas";

// ============================================
// Main Function (Action Router)
// ============================================

const manageConnectionsTool = defineActionTool("manage_connections", {
	list_connector_groups: action(
		ListConnectorGroupsAction,
		handleListConnectorGroups,
	),
	list: action(ListAction, handleList),
	get: action(GetAction, handleGet),
	create: action(CreateAction, handleCreate),
	connect: action(ConnectAction, handleConnect),
	update: action(UpdateAction, handleUpdate),
	apply_chat_connection: action(
		ApplyChatConnectionAction,
		handleApplyChatConnection,
	),
	delete: action(DeleteAction, handleDelete),
	reauthenticate: action(ReauthenticateAction, handleReauthenticate),
	test: action(TestAction, handleTest),
	install_connector: action(InstallConnectorAction, handleInstallConnector),
	uninstall_connector: action(
		UninstallConnectorAction,
		handleUninstallConnector,
	),
	toggle_connector_login: action(
		ToggleConnectorLoginAction,
		handleToggleConnectorLogin,
	),
	update_connector_auth: action(
		UpdateConnectorAuthAction,
		handleUpdateConnectorAuth,
	),
	update_connector_default_config: action(
		UpdateConnectorDefaultConfigAction,
		handleUpdateConnectorDefaultConfig,
	),
	update_connector_default_repair_agent: action(
		UpdateConnectorDefaultRepairAgentAction,
		handleUpdateConnectorDefaultRepairAgent,
	),
	list_channel_bindings: action(
		ListChannelBindingsAction,
		handleListChannelBindings,
	),
	bind_channel: action(BindChannelAction, handleBindChannel),
	unbind_channel: action(UnbindChannelAction, handleUnbindChannel),
	sync_channel_bindings: action(
		SyncChannelBindingsAction,
		handleSyncChannelBindings,
	),
	connect_channel_dm: action(ConnectChannelDmAction, handleConnectChannelDm),
});

export const ManageConnectionsSchema = manageConnectionsTool.schema;
export const manageConnections = manageConnectionsTool.run;
// Re-export so the admin registry entry can wire `outputSchema`.
export { ManageConnectionsResultSchema } from "./manage_connections/schemas";
