/**
 * ClientSDK `connections` namespace. Thin, action-complete wrapper over
 * `manageConnections`.
 *
 * `connect` / `reauthenticate` return a `connect_url` the caller should show to
 * the user. Field names follow the handler schema.
 */

import type {
	ConnectionConnectInput,
	ConnectionCreateInput,
	ConnectionUpdateInput,
	InstallConnectorInput,
} from "@lobu/core/contracts/tools/manage-connections";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

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
	const { manage, action } = createActionCaller(manageConnections, env, ctx);

	return {
		manage,
		list: (input) => action("list", input),
		get: (connection_id) => action("get", { connection_id }),
		create: (input) => action("create", input),
		connect: (input) => action("connect", input),
		update: (input) => action("update", input),
		delete: (connection_id) => action("delete", { connection_id }),
		reauthenticate: (connection_id) =>
			action("reauthenticate", { connection_id }),
		test: (connection_id) => action("test", { connection_id }),
		installConnector: (input) => action("install_connector", input),
		uninstallConnector: (connector_key) =>
			action("uninstall_connector", { connector_key }),
		toggleConnectorLogin: (input) => action("toggle_connector_login", input),
		updateConnectorAuth: (input) => action("update_connector_auth", input),
		updateConnectorDefaultConfig: (input) =>
			action("update_connector_default_config", input),
		updateConnectorDefaultRepairAgent: (input) =>
			action("update_connector_default_repair_agent", input),
	};
}
