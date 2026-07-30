/**
 * Ensure the org has the out-of-the-box "feed auto-pause" Behavior so
 * feed.auto_paused signals have something to activate without requiring
 * a repair-agent subsystem.
 *
 * Idempotent: keyed by slug `feed-auto-pause`. Uses the org system agent
 * when present; otherwise no-ops (connect still succeeds).
 */

import type { BehaviorEventTrigger } from "@lobu/core/contracts/tools/manage-behaviors";
import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import { getNextNumericId } from "../tools/admin/helpers/db-helpers";
import logger from "../utils/logger";
import { PLATFORM_EVENT_FEED_AUTO_PAUSED } from "./platform-event-catalog";

export const FEED_AUTO_PAUSE_BEHAVIOR_SLUG = "feed-auto-pause";

const PROMPT = `A connector feed was auto-paused after too many consecutive sync failures.

Read the trigger signal (label + input_text + attributes) for feed id, connector, connection, consecutive failure count, and last error.

Decide the most useful next step for an org admin:
1. If last_error indicates auth/session/scopes expired — tell them to re-authenticate the connection (include connection id / connector key).
2. If last_error is worker_claim_timeout or device offline — tell them to open the paired device / Owletto and keep it online.
3. If last_error is config/missing path (takeout dirs, Mac bridge, etc.) — explain what to fix and that the feed can stay paused until then.
4. Otherwise summarize the failure and suggest inspecting the feed in Connections.

Keep the response short. Prefer client.notifications.send to org admins when available; do not unpause the feed automatically.`;

/**
 * Install (or no-op if present) the feed-auto-pause Behavior, adding the
 * given connector_key to its event triggers. Call after a connection is
 * created so the org starts with coverage for that connector's feeds.
 */
export async function ensureFeedAutoPauseBehavior(args: {
	organizationId: string;
	connectorKey: string;
	createdBy?: string | null;
	db?: DbClient;
}): Promise<{ created: boolean; behaviorId: number | null }> {
	const sql = args.db ?? getDb();

	const eventTrigger: BehaviorEventTrigger = {
		kind: "event",
		connector_key: args.connectorKey,
		event_types: [PLATFORM_EVENT_FEED_AUTO_PAUSED],
		execution: "turn",
		active_run: "coalesce",
		output: "silent",
	};

	const existing = (await sql`
		SELECT id, triggers
		FROM watchers
		WHERE organization_id = ${args.organizationId}
		  AND slug = ${FEED_AUTO_PAUSE_BEHAVIOR_SLUG}
		  AND status = 'active'
		LIMIT 1
	`) as Array<{ id: number; triggers: unknown }>;

	if (existing.length > 0) {
		const triggers = Array.isArray(existing[0].triggers)
			? (existing[0].triggers as BehaviorEventTrigger[])
			: [];
		const hasConnector = triggers.some(
			(t) =>
				t.kind === "event" &&
				t.connector_key === args.connectorKey &&
				Array.isArray(t.event_types) &&
				t.event_types.includes(PLATFORM_EVENT_FEED_AUTO_PAUSED),
		);
		if (hasConnector) {
			return { created: false, behaviorId: Number(existing[0].id) };
		}
		const nextTriggers = [...triggers, eventTrigger];
		await sql`
			UPDATE watchers
			SET triggers = ${sql.json(nextTriggers)},
			    updated_at = current_timestamp
			WHERE id = ${existing[0].id}
		`;
		return { created: false, behaviorId: Number(existing[0].id) };
	}

	const orgRows = (await sql`
		SELECT system_agent_id FROM organization WHERE id = ${args.organizationId} LIMIT 1
	`) as Array<{ system_agent_id: string | null }>;
	const agentId = orgRows[0]?.system_agent_id;
	if (!agentId) {
		logger.debug(
			{ organization_id: args.organizationId },
			"[feed-auto-pause] no system agent — skip Behavior install",
		);
		return { created: false, behaviorId: null };
	}

	const createdBy = args.createdBy ?? agentId;

	try {
		const behaviorId = await sql.begin(async (tx) => {
			const watcherId = await getNextNumericId(tx, "watchers");
			const versionId = await getNextNumericId(tx, "watcher_versions");

			await tx`
				INSERT INTO watchers (
					id, name, slug, description, organization_id, entity_ids,
					schedule, next_run_at, triggers, agent_id, model_config,
					sources, version, current_version_id, tags,
					status, created_by, created_at, updated_at, watcher_group_id,
					agent_kind, notification_channel, notification_priority, min_cooldown_seconds
				) VALUES (
					${watcherId},
					'Feed auto-pause helper',
					${FEED_AUTO_PAUSE_BEHAVIOR_SLUG},
					'Notifies when Lobu hard-pauses a feed after consecutive sync failures.',
					${args.organizationId},
					'{}'::bigint[],
					NULL, NULL,
					${tx.json([eventTrigger])},
					${agentId},
					'{}'::jsonb,
					'[]'::jsonb,
					1, NULL,
					ARRAY['platform', 'feed-health']::text[],
					'active', ${createdBy},
					current_timestamp, current_timestamp, ${watcherId},
					'lobu', 'notification', 'high', 0
				)
			`;

			await tx`
				INSERT INTO watcher_versions (
					id, watcher_id, version, name, description, prompt,
					version_sources, change_notes, created_by, created_at
				) VALUES (
					${versionId}, ${watcherId}, 1,
					'Feed auto-pause helper',
					'Notifies when Lobu hard-pauses a feed after consecutive sync failures.',
					${PROMPT},
					'[]'::jsonb,
					'Installed on connection create',
					${createdBy},
					current_timestamp
				)
			`;

			await tx`
				UPDATE watchers SET current_version_id = ${versionId}
				WHERE id = ${watcherId}
			`;

			return watcherId;
		});

		logger.info(
			{
				organization_id: args.organizationId,
				behavior_id: behaviorId,
				connector_key: args.connectorKey,
			},
			"[feed-auto-pause] installed default Behavior",
		);
		return { created: true, behaviorId };
	} catch (error) {
		// Concurrent connect on another replica may race the unique slug.
		logger.warn(
			{
				organization_id: args.organizationId,
				connector_key: args.connectorKey,
				error: String(error),
			},
			"[feed-auto-pause] install failed (non-fatal)",
		);
		return { created: false, behaviorId: null };
	}
}
