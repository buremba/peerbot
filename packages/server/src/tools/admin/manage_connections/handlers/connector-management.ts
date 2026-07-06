/**
 * Connector management action handlers:
 * install_connector, uninstall_connector, toggle_connector_login,
 * update_connector_auth, update_connector_default_config,
 * update_connector_default_repair_agent,
 */

import { getErrorMessage } from "@lobu/core";
import { getDb } from "../../../../db/client";
import { recordToolConfigChange } from "../../helpers/config-audit";
import { normalizeAuthValues } from "../../../../utils/auth-profiles";
import logger from "../../../../utils/logger";
import type { ToolContext } from "../../../registry";
import {
	installCatalogConnectorDefinition,
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
		const connectorId = args.connector_id?.trim();
		const mcpUrl = args.mcp_url?.trim();
		const sourceUrl = args.source_url?.trim();
		const sourceUri = args.source_uri?.trim();
		const sourceCode = args.source_code;
		const sourceCodeProvided =
			typeof sourceCode === "string" && sourceCode.trim().length > 0;
		const sources = [connectorId, mcpUrl, sourceUrl, sourceUri].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		if (sourceCodeProvided) sources.push(sourceCode);
		if (sources.length !== 1) {
			return {
				error:
					"Provide exactly one of connector_id, source_url, source_uri, source_code, or mcp_url.",
			};
		}

		const installed = connectorId
			? await installCatalogConnectorDefinition({
					organizationId: ctx.organizationId,
					connectorId,
				})
			: mcpUrl
				? await installConnectorFromMcpUrl({
						organizationId: ctx.organizationId,
						mcpUrl,
					})
				: await installConnectorDefinitionFromSource({
						organizationId: ctx.organizationId,
						sourceUrl,
						sourceUri,
						sourceCode,
						compiled: args.compiled,
					});

		await maybeUpsertAuthAfterInstall(installed, args.auth_values, ctx);

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
				...(connectorId ? { connector_id: connectorId } : {}),
				...(mcpUrl ? { mcp_url: mcpUrl } : {}),
				...(sourceUrl ? { source_url: sourceUrl } : {}),
				...(sourceUri ? { source_uri: sourceUri } : {}),
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
