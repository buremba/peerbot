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
import { resolveBindingTeam } from "../../../../gateway/channels/binding-scope-resolver";
import { scheduleChannelBindConfirmation } from "../../../../gateway/channels/bind-channel-notify";
import {
	runtimeConnectionIdToSlug,
	slugToRuntimeConnectionId,
} from "../../../../lobu/stores/connections-projection";
import {
	createSlackWebApi,
	type SlackWebApi,
} from "../../../../gateway/connections/slack-web";
import { maybeSendSlackWorkspaceWelcome } from "../../../../gateway/connections/slack-connection-coordinator";
import {
	resolveSecretValue,
	SecretStoreRegistry,
} from "../../../../gateway/secrets";
import { orgContext } from "../../../../lobu/stores/org-context";
import { PostgresSecretStore } from "../../../../lobu/stores/postgres-secret-store";
import {
	resolveAboutEntityRefs,
	setManualChannelAboutEdges,
	syncConnectionChannelAboutEdges,
} from "../../../../authz/channel-about";
import { canonicalSlackChannelId } from "../../../../preview/slack";
import { getConfiguredPublicOrigin } from "../../../../utils/public-origin";
import { assertEntityIdsInOrg } from "../../helpers/db-helpers";
import type { ToolContext } from "../../../registry";
import type { ConnectionsArgs, ManageConnectionsResult } from "../schemas";

type ChannelBindingInput =
	| string
	| { channel_id: string; about?: Array<number | string> };

type NormalizedChannelSpec = {
	channelId: string;
	/** The workspace parsed from a declarative `T…/channel` spec, when present.
	 *  Preserved as a trusted per-channel workspace hint so a Grid org-wide
	 *  install (whose connection tenant id is the enterprise `E…`) still stamps
	 *  the real workspace on the binding instead of dropping it. */
	teamHint?: string;
	about?: Array<number | string>;
};

function normalizeChannelSpec(
	input: ChannelBindingInput,
	connectorKey: string,
	externalTenantId: string | null,
): NormalizedChannelSpec | { error: string } {
	const raw =
		typeof input === "string" ? { channel_id: input, about: undefined } : input;
	let channelId = raw.channel_id.trim();
	if (!channelId) return { error: "Channel ids cannot be empty" };
	let teamHint: string | undefined;
	if (connectorKey === "slack") {
		const slash = channelId.indexOf("/");
		if (slash >= 0) {
			const teamId = channelId.slice(0, slash);
			channelId = channelId.slice(slash + 1);
			// Only reject a `T…/channel` spec against a WORKSPACE tenant id. A Grid
			// org-wide install stores its enterprise `E…` in external_tenant_id, so
			// a `T…` prefix there is the channel's real workspace, NOT a mismatch —
			// preserve it as the binding team hint rather than reject.
			if (
				externalTenantId &&
				externalTenantId.startsWith("T") &&
				teamId !== externalTenantId
			) {
				return {
					error: `Channel ${raw.channel_id} belongs to a different Slack workspace`,
				};
			}
			if (teamId) teamHint = teamId;
		}
		channelId = canonicalSlackChannelId(channelId);
	}
	return { channelId, teamHint, about: raw.about };
}

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

async function resolveAgentBindNotice(
	organizationId: string,
	agentId: string,
): Promise<{ name: string; url?: string }> {
	const sql = getDb();
	const rows = (await sql`
		SELECT a.name, o.slug AS org_slug
		FROM agents a
		JOIN organization o ON o.id = a.organization_id
		WHERE a.id = ${agentId} AND a.organization_id = ${organizationId}
		LIMIT 1
	`) as Array<{ name: string | null; org_slug: string | null }>;
	const row = rows[0];
	const name = row?.name?.trim() || agentId;
	const origin = getConfiguredPublicOrigin()?.replace(/\/+$/, "");
	const orgSlug = row?.org_slug?.trim();
	const url =
		origin && orgSlug
			? `${origin}/${orgSlug}/agents/${agentId}/behaviors`
			: undefined;
	return { name, url };
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

/**
 * After a Slack channel binding lands, best-effort fire the installer's one-time
 * "you're all set" welcome DM. No-op for non-Slack platforms, for a bind with no
 * team, or when the workspace isn't a claimed OAuth install / was already
 * welcomed (the coordinator's atomic marker decides). Never throws — a welcome
 * failure must not fail the bind.
 */
async function fireSlackWelcomeAfterBind(
	platform: string,
	teamId: string | undefined,
): Promise<void> {
	if (platform !== "slack" || !teamId) return;
	try {
		await maybeSendSlackWorkspaceWelcome({
			teamId,
			secretStore: channelSecretStore(),
		});
	} catch (error) {
		logger.warn("Slack welcome DM after bind failed", {
			teamId,
			error: String(error),
		});
	}
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

/**
 * Validate a per-binding model override against the agent's `models` list.
 * Returns an error string, or null when the model is acceptable.
 *
 * Rules:
 *   - unset ⇒ ok (the binding inherits the agent/org default).
 *   - "auto" (or any non-`<slug>/<model>` shape) ⇒ rejected: `auto` is gone
 *     repo-wide, and a binding override must be an explicit concrete ref.
 *   - non-empty agent `models` list ⇒ the override MUST be an exact member.
 *   - empty/absent agent `models` list ⇒ any explicit `<slug>/<model>` ref is
 *     accepted (the agent allows all providers).
 */
async function validateBindingModel(
	organizationId: string,
	agentId: string,
	model: string | undefined,
): Promise<string | null> {
	const ref = model?.trim();
	if (!ref) return null;
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1 || ref.slice(slash + 1) === "auto") {
		return `Invalid binding model "${ref}": use an explicit "<provider>/<model>" ref (\"auto\" is not supported).`;
	}
	const sql = getDb();
	const rows = (await sql`
		SELECT models FROM agents
		WHERE id = ${agentId} AND organization_id = ${organizationId}
		LIMIT 1
	`) as Array<{ models: string[] | null }>;
	const models = rows[0]?.models;
	if (Array.isArray(models) && models.length > 0 && !models.includes(ref)) {
		return `Model "${ref}" is not in this agent's allowed models list. Pick one of: ${models.join(", ")}.`;
	}
	return null;
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

	// Gate the per-binding model override against the agent's EXACT allowed
	// list. A Listen binding must not be able to route this channel to a model
	// the agent isn't allowed to use.
	const modelError = await validateBindingModel(
		organizationId,
		args.agent_id,
		args.model,
	);
	if (modelError) return { error: modelError };

	const sql = getDb();
	const connections = (await sql`
		SELECT id, slug, connector_key, external_tenant_id
		FROM connections
		WHERE id = ${args.connection_id}
			AND organization_id = ${organizationId}
			AND credential_mode IS NOT NULL
			AND status = 'active'
			AND deleted_at IS NULL
		LIMIT 1
	`) as Array<{
		id: number;
		slug: string;
		connector_key: string;
		external_tenant_id: string | null;
	}>;
	const connection = connections[0];
	if (!connection) return { error: "Active chat connection not found" };
	// The binding's team is the CONCRETE workspace the channel lives in — the
	// connector-owned resolver decides how to derive it (for Slack Grid the
	// connection's tenant id is the enterprise `E…`, never the workspace). Null
	// = unknown yet; the row heals from the first inbound message.
	const teamId =
		(await resolveBindingTeam({
			connection: {
				connectorKey: connection.connector_key,
				externalTenantId: connection.external_tenant_id,
				connectionId: connection.id,
				organizationId,
			},
			channelId,
		})) ?? undefined;

	const svc = new ChannelBindingService();
	const runtimeConnectionId = slugToRuntimeConnectionId(connection.slug);
	const existing = await svc.getBindingForConnection(
		runtimeConnectionId,
		channelId,
		organizationId,
	);
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
	const agentNotice = await resolveAgentBindNotice(
		organizationId,
		args.agent_id,
	);
	scheduleChannelBindConfirmation({
		connectionSlug: connection.slug,
		platform: connection.connector_key,
		channelId,
		agentId: args.agent_id,
		agentName: agentNotice.name,
		agentUrl: agentNotice.url,
		previousAgentId: existing?.agentId,
	});
	await fireSlackWelcomeAfterBind(connection.connector_key, teamId);
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

	const normalized: NormalizedChannelSpec[] = [];
	for (const input of args.channels) {
		const spec = normalizeChannelSpec(
			input,
			connection.connector_key,
			connection.external_tenant_id,
		);
		if ("error" in spec) return { error: spec.error };
		normalized.push(spec);
	}
	const desired = new Set(normalized.map((c) => c.channelId));

	const svc = new ChannelBindingService();
	const existing = (
		await svc.listBindings(args.agent_id, organizationId)
	).filter((binding) => binding.connectionId === String(connection.id));
	const existingIds = new Set(existing.map((binding) => binding.channelId));
	const existingTeamByChannel = new Map(
		existing.map((binding) => [binding.channelId, binding.teamId]),
	);

	// Resolve each channel's CONCRETE workspace BEFORE opening the txn — the
	// connector resolver may make a Slack HTTP round-trip (conversations.info), and
	// an external call must never hold a pooled txn connection open. A declarative
	// `T…/channel` spec supplies a trusted workspace hint; otherwise the resolver
	// decides (returns null = unknown yet, healing from inbound — never the
	// enterprise id). An EXISTING binding already carries its resolved team, so
	// reuse it rather than re-round-trip. This same team keys BOTH the binding
	// write and the about edge, so a Grid org-wide install (connection tenant =
	// enterprise `E…`) never mis-keys the about edge onto a phantom `E…:C…` entity.
	const teamHintByChannel = new Map(
		normalized.map((c) => [c.channelId, c.teamHint]),
	);
	const resolvedTeamByChannel = new Map<string, string | undefined>();
	for (const channelId of desired) {
		const existingTeam = existingTeamByChannel.get(channelId);
		if (existingTeam) {
			resolvedTeamByChannel.set(channelId, existingTeam);
			continue;
		}
		resolvedTeamByChannel.set(
			channelId,
			(await resolveBindingTeam({
				connection: {
					connectorKey: connection.connector_key,
					externalTenantId: connection.external_tenant_id,
					connectionId: connection.id,
					organizationId,
				},
				channelId,
				workspaceHint: teamHintByChannel.get(channelId) ?? null,
			})) ?? undefined,
		);
	}

	const aboutChannels: Array<{
		channelId: string;
		teamId: string | undefined;
		aboutEntityIds: number[];
	}> = [];
	try {
		for (const spec of normalized) {
			const teamId = resolvedTeamByChannel.get(spec.channelId);
			if (!spec.about?.length) {
				aboutChannels.push({
					channelId: spec.channelId,
					teamId,
					aboutEntityIds: [],
				});
				continue;
			}
			const aboutEntityIds = await resolveAboutEntityRefs(
				organizationId,
				spec.about,
				sql,
			);
			await assertEntityIdsInOrg(sql, organizationId, aboutEntityIds);
			aboutChannels.push({ channelId: spec.channelId, teamId, aboutEntityIds });
		}
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "Failed to resolve channel about links",
		};
	}

	let reconcileResult: {
		bound: string[];
		removed: string[];
		aboutLinked: number;
		aboutRemoved: number;
	};

	try {
		reconcileResult = await sql.begin(async (tx) => {
			const bound: string[] = [];
			for (const channelId of desired) {
				if (!existingIds.has(channelId)) {
					await svc.createBinding(
						args.agent_id,
						connection.connector_key,
						channelId,
						resolvedTeamByChannel.get(channelId),
						{
							configuredBy: userId ?? undefined,
							organizationId,
							connectionId: String(connection.id),
							sql: tx,
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
					{ sql: tx },
				);
				removed.push(binding.channelId);
			}

			const aboutResult = await syncConnectionChannelAboutEdges({
				organizationId,
				connectionId: connection.id,
				connectorKey: connection.connector_key,
				channels: aboutChannels,
				userId,
				sql: tx,
			});
			return {
				bound,
				removed,
				aboutLinked: aboutResult.linked,
				aboutRemoved: aboutResult.removed,
			};
		});
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "Failed to sync channel about links",
		};
	}
	const { bound, removed, aboutLinked, aboutRemoved } = reconcileResult;
	if (bound.length > 0) {
		await fireSlackWelcomeAfterBind(
			connection.connector_key,
			connection.external_tenant_id ?? undefined,
		);
	}

	return {
		action: "sync_channel_bindings",
		success: true,
		bound,
		removed,
		about_linked: aboutLinked,
		about_removed: aboutRemoved,
	};
}

/** Set manual business-entity links for a chat channel (UI picker). */
export async function handleSetChannelAbout(
	args: Extract<ConnectionsArgs, { action: "set_channel_about" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId, userId } = ctx;
	const sql = getDb();
	const rows = (await sql`
		SELECT id, connector_key, external_tenant_id
		FROM connections
		WHERE id = ${args.connection_id}
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
	// The manual about edge must key on the channel's CONCRETE workspace — the
	// SAME real team the binding uses — never the connection's stored tenant id
	// (a Grid org-wide install stores the enterprise `E…` there). Prefer the team
	// already stamped on this channel's binding; otherwise ask the connector's
	// resolver (never the `E…`, null = unknown yet).
	const boundTeamRows = (await sql`
		SELECT team_id
		FROM agent_channel_bindings
		WHERE organization_id = ${organizationId}
			AND connection_id = ${connection.id}
			AND channel_id = ${args.channel_id}
			AND team_id IS NOT NULL
		LIMIT 1
	`) as Array<{ team_id: string | null }>;
	const teamId =
		boundTeamRows[0]?.team_id ??
		(await resolveBindingTeam({
			connection: {
				connectorKey: connection.connector_key,
				externalTenantId: connection.external_tenant_id,
				connectionId: connection.id,
				organizationId,
			},
			channelId: args.channel_id,
		})) ??
		undefined;
	try {
		await assertEntityIdsInOrg(sql, organizationId, args.about_entity_ids);
		await setManualChannelAboutEdges({
			organizationId,
			connectionId: connection.id,
			connectorKey: connection.connector_key,
			teamId,
			channelId: args.channel_id,
			aboutEntityIds: args.about_entity_ids,
			userId,
			sql,
		});
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "Failed to set channel about links",
		};
	}
	return {
		action: "set_channel_about",
		success: true,
		connection_id: connection.id,
		channel_id: args.channel_id,
		about_entity_ids: args.about_entity_ids,
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
		SELECT id, slug, connector_key, external_tenant_id, config
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
		slug: string;
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
	const boundChannelId = canonicalSlackChannelId(dmChannelId);
	const svc = new ChannelBindingService();
	const runtimeConnectionId = slugToRuntimeConnectionId(connection.slug);
	const existing = await svc.getBindingForConnection(
		runtimeConnectionId,
		boundChannelId,
		organizationId,
	);
	// Resolve the DM's concrete workspace (never the enterprise id on a Grid
	// org-wide install). Null = unknown yet; heals from the first inbound DM.
	const dmTeamId =
		(await resolveBindingTeam({
			connection: {
				connectorKey: "slack",
				externalTenantId: connection.external_tenant_id,
				connectionId: connection.id,
				organizationId,
			},
			channelId: boundChannelId,
		})) ?? undefined;
	await svc.createBinding(
		args.agent_id,
		"slack",
		boundChannelId,
		dmTeamId,
		{
			configuredBy: userId ?? undefined,
			organizationId,
			connectionId: String(connection.id),
		},
	);
	const agentNotice = await resolveAgentBindNotice(
		organizationId,
		args.agent_id,
	);
	scheduleChannelBindConfirmation({
		connectionSlug: connection.slug,
		platform: "slack",
		channelId: boundChannelId,
		agentId: args.agent_id,
		agentName: agentNotice.name,
		agentUrl: agentNotice.url,
		previousAgentId: existing?.agentId,
	});

	await fireSlackWelcomeAfterBind(
		"slack",
		connection.external_tenant_id ?? undefined,
	);
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
