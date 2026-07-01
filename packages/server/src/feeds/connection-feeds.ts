import { getDb } from "../db/client.js";
import type { FeedKind, FeedSpec, FeedStatus } from "./types.js";

interface FeedRow {
	id: string;
	feed_key: string;
	kind: string;
	label: string;
	status: string;
	virtual: boolean;
	last_sync_at: Date | string | null;
	items_collected: string | number;
	target_agent_id: string | null;
}

/**
 * List every feed on a connection (all kinds), fenced to `(organization_id,
 * connection_id)` so it never scans globally. A streaming (chat) feed is
 * decorated with the agent bound to its channel via `agent_channel_bindings`
 * (channel_id = feed_key).
 */
export async function listConnectionFeeds(
	organizationId: string,
	connectionId: string,
): Promise<FeedSpec[]> {
	const sql = getDb();
	const rows = await sql<FeedRow>`
		SELECT
			f.id::text                            AS id,
			f.feed_key                            AS feed_key,
			f.kind                                AS kind,
			COALESCE(f.display_name, f.feed_key)  AS label,
			f.status                              AS status,
			f.virtual                             AS virtual,
			f.last_sync_at                        AS last_sync_at,
			f.items_collected                     AS items_collected,
			(
				SELECT b.agent_id
				FROM agent_channel_bindings b
				WHERE b.organization_id = f.organization_id
					AND b.connection_id  = f.connection_id
					AND b.channel_id     = f.feed_key
				LIMIT 1
			)                                     AS target_agent_id
		FROM feeds f
		WHERE f.organization_id = ${organizationId}
			AND f.connection_id   = ${connectionId}::bigint
			AND f.deleted_at IS NULL
		ORDER BY COALESCE(f.last_sync_at, f.updated_at) DESC
	`;

	return rows.map((r) => ({
		id: r.id,
		feedKey: r.feed_key,
		kind: r.kind as FeedKind,
		connectionId,
		label: r.label,
		status: r.status as FeedStatus,
		virtual: r.virtual,
		lastSyncAt:
			r.last_sync_at == null ? null : new Date(r.last_sync_at).toISOString(),
		itemsCollected: Number(r.items_collected),
		targetAgentId: r.target_agent_id,
	}));
}
