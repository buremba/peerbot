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
	handleGetChannelAudience,
	handleListChannelBindings,
	handleUnbindChannel,
} from "./manage_connections/handlers/channel-bindings";
import { handleConnect } from "./manage_connections/handlers/connect";
import {
	handleInstallConnector,
	handleSetConnectorEntityLinkOverrides,
	handleToggleConnectorLogin,
	handleUninstallConnector,
	handleUpdateConnectorAuth,
	handleUpdateConnectorDefaultConfig,
	handleUpdateConnectorDefaultRepairAgent,
} from "./manage_connections/handlers/connector-management";
import {
	handleCreate,
	handleDelete,
	handleGet,
	handleList,
	handleListConnectorGroups,
	handleUpdate,
} from "./manage_connections/handlers/crud";
import {
	BindChannelAction,
	ConnectAction,
	ConnectChannelDmAction,
	CreateAction,
	DeleteAction,
	GetAction,
	GetChannelAudienceAction,
	InstallConnectorAction,
	ListConnectorGroupsAction,
	ListAction,
	ListChannelBindingsAction,
	ReauthenticateAction,
	SetConnectorEntityLinkOverridesAction,
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
	set_connector_entity_link_overrides: action(
		SetConnectorEntityLinkOverridesAction,
		handleSetConnectorEntityLinkOverrides,
	),
	list_channel_bindings: action(
		ListChannelBindingsAction,
		handleListChannelBindings,
	),
	bind_channel: action(BindChannelAction, handleBindChannel),
	unbind_channel: action(UnbindChannelAction, handleUnbindChannel),
	get_channel_audience: action(
		GetChannelAudienceAction,
		handleGetChannelAudience,
	),
	connect_channel_dm: action(ConnectChannelDmAction, handleConnectChannelDm),
});

export const ManageConnectionsSchema = manageConnectionsTool.schema;
export const manageConnections = manageConnectionsTool.run;
