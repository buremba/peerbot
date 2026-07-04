/**
 * Channel-binding handlers — the tool-side home of channel management.
 *
 * These fold the retired `gateway/routes/public/channels.ts` HTTP routes into
 * `manage_connections` actions. Reach uses them for the agent-scoped reactive
 * binding surface; Connectors uses the same channel/feed model for the
 * connection-scoped transcript lens. The `ChannelBindingService` itself stays —
 * recall (`bound-channels`) and streaming-feed materialization depend on it;
 * only the HTTP shell died.
 *
 * AUTH: the org-role tier (auth/tool-access.ts) gates bind/unbind/connect_dm to
 * owner/admin and list/audience to read tier. On TOP of that, every action calls
 * `assertAgentInOrg` — the explicit per-agent tenant fence the HTTP routes
 * enforced via ownership. A tool call is already org-scoped (`ctx.organizationId`),
 * so confirming the target agent belongs to that org is what stops an org admin
 * from reaching across tenants to another org's agent.
 */
import { createLogger } from "@lobu/core";
import { getDb } from "../../../../db/client";
import { ChannelBindingService } from "../../../../gateway/channels/binding-service";
import {
	createSlackWebApi,
	type SlackWebApi,
} from "../../../../gateway/connections/slack-web";
import {
	resolveSecretValue,
	SecretStoreRegistry,
} from "../../../../gateway/secrets";
import { runtimeConnectionIdToSlug } from "../../../../lobu/stores/connections-projection";
import { orgContext } from "../../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../../lobu/stores/postgres-secret-store";
import { canonicalSlackChannelId } from "../../../../preview/slack";
import type { ToolContext } from "../../../registry";
import type { ConnectionsArgs, ManageConnectionsResult } from "../schemas";

const logger = createLogger("manage-connections-channels");

/** The Slack Web API client. Module-level so tests can swap it (mirrors the
 *  HTTP route's injectable default). */
let slackWebApi: SlackWebApi = createSlackWebApi();
/** Test hook: override the Slack Web API used by connect_channel_dm. */
export function __setSlackWebApiForTests(api: SlackWebApi): void {
	slackWebApi = api;
}

/**
 * Tenant fence: the target agent must exist in the caller's org. `agents` is
 * keyed (organization_id, id), so this is the authoritative per-agent check —
 * never an unscoped `SELECT FROM agents WHERE id = ?`. Returns true when the
 * agent belongs to the caller's org.
 */
async function assertAgentInOrg(
	organizationId: string,
	agentId: string,
): Promise<boolean> {
	const sql = getDb();
	const rows = (await sql`
		SELECT 1 FROM agents
		WHERE id = ${agentId} AND organization_id = ${organizationId}
		LIMIT 1
	`) as Array<unknown>;
	return rows.length > 0;
}

/**
 * Resolve the caller's Slack user id for a DM. A web/MCP caller is matched to
 * its linked "Sign in with Slack" account (`account.accountId` = the Slack OIDC
 * subject). Null when no Slack identity links to the caller. (The HTTP route
 * also handled a Slack-platform settings session — a tool call is never that,
 * so only the account-link branch is ported.)
 */
async function resolveCallerSlackUserId(
	userId: string | null,
): Promise<string | null> {
	if (!userId) return null;
	const sql = getDb();
	const rows = (await sql`
		SELECT "accountId" FROM account
		WHERE "providerId" = 'slack' AND "userId" = ${userId}
		LIMIT 1
	`) as Array<{ accountId: string }>;
	return rows[0]?.accountId ?? null;
}

/** A PG-backed secret store for resolving an install's bot-token `secret://`
 *  ref. Slack bot tokens are written under the default (PG) scheme, so a
 *  registry over PostgresSecretStore resolves them exactly as the gateway's. */
function channelSecretStore(): SecretStoreRegistry {
	const pg = new PostgresSecretStore();
	return new SecretStoreRegistry(pg, { secret: pg });
}

/** List an agent's channel bindings (read tier). Fenced to agents in the
 *  caller's org. */
export async function handleListChannelBindings(
	args: Extract<ConnectionsArgs, { action: "list_channel_bindings" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId } = ctx;
	if (!(await assertAgentInOrg(organizationId, args.agent_id))) {
		return { error: "Agent not found" };
	}
	const svc = new ChannelBindingService();
	const bindings = await svc.listBindings(args.agent_id, organizationId);
	return {
		action: "list_channel_bindings",
		agent_id: args.agent_id,
		bindings: bindings.map((b) => ({
			connectionId: b.connectionId,
			platform: b.platform,
			channelId: b.channelId,
			teamId: b.teamId,
			model: b.model,
			createdAt: b.createdAt,
		})),
	};
}

/** Bind a chat channel to an agent (owner/admin tier). Materializes the
 *  channel's streaming feed via ChannelBindingService.createBinding. */
export async function handleBindChannel(
	args: Extract<ConnectionsArgs, { action: "bind_channel" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId, userId } = ctx;
	if (!(await assertAgentInOrg(organizationId, args.agent_id))) {
		return { error: "Agent not found" };
	}
	const channelId = args.channel_id.trim();
	if (!channelId) return { error: "Invalid channel_id" };
	const sql = getDb();
	const connections = (await sql`
		SELECT id, connector_key, external_tenant_id
		FROM connections
		WHERE id = ${args.connection_id}
			AND organization_id = ${organizationId}
			AND credential_mode IS NOT NULL
			AND status = 'active'
			AND deleted_at IS NULL
		LIMIT 1
	`) as Array<{
		id: number;
		connector_key: string;
		external_tenant_id: string | null;
	}>;
	const connection = connections[0];
	if (!connection) return { error: "Active chat connection not found" };
	const teamId = connection.external_tenant_id ?? undefined;

	const svc = new ChannelBindingService();
	await svc.createBinding(
		args.agent_id,
		connection.connector_key,
		channelId,
		teamId,
		{
			configuredBy: userId ?? undefined,
			organizationId,
			connectionId: String(connection.id),
			model: args.model,
		},
	);
	logger.info(
		`Bound ${connection.connector_key}/${channelId} → ${args.agent_id}`,
	);
	return {
		action: "bind_channel",
		success: true,
		agent_id: args.agent_id,
		connection_id: connection.id,
		platform: connection.connector_key,
		channel_id: channelId,
		team_id: teamId,
	};
}

/** Unbind a chat channel from an agent (owner/admin tier). Soft-deletes the
 *  channel's streaming feed via ChannelBindingService.deleteBinding. */
export async function handleUnbindChannel(
	args: Extract<ConnectionsArgs, { action: "unbind_channel" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId } = ctx;
	if (!(await assertAgentInOrg(organizationId, args.agent_id))) {
		return { error: "Agent not found" };
	}
	const sql = getDb();
	const rows = (await sql`
		SELECT b.platform, b.team_id
		FROM agent_channel_bindings b
		JOIN connections c ON c.id = b.connection_id
		WHERE b.organization_id = ${organizationId}
			AND b.agent_id = ${args.agent_id}
			AND b.connection_id = ${args.connection_id}
			AND b.channel_id = ${args.channel_id}
			AND c.organization_id = ${organizationId}
			AND c.deleted_at IS NULL
		LIMIT 1
	`) as Array<{ platform: string; team_id: string | null }>;
	const binding = rows[0];
	if (!binding) return { error: "Binding not found" };
	const svc = new ChannelBindingService();
	const deleted = await svc.deleteBinding(
		args.agent_id,
		args.channel_id,
		String(args.connection_id),
		organizationId,
	);
	if (!deleted) return { error: "Binding not found" };
	return { action: "unbind_channel", success: true };
}

/** Reconcile declarative channel bindings for one agent + connection. Used by
 * `lobu apply`; the connection id is authoritative and provider tuple fields
 * are derived from its row. */
export async function handleSyncChannelBindings(
	args: Extract<ConnectionsArgs, { action: "sync_channel_bindings" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId, userId } = ctx;
	if (!(await assertAgentInOrg(organizationId, args.agent_id))) {
		return { error: "Agent not found" };
	}
	const sql = getDb();
	const numericConnectionId =
		typeof args.connection_id === "number" ? args.connection_id : null;
	const connectionSlug =
		typeof args.connection_id === "string"
			? runtimeConnectionIdToSlug(args.connection_id)
			: null;
	const rows = (await sql`
		SELECT id, connector_key, external_tenant_id
		FROM connections
		WHERE (id = ${numericConnectionId} OR slug = ${connectionSlug})
			AND organization_id = ${organizationId}
			AND credential_mode IS NOT NULL
			AND deleted_at IS NULL
		LIMIT 1
	`) as Array<{
		id: number;
		connector_key: string;
		external_tenant_id: string | null;
	}>;
	const connection = rows[0];
	if (!connection) return { error: "Chat connection not found" };

	const desired = new Set<string>();
	for (const input of args.channels) {
		let channelId = input.trim();
		if (!channelId) return { error: "Channel ids cannot be empty" };
		if (connection.connector_key === "slack") {
			const slash = channelId.indexOf("/");
			if (slash >= 0) {
				const teamId = channelId.slice(0, slash);
				channelId = channelId.slice(slash + 1);
				if (
					connection.external_tenant_id &&
					teamId !== connection.external_tenant_id
				) {
					return {
						error: `Channel ${input} belongs to a different Slack workspace`,
					};
				}
			}
			channelId = canonicalSlackChannelId(channelId);
		}
		desired.add(channelId);
	}

	const svc = new ChannelBindingService();
	const existing = (
		await svc.listBindings(args.agent_id, organizationId)
	).filter((binding) => binding.connectionId === String(connection.id));
	const existingIds = new Set(existing.map((binding) => binding.channelId));
	const bound: string[] = [];
	for (const channelId of desired) {
		if (!existingIds.has(channelId)) {
			await svc.createBinding(
				args.agent_id,
				connection.connector_key,
				channelId,
				connection.external_tenant_id ?? undefined,
				{
					configuredBy: userId ?? undefined,
					organizationId,
					connectionId: String(connection.id),
				},
			);
		}
		bound.push(channelId);
	}

	const removed: string[] = [];
	for (const binding of existing) {
		if (desired.has(binding.channelId)) continue;
		await svc.deleteBinding(
			args.agent_id,
			binding.channelId,
			String(connection.id),
			organizationId,
		);
		removed.push(binding.channelId);
	}
	return {
		action: "sync_channel_bindings",
		success: true,
		bound,
		removed,
	};
}

/** Open + bind the caller's Slack DM with a connection's bot to an agent
 *  (owner/admin tier) — the web-first "one click connects my DM" action.
 *  Resolves the install's bot token org-scoped and binds the canonical key. */
export async function handleConnectChannelDm(
	args: Extract<ConnectionsArgs, { action: "connect_channel_dm" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId, userId } = ctx;
	if (!(await assertAgentInOrg(organizationId, args.agent_id))) {
		return { error: "Agent not found" };
	}

	const sql = getDb();
	const rows = (await sql`
		SELECT id, connector_key, external_tenant_id, config
		FROM connections
		WHERE id = ${args.connection_id}
			AND organization_id = ${organizationId}
			AND connector_key = 'slack'
			AND credential_mode IS NOT NULL
			AND status = 'active'
			AND deleted_at IS NULL
		LIMIT 1
	`) as Array<{
		id: number;
		connector_key: string;
		external_tenant_id: string | null;
		config: { botToken?: string } | null;
	}>;
	const connection = rows[0];
	if (!connection) return { error: "Active Slack connection not found" };

	// Bot token is a `secret://` ref, resolved org-scoped. PRESERVE the
	// orgContext wrap: dropping it resolves the ref under the WRONG org and
	// silently yields no/foreign token (the 409 path).
	const tokenRef = connection.config?.botToken;
	const botToken = await orgContext.run({ organizationId }, () =>
		resolveSecretValue(channelSecretStore(), tokenRef),
	);
	if (!botToken) return { error: "Workspace bot token unavailable" };

	const slackUserId = await resolveCallerSlackUserId(userId);
	if (!slackUserId) {
		return {
			error:
				"No linked Slack identity for your account. Sign in with Slack first.",
		};
	}

	let dmChannelId: string;
	try {
		dmChannelId = await slackWebApi.openDm(botToken, slackUserId);
	} catch (error) {
		logger.error("Failed to open Slack DM", {
			error: String(error),
			connectionId: connection.id,
		});
		return { error: "Could not open a Slack DM with you" };
	}

	// Store the binding under the canonical `slack:<id>` channel key — inbound
	// Slack messages reach the dispatcher already canonicalized, so a raw `D…`
	// key would never route. (dmChannelId stays raw for the Web API calls.)
	const svc = new ChannelBindingService();
	await svc.createBinding(
		args.agent_id,
		"slack",
		canonicalSlackChannelId(dmChannelId),
		connection.external_tenant_id ?? undefined,
		{
			configuredBy: userId ?? undefined,
			organizationId,
			connectionId: String(connection.id),
		},
	);

	// Best-effort welcome — the binding is the contract, not this DM.
	void slackWebApi
		.postMessage(
			botToken,
			dmChannelId,
			"✅ Connected. I'm now wired to this DM — ask me anything to get started.",
		)
		.catch(() => {});

	logger.info(
		`Connected Slack DM ${dmChannelId} (team ${connection.external_tenant_id ?? "unknown"}) → ${args.agent_id}`,
	);
	return {
		action: "connect_channel_dm",
		success: true,
		platform: "slack",
		channel_id: dmChannelId,
		team_id: connection.external_tenant_id,
	};
}
