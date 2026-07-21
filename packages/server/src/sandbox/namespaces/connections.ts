/**
 * ClientSDK `connections` namespace. Thin, action-complete wrapper over
 * `manageConnections`.
 *
 * `connect` returns a `connect_url`. `reauthenticate` returns a `connect_url`
 * for OAuth accounts or an `auth_run_id` for interactive pairing. Field names
 * follow the handler schema.
 */

import type {
	ConnectionConnectInput,
	ConnectionCreateInput,
	ConnectionUpdateInput,
	GetConnectorSourceInput,
	InstallConnectorInput,
	RollbackConnectorVersionInput,
	UpdateConnectorSourceInput,
	ValidateConnectorSourceInput,
} from "@lobu/core/contracts/tools/manage-connections";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, requirePositionalNumber } from "./action-call";

export type ConnectionsConnectInput = ConnectionConnectInput;
export type ConnectionsCreateInput = ConnectionCreateInput;
export type ConnectionsUpdateInput = ConnectionUpdateInput;
export type ConnectionsInstallConnectorInput = InstallConnectorInput;

export interface ConnectionsNamespace {
	/** Raw escape hatch for any manage_connections action. Prefer named methods. */
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: {
		connector_key?: string;
		status?: string;
		entity_id?: number;
		created_by?: string;
		connection_ids?: number[];
		setup_attempt_id?: string;
		limit?: number;
		offset?: number;
	}): Promise<unknown>;
	get(connection_id: number): Promise<unknown>;
	create(input: ConnectionsCreateInput): Promise<unknown>;
	connect(input: ConnectionsConnectInput): Promise<unknown>;
	update(input: ConnectionsUpdateInput): Promise<unknown>;
	delete(connection_id: number): Promise<unknown>;
	reauthenticate(connection_id: number): Promise<unknown>;
	test(connection_id: number): Promise<unknown>;
	installConnector(input: ConnectionsInstallConnectorInput): Promise<unknown>;
	uninstallConnector(connector_key: string): Promise<unknown>;
	getConnectorSource(input: GetConnectorSourceInput): Promise<unknown>;
	validateConnectorSource(
		input: ValidateConnectorSourceInput,
	): Promise<unknown>;
	updateConnectorSource(input: UpdateConnectorSourceInput): Promise<unknown>;
	rollbackConnectorVersion(
		input: RollbackConnectorVersionInput,
	): Promise<unknown>;
	toggleConnectorLogin(input: {
		connector_key: string;
		enabled: boolean;
	}): Promise<unknown>;
	updateConnectorAuth(input: {
		connector_key: string;
		auth_values: Record<string, string>;
	}): Promise<unknown>;
	updateConnectorDefaultConfig(input: {
		connector_key: string;
		default_connection_config: Record<string, unknown>;
	}): Promise<unknown>;
	updateConnectorDefaultRepairAgent(input: {
		connector_key: string;
		default_repair_agent_id: string | null;
	}): Promise<unknown>;
}

export function buildConnectionsNamespace(
	ctx: ToolContext,
	env: Env,
): ConnectionsNamespace {
	const { manage, action } = createActionCaller(
		manageConnections,
		env,
		ctx,
		"connections",
	);

	return {
		manage,
		list: (input) => action("list", input),
		get: async (connection_id) =>
			action("get", {
				connection_id: requirePositionalNumber(
					"connections.get",
					connection_id,
					"client.connections.get(<connection_id>)",
				),
			}),
		create: (input) => action("create", input),
		connect: (input) => action("connect", input),
		update: (input) => action("update", input),
		delete: async (connection_id) =>
			action("delete", {
				connection_id: requirePositionalNumber(
					"connections.delete",
					connection_id,
					"client.connections.delete(<connection_id>)",
				),
			}),
		reauthenticate: async (connection_id) =>
			action("reauthenticate", {
				connection_id: requirePositionalNumber(
					"connections.reauthenticate",
					connection_id,
					"client.connections.reauthenticate(<connection_id>)",
				),
			}),
		test: async (connection_id) =>
			action("test", {
				connection_id: requirePositionalNumber(
					"connections.test",
					connection_id,
					"client.connections.test(<connection_id>)",
				),
			}),
		installConnector: (input) =>
			action("install_connector", input, "installConnector"),
		uninstallConnector: (connector_key) =>
			action("uninstall_connector", { connector_key }, "uninstallConnector"),
		getConnectorSource: (input) =>
			action("get_connector_source", input, "getConnectorSource"),
		validateConnectorSource: (input) =>
			action("validate_connector_source", input, "validateConnectorSource"),
		updateConnectorSource: (input) =>
			action("update_connector_source", input, "updateConnectorSource"),
		rollbackConnectorVersion: (input) =>
			action("rollback_connector_version", input, "rollbackConnectorVersion"),
		toggleConnectorLogin: (input) =>
			action("toggle_connector_login", input, "toggleConnectorLogin"),
		updateConnectorAuth: (input) =>
			action("update_connector_auth", input, "updateConnectorAuth"),
		updateConnectorDefaultConfig: (input) =>
			action("update_connector_default_config", input, "updateConnectorDefaultConfig"),
		updateConnectorDefaultRepairAgent: (input) =>
			action("update_connector_default_repair_agent", input, "updateConnectorDefaultRepairAgent"),
	};
}
