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
import { getChannelAudiences } from "../../../../authz/audience";
import { getDb } from "../../../../db/client";
import { ChannelBindingService } from "../../../../gateway/channels/binding-service";
import { resolveBoundChannelRows } from "../../../../gateway/channels/bound-channels";
import {
	createSlackWebApi,
	type SlackWebApi,
} from "../../../../gateway/connections/slack-web";
import { resolveSecretValue, SecretStoreRegistry } from "../../../../gateway/secrets";
import { createPostgresAppInstallationStore } from "../../../../lobu/stores/app-installation-store";
import { orgContext } from "../../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../../lobu/stores/postgres-secret-store";
import { canonicalSlackChannelId } from "../../../../preview/slack";
import { getWorkspaceRole } from "../../../../utils/organization-access";
import type { ToolContext } from "../../../registry";
import type { ConnectionsArgs, ManageConnectionsResult } from "../schemas";

const logger = createLogger("manage-connections-channels");

/** Lowercase platform key, mirroring the retired HTTP routes' validation. */
const PLATFORM_RE = /^[a-z][a-z0-9_-]*$/;

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
			platform: b.platform,
			channelId: b.channelId,
			teamId: b.teamId,
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
	if (!PLATFORM_RE.test(args.platform)) {
		return { error: "Invalid platform format. Must be lowercase alphanumeric." };
	}
	const channelId = args.channel_id.trim();
	if (!channelId) return { error: "Invalid channel_id" };
	const teamId = args.team_id?.trim() || undefined;

	const svc = new ChannelBindingService();
	await svc.createBinding(args.agent_id, args.platform, channelId, teamId, {
		configuredBy: userId ?? undefined,
		organizationId,
	});
	logger.info(`Bound ${args.platform}/${channelId} → ${args.agent_id}`);
	return {
		action: "bind_channel",
		success: true,
		agent_id: args.agent_id,
		platform: args.platform,
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
	if (!PLATFORM_RE.test(args.platform)) {
		return { error: "Invalid platform format" };
	}
	const svc = new ChannelBindingService();
	const deleted = await svc.deleteBinding(
		args.agent_id,
		args.platform,
		args.channel_id,
		args.team_id?.trim() || undefined,
		organizationId,
	);
	if (!deleted) return { error: "Binding not found" };
	return { action: "unbind_channel", success: true };
}

/** Read-only governance view (read tier): for each of the agent's bound
 *  channels, who can recall it + the connection's ACL enforcement state. */
export async function handleGetChannelAudience(
	args: Extract<ConnectionsArgs, { action: "get_channel_audience" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId, userId } = ctx;
	const sql = getDb();

	// Connection-centric view: every channel bound through this connection, each
	// audience carrying the binding's agent — the connections surface's channel
	// list. Fenced by connection visibility (a connection in another org / a
	// private connection the caller can't see returns nothing).
	if (args.connection_id != null) {
		const rows = await resolveConnectionChannelRows(
			sql,
			organizationId,
			userId,
			args.connection_id,
		);
		const audiences = await getChannelAudiences(sql, {
			organizationId,
			userId: userId ?? null,
			rows: rows.map((r) => ({
				id: r.id,
				platform: r.platform,
				channel_id: r.channel_id,
				team_id: r.team_id,
				created_at: r.created_at,
			})),
		});
		const agentByKey = new Map(
			rows.map((r) => [
				`${r.channel_id}|${r.team_id ?? ""}`,
				{ agentId: r.agent_id, agentName: r.agent_name },
			]),
		);
		const enriched = audiences.map((a) => ({
			...a,
			...(agentByKey.get(`${a.channelId}|${a.teamId ?? ""}`) ?? {}),
		}));
		return {
			action: "get_channel_audience",
			connection_id: args.connection_id,
			audiences: enriched,
		};
	}

	// Per-agent view (legacy/agent-scoped).
	if (!args.agent_id) {
		return { error: "Provide exactly one of agent_id / connection_id" };
	}
	if (!(await assertAgentInOrg(organizationId, args.agent_id))) {
		return { error: "Agent not found" };
	}
	const rows = await resolveBoundChannelRows(sql, {
		organizationId,
		agentId: args.agent_id,
	});
	const audiences = await getChannelAudiences(sql, {
		organizationId,
		userId: userId ?? null,
		rows,
	});
	return { action: "get_channel_audience", agent_id: args.agent_id, audiences };
}

interface ConnectionChannelRow {
	id: string;
	platform: string;
	channel_id: string;
	team_id: string | null;
	created_at: Date;
	agent_id: string;
	agent_name: string | null;
}

/**
 * Channels bound through ONE connection (by numeric connection id), each with
 * the binding's agent. Mirrors branch (A) of resolveBoundChannelRows — a binding
 * matches its connection by the unified connection_id link, falling back to the
 * legacy (org, agent, platform) tuple — but scoped to a single connection and
 * with the agent joined. Visibility-gated (mirrors read_channel_feed): anonymous
 * sees org-visible connections only; a non-admin member sees org + own; owners /
 * admins see all.
 */
async function resolveConnectionChannelRows(
	sql: ReturnType<typeof getDb>,
	organizationId: string,
	userId: string | null,
	connectionId: number,
): Promise<ConnectionChannelRow[]> {
	let visibilityFilter = sql``;
	if (!userId) {
		visibilityFilter = sql`AND c.visibility = 'org'`;
	} else {
		const role = await getWorkspaceRole(sql, organizationId, userId);
		if (role !== "owner" && role !== "admin") {
			visibilityFilter = sql`AND (c.visibility = 'org' OR c.created_by = ${userId})`;
		}
	}
	return (await sql`
		SELECT
			CASE WHEN c.slug LIKE 'agentconn-%'
				THEN substring(c.slug from 11) ELSE c.slug END AS id,
			c.connector_key AS platform,
			b.channel_id, b.team_id, b.created_at,
			b.agent_id, a.name AS agent_name
		FROM connections c
		JOIN agent_channel_bindings b
			ON (
				b.connection_id = c.id
				OR (b.connection_id IS NULL
					AND b.organization_id = c.organization_id
					AND b.agent_id = c.agent_id
					AND b.platform = c.connector_key)
			)
		LEFT JOIN agents a
			ON a.organization_id = b.organization_id AND a.id = b.agent_id
		WHERE c.id = ${connectionId}
			AND c.organization_id = ${organizationId}
			AND c.deleted_at IS NULL
			${visibilityFilter}
		ORDER BY b.created_at ASC
	`) as ConnectionChannelRow[];
}

/** Open + bind the caller's Slack DM with a managed install's bot to an agent
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

	const externalId = args.external_id;
	const installationStore = createPostgresAppInstallationStore();
	// Confirm the install belongs to the caller's org and is ACTIVE — never bind
	// across tenants off a guessed id, and never resurrect a dead bot token.
	const install = await installationStore.resolveByExternalId("slack", externalId);
	if (
		!install ||
		install.provider !== "slack" ||
		install.organizationId !== organizationId ||
		install.status !== "active"
	) {
		return { error: "Installation not found" };
	}

	// Bot token is a `secret://` ref, resolved org-scoped. PRESERVE the
	// orgContext wrap: dropping it resolves the ref under the WRONG org and
	// silently yields no/foreign token (the 409 path).
	const tokenRef = (install.metadata.config as { botToken?: string } | undefined)
		?.botToken;
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
			externalId,
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
		install.externalTenantId,
		{ configuredBy: userId ?? undefined, organizationId },
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
		`Connected Slack DM ${dmChannelId} (team ${install.externalTenantId}) → ${args.agent_id}`,
	);
	return {
		action: "connect_channel_dm",
		success: true,
		platform: "slack",
		channel_id: dmChannelId,
		team_id: install.externalTenantId,
	};
}
