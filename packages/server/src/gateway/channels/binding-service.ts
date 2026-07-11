import { createLogger } from "@lobu/core";
import { type DbClient, getDb, tsTime } from "../../db/client.js";
import { runtimeConnectionIdToSlug } from "../../lobu/stores/connections-projection.js";
import { requireOrgId } from "../../lobu/stores/org-context.js";
import {
	resolveStreamingChannelFeedId,
	softDeleteStreamingChannelFeed,
} from "./channel-feed.js";

const logger = createLogger("channel-binding-service");

/**
 * Channel binding - links a platform channel to a specific agent.
 *
 * Backed by `public.agent_channel_bindings`; only the columns that exist on
 * that table are persisted today (`platform`, `channel_id`, `team_id`,
 * `agent_id`, `model`, `created_at`).
 */
interface ChannelBinding {
	platform: string;
	channelId: string;
	agentId: string;
	teamId?: string;
	/** Org that owns this binding. Preview messages arrive on a connection in a
	 * different org, so the caller needs the binding's own org to route. */
	organizationId?: string;
	/** Connection this binding routes through (the unified `connections.id`).
	 * Set once the binding is linked; used to materialize / soft-delete the
	 * channel's streaming feed. */
	connectionId?: string;
	/** Optional per-binding (Listen behavior) model override — a `provider/model`
	 * ref or "auto". When set it wins the layered fallback at inbound enqueue;
	 * undefined = fall back to the agent, then org, default. */
	model?: string;
	createdAt: number;
}

function rowToBinding(row: Record<string, any>): ChannelBinding {
	return {
		platform: row.platform,
		channelId: row.channel_id,
		teamId: row.team_id ?? undefined,
		agentId: row.agent_id,
		organizationId: row.organization_id ?? undefined,
		connectionId:
			row.connection_id != null ? String(row.connection_id) : undefined,
		model:
			typeof row.model === "string" && row.model.trim()
				? row.model.trim()
				: undefined,
		createdAt: tsTime(row.created_at),
	};
}

/**
 * Service for managing channel-to-agent bindings, backed by Postgres.
 * Read-through to PG.
 */
export class ChannelBindingService {
	/** Resolve the binding for the concrete bot connection handling an inbound
	 * message. This is the authoritative read path when multiple apps from the
	 * same provider share a workspace and channel. */
	async getBindingForConnection(
		connectionId: string,
		channelId: string,
		connectionOrganizationId: string,
		crossOrg = false,
	): Promise<ChannelBinding | null> {
		const sql = getDb();
		const slug = runtimeConnectionIdToSlug(connectionId);
		const rows = crossOrg
			? await sql`
          SELECT b.*
          FROM agent_channel_bindings b
          JOIN connections c ON c.id = b.connection_id
          WHERE c.organization_id = ${connectionOrganizationId}
            AND c.slug = ${slug}
            AND c.deleted_at IS NULL
            AND b.channel_id = ${channelId}
          ORDER BY b.created_at DESC
          LIMIT 1
        `
			: await sql`
          SELECT b.*
          FROM agent_channel_bindings b
          JOIN connections c ON c.id = b.connection_id
          WHERE c.organization_id = ${connectionOrganizationId}
            AND c.slug = ${slug}
            AND c.deleted_at IS NULL
            AND b.organization_id = ${connectionOrganizationId}
            AND b.channel_id = ${channelId}
          LIMIT 1
        `;
		return rows[0] ? rowToBinding(rows[0]) : null;
	}

	/**
	 * Lazy self-heal: converge a binding's `team_id` to the real WORKSPACE id an
	 * inbound message carries. A binding written before its workspace was known
	 * (the resolver returned null → NULL team) heals here on the first message.
	 *
	 * Guarded to ONLY fill an unknown (NULL/empty) team — never overwrite an
	 * already-set workspace, so a stray/foreign `team_id` on a message can't
	 * repoint a live binding. Keyed on the concrete (org, connection, channel).
	 * Best-effort by contract: a heal failure must never block message routing.
	 */
	async healBindingTeam(
		connectionId: string,
		channelId: string,
		organizationId: string,
		realTeamId: string,
	): Promise<void> {
		if (!realTeamId.trim()) return;
		const sql = getDb();
		// Resolve the binding by the concrete connection (via slug, exactly like
		// getBindingForConnection) so a runtime slug id maps to the right numeric
		// connection_id. Only fills an unknown team.
		const slug = runtimeConnectionIdToSlug(connectionId);
		await sql`
			UPDATE agent_channel_bindings b
			SET team_id = ${realTeamId}
			FROM connections c
			WHERE c.id = b.connection_id
				AND c.slug = ${slug}
				AND c.deleted_at IS NULL
				AND b.organization_id = ${organizationId}
				AND b.channel_id = ${channelId}
				AND (b.team_id IS NULL OR b.team_id = '')
		`;
	}

	async createBinding(
		agentId: string,
		platform: string,
		channelId: string,
		teamId: string | undefined,
		options: {
			configuredBy?: string;
			wasAdmin?: boolean;
			organizationId?: string;
			sql?: DbClient;
			/** Authoritative unified connection row. */
			connectionId: string;
			/** Optional per-binding model override (a `provider/model` ref or
			 *  "auto"). Undefined leaves it NULL (falls back to agent/org default). */
			model?: string;
		},
	): Promise<void> {
		const sql = options.sql ?? getDb();
		const orgId = requireOrgId(
			options?.organizationId,
			"ChannelBindingService.createBinding",
		);
		const model =
			typeof options.model === "string" && options.model.trim()
				? options.model.trim()
				: null;
		// A physical channel is scoped by the concrete bot connection, not by a
		// provider tuple. Two Slack apps in one workspace may independently bind
		// the same channel without overwriting each other.
		const rows = await sql`
        INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, connection_id, model, created_at)
        VALUES (
          ${orgId}, ${agentId}, ${platform}, ${channelId}, ${teamId ?? null},
		  ${options.connectionId}::bigint, ${model},
          now()
        )
        ON CONFLICT (organization_id, connection_id, channel_id)
          WHERE connection_id IS NOT NULL
          DO UPDATE SET agent_id = EXCLUDED.agent_id,
		    platform = EXCLUDED.platform,
		    team_id = EXCLUDED.team_id,
		    model = EXCLUDED.model,
            created_at = EXCLUDED.created_at
        RETURNING connection_id
      `;
		const linkedConnectionId =
			rows[0]?.connection_id != null ? String(rows[0].connection_id) : null;
		logger.info(`Created binding: ${platform}/${channelId} → ${agentId}`);

		// Materialize the channel as a streaming feed under its connection, so it
		// surfaces in the unified Feeds list instead of a bespoke channel island.
		// Best-effort: a feed-materialize failure must never fail the bind (recall
		// is driven by the binding, not the feed). When the connection isn't linked
		// yet (binding created before its managed install row), skip — the next
		// bind that resolves the link materializes it idempotently.
		if (linkedConnectionId) {
			await resolveStreamingChannelFeedId({
				connectionId: linkedConnectionId,
				organizationId: orgId,
				channelKey: channelId,
				sql,
			});
		}
	}

	async deleteBinding(
		agentId: string,
		channelId: string,
		connectionId: string,
		organizationId: string,
		options?: { sql?: DbClient },
	): Promise<boolean> {
		const sql = options?.sql ?? getDb();
		const orgId = requireOrgId(
			organizationId,
			"ChannelBindingService.deleteBinding",
		);
		const rows = await sql`
      SELECT * FROM agent_channel_bindings
      WHERE organization_id = ${orgId}
        AND connection_id = ${connectionId}::bigint
        AND channel_id = ${channelId}
      LIMIT 1
    `;
		const existing = rows[0] ? rowToBinding(rows[0]) : null;
		if (!existing) {
			logger.warn(
				`No binding found for connection ${connectionId}/${channelId}`,
			);
			return false;
		}
		if (existing.agentId !== agentId) {
			logger.warn(
				`Binding for connection ${connectionId}/${channelId} belongs to ${existing.agentId}, not ${agentId}`,
			);
			return false;
		}

		await sql`
          DELETE FROM agent_channel_bindings
          WHERE organization_id = ${orgId}
        AND connection_id = ${connectionId}::bigint
        AND channel_id = ${channelId}
        `;
		logger.info(
			`Deleted binding: connection ${connectionId}/${channelId} from ${agentId}`,
		);

		// The channel is no longer bound, so its streaming feed is retired
		// (soft-delete). Best-effort: the binding (the routing contract) is already
		// gone; a lingering feed row is cosmetic and never blocks the unbind. Keyed
		// by the connection the binding routed through + the channel id (= feed_key).
		if (existing.connectionId) {
			await softDeleteStreamingChannelFeed({
				connectionId: existing.connectionId,
				channelKey: channelId,
				sql,
			});
		}
		return true;
	}

	async listBindings(
		agentId: string,
		organizationId: string,
	): Promise<ChannelBinding[]> {
		const sql = getDb();
		// Org is REQUIRED: an agent id is unique only WITHIN an org (the
		// per-org "lobu-builder" system agent has the SAME id across ~20 orgs),
		// so an org-less `WHERE agent_id = …` would smear every tenant's
		// bindings for that id into one caller's view.
		const orgId = requireOrgId(
			organizationId,
			"ChannelBindingService.listBindings",
		);
		const rows = await sql`
          SELECT * FROM agent_channel_bindings
          WHERE agent_id = ${agentId} AND organization_id = ${orgId}
        `;
		return rows.map(rowToBinding);
	}

	async deleteAllBindings(
		agentId: string,
		organizationId: string,
	): Promise<number> {
		const sql = getDb();
		// Org is REQUIRED — see listBindings. An org-less DELETE would wipe
		// every tenant's bindings for a shared agent id (e.g. "lobu-builder").
		const orgId = requireOrgId(
			organizationId,
			"ChannelBindingService.deleteAllBindings",
		);
		const rows = await sql`
          DELETE FROM agent_channel_bindings
          WHERE agent_id = ${agentId} AND organization_id = ${orgId}
          RETURNING platform, channel_id, team_id, connection_id
        `;
		logger.info(`Deleted ${rows.length} bindings for agent ${agentId}`);
		// Each unbound channel's streaming feed is now orphaned; retire it. Same
		// best-effort contract as deleteBinding — the binding is already gone, a
		// lingering feed row never blocks the delete. Keyed by the connection the
		// binding routed through + the channel id (= feed_key).
		for (const row of rows) {
			if (row.connection_id != null) {
				await softDeleteStreamingChannelFeed({
					connectionId: String(row.connection_id),
					channelKey: row.channel_id,
				});
			}
		}
		return rows.length;
	}
}
