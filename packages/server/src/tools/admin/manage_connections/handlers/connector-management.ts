/**
 * Connector management action handlers:
 * install_connector, uninstall_connector, toggle_connector_login,
 * update_connector_auth, update_connector_default_config,
 * update_connector_default_repair_agent, set_connector_entity_link_overrides,
 */

import { getErrorMessage } from "@lobu/core";
import { getDb } from "../../../../db/client";
import { recordToolConfigChange } from "../../helpers/config-audit";
import { normalizeAuthValues } from "../../../../utils/auth-profiles";
import { applyEntityLinkOverrides } from "../../../../utils/entity-link-validation";
import logger from "../../../../utils/logger";
import type { ToolContext } from "../../../registry";
import {
	installConnectorDefinitionFromSource,
	installConnectorFromMcpUrl,
	toggleConnectorLoginEnabled,
	uninstallConnectorDefinition,
	updateActiveConnectorDefinitionField,
} from "../../../../catalog/connector-definitions";
import {
	maybeUpsertAuthAfterInstall,
	upsertConnectorAuthProfiles,
} from "../../helpers/connection-helpers";
import type { ConnectionsArgs, ManageConnectionsResult } from "../schemas";

// ============================================
// handleInstallConnector
// ============================================

export async function handleInstallConnector(
	args: Extract<ConnectionsArgs, { action: "install_connector" }>,
	ctx: ToolContext,
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
				args.entity_link_overrides,
			);
			if (err) return { error: err };
		}

		recordToolConfigChange(ctx, {
			resourceKind: "connector-definition",
			resourceId: installed.connectorKey,
			op: installed.updated ? "updated" : "created",
			summary: `Connector '${installed.name ?? installed.connectorKey}' ${installed.updated ? "updated" : "installed"} (v${installed.version})`,
			// Intentionally small: key/version/source only — never compiled code.
			state: {
				connector_key: installed.connectorKey,
				name: installed.name,
				version: installed.version,
				code_hash: installed.codeHash,
				...(args.mcp_url ? { mcp_url: args.mcp_url } : {}),
				...(args.source_url ? { source_url: args.source_url } : {}),
				...(args.source_uri ? { source_uri: args.source_uri } : {}),
			},
		});

		return {
			action: "install_connector",
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
	args: Extract<ConnectionsArgs, { action: "uninstall_connector" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	try {
		const archived = await uninstallConnectorDefinition({
			organizationId: ctx.organizationId,
			connectorKey: args.connector_key,
		});
		if (!archived) {
			return {
				error: `Connector '${args.connector_key}' not found or already archived`,
			};
		}
	} catch (error) {
		return { error: getErrorMessage(error) };
	}

	recordToolConfigChange(ctx, {
		resourceKind: "connector-definition",
		resourceId: args.connector_key,
		op: "deleted",
		summary: `Connector '${args.connector_key}' uninstalled`,
		state: null,
	});

	return {
		action: "uninstall_connector",
		uninstalled: true,
		connector_key: args.connector_key,
	};
}

// ============================================
// handleToggleConnectorLogin
// ============================================

/**
 * Toggle connector as a login provider.
 * Requires OAuth auth method in the connector's auth_schema.
 */
export async function handleToggleConnectorLogin(
	args: Extract<ConnectionsArgs, { action: "toggle_connector_login" }>,
	ctx: ToolContext,
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
			"Connector login provider toggled",
		);

		recordToolConfigChange(ctx, {
			resourceKind: "connector-definition",
			resourceId: args.connector_key,
			op: "updated",
			summary: `Connector '${args.connector_key}' login provider ${args.enabled ? "enabled" : "disabled"}`,
			state: { connector_key: args.connector_key, login_enabled: args.enabled },
			changedFields: ["login_enabled"],
		});

		return {
			action: "toggle_connector_login",
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
	args: Extract<ConnectionsArgs, { action: "update_connector_auth" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const sql = getDb();
	const organizationId = ctx.organizationId;
	const userId = ctx.userId ?? "api";

	const authValues = normalizeAuthValues(args.auth_values);
	if (Object.keys(authValues).length === 0) {
		return { error: "No auth values provided." };
	}

	const connectorRows = await sql`
    SELECT key, name, auth_schema
    FROM connector_definitions
    WHERE key = ${args.connector_key}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
	if (connectorRows.length === 0) {
		return {
			error: `Connector '${args.connector_key}' not found for this organization.`,
		};
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
		"Connector auth profiles updated",
	);

	// Metadata-only (state null): auth values are secret material, and the
	// key NAMES alone already say which credentials were rotated.
	recordToolConfigChange(ctx, {
		resourceKind: "connector-definition",
		resourceId: args.connector_key,
		op: "updated",
		summary: `Connector '${args.connector_key}' auth updated (${Object.keys(authValues).join(", ")})`,
		state: null,
		changedFields: ["auth_profiles"],
	});

	return {
		action: "update_connector_auth",
		success: true,
		connector_key: args.connector_key,
		keys_updated: Object.keys(authValues),
	};
}

// ============================================
// handleUpdateConnectorDefaultConfig
// ============================================

export async function handleUpdateConnectorDefaultConfig(
	args: Extract<ConnectionsArgs, { action: "update_connector_default_config" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const updated = await updateActiveConnectorDefinitionField(
		args.connector_key,
		ctx.organizationId,
		(sql) =>
			sql`default_connection_config = ${sql.json(args.default_connection_config)}`,
	);

	if (!updated) {
		return { error: `Connector '${args.connector_key}' not found` };
	}

	recordToolConfigChange(ctx, {
		resourceKind: "connector-definition",
		resourceId: args.connector_key,
		op: "updated",
		summary: `Connector '${args.connector_key}' default connection config updated`,
		state: {
			connector_key: args.connector_key,
			default_connection_config: args.default_connection_config,
		},
		changedFields: ["default_connection_config"],
	});

	return {
		action: "update_connector_default_config",
		success: true,
		connector_key: args.connector_key,
	};
}

// ============================================
// handleUpdateConnectorDefaultRepairAgent
// ============================================

export async function handleUpdateConnectorDefaultRepairAgent(
	args: Extract<
		ConnectionsArgs,
		{ action: "update_connector_default_repair_agent" }
	>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const updated = await updateActiveConnectorDefinitionField(
		args.connector_key,
		ctx.organizationId,
		(sql) =>
			sql`default_repair_agent_id = ${args.default_repair_agent_id}::text`,
	);

	if (!updated) {
		return { error: `Connector '${args.connector_key}' not found` };
	}

	recordToolConfigChange(ctx, {
		resourceKind: "connector-definition",
		resourceId: args.connector_key,
		op: "updated",
		summary: `Connector '${args.connector_key}' default repair agent updated`,
		state: {
			connector_key: args.connector_key,
			default_repair_agent_id: args.default_repair_agent_id,
		},
		changedFields: ["default_repair_agent_id"],
	});

	return {
		action: "update_connector_default_repair_agent",
		success: true,
		connector_key: args.connector_key,
		default_repair_agent_id: args.default_repair_agent_id,
	};
}

// ============================================
// handleSetConnectorEntityLinkOverrides
// ============================================

export async function handleSetConnectorEntityLinkOverrides(
	args: Extract<
		ConnectionsArgs,
		{ action: "set_connector_entity_link_overrides" }
	>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const err = await applyEntityLinkOverrides(
		ctx.organizationId,
		args.connector_key,
		args.overrides,
	);
	if (err) return { error: err };

	recordToolConfigChange(ctx, {
		resourceKind: "connector-definition",
		resourceId: args.connector_key,
		op: "updated",
		summary: `Connector '${args.connector_key}' entity link overrides updated`,
		state: {
			connector_key: args.connector_key,
			entity_link_overrides: (args.overrides ?? null) as Record<
				string,
				unknown
			> | null,
		},
		changedFields: ["entity_link_overrides"],
	});

	return {
		action: "set_connector_entity_link_overrides",
		success: true,
		connector_key: args.connector_key,
		overrides: (args.overrides ?? null) as Record<string, unknown> | null,
	};
}
