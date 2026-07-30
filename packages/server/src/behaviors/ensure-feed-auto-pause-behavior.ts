/**
 * Ensure the org has the out-of-the-box "feed auto-pause" Behavior so
 * feed.auto_paused signals have something to activate without a repair-agent
 * subsystem.
 *
 * Idempotent: keyed by slug `feed-auto-pause`. Uses the org system agent
 * when present; otherwise no-ops (connect still succeeds).
 *
 * Multi-replica: takes a transaction-scoped advisory lock per org before
 * read-modify-write on the Behavior row so concurrent connects cannot clobber
 * each other's connector_key triggers.
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

function buildEventTrigger(connectorKey: string): BehaviorEventTrigger {
	return {
		kind: "event",
		connector_key: connectorKey,
		event_types: [PLATFORM_EVENT_FEED_AUTO_PAUSED],
		execution: "turn",
		active_run: "coalesce",
		output: "silent",
	};
}

function hasConnectorTrigger(
	triggers: BehaviorEventTrigger[],
	connectorKey: string,
): boolean {
	return triggers.some(
		(t) =>
			t.kind === "event" &&
			t.connector_key === connectorKey &&
			Array.isArray(t.event_types) &&
			t.event_types.includes(PLATFORM_EVENT_FEED_AUTO_PAUSED),
	);
}

/** Prefer owner, then admin, as created_by (FK → user.id). */
async function resolveOrgActorUserId(
	sql: DbClient,
	organizationId: string,
): Promise<string | null> {
	const rows = (await sql`
		SELECT "userId" AS user_id
		FROM "member"
		WHERE "organizationId" = ${organizationId}
		  AND role IN ('owner', 'admin')
		ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, "createdAt" ASC
		LIMIT 1
	`) as Array<{ user_id: string }>;
	return rows[0]?.user_id ?? null;
}

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
	const eventTrigger = buildEventTrigger(args.connectorKey);

	try {
		return await sql.begin(async (tx) => {
			await tx`
				SELECT pg_advisory_xact_lock(
					hashtext(${`feed-auto-pause:${args.organizationId}`})
				)
			`;

			const existing = (await tx`
				SELECT id, triggers
				FROM watchers
				WHERE organization_id = ${args.organizationId}
				  AND slug = ${FEED_AUTO_PAUSE_BEHAVIOR_SLUG}
				  AND status = 'active'
				LIMIT 1
				FOR UPDATE
			`) as Array<{ id: number; triggers: unknown }>;

			if (existing.length > 0) {
				const triggers = Array.isArray(existing[0].triggers)
					? (existing[0].triggers as BehaviorEventTrigger[])
					: [];
				if (hasConnectorTrigger(triggers, args.connectorKey)) {
					return { created: false, behaviorId: Number(existing[0].id) };
				}
				const nextTriggers = [...triggers, eventTrigger];
				await tx`
					UPDATE watchers
					SET triggers = ${tx.json(nextTriggers)},
					    updated_at = current_timestamp
					WHERE id = ${existing[0].id}
				`;
				return { created: false, behaviorId: Number(existing[0].id) };
			}

			const orgRows = (await tx`
				SELECT system_agent_id FROM organization
				WHERE id = ${args.organizationId}
				LIMIT 1
			`) as Array<{ system_agent_id: string | null }>;
			const agentId = orgRows[0]?.system_agent_id;
			if (!agentId) {
				logger.debug(
					{ organization_id: args.organizationId },
					"[feed-auto-pause] no system agent — skip Behavior install",
				);
				return { created: false, behaviorId: null };
			}

			// created_by is FK to user(id) — never use system_agent_id here.
			const createdBy =
				args.createdBy ??
				(await resolveOrgActorUserId(tx, args.organizationId));
			if (!createdBy) {
				logger.warn(
					{ organization_id: args.organizationId },
					"[feed-auto-pause] no owner/admin user — skip Behavior install",
				);
				return { created: false, behaviorId: null };
			}

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

			logger.info(
				{
					organization_id: args.organizationId,
					behavior_id: watcherId,
					connector_key: args.connectorKey,
				},
				"[feed-auto-pause] installed default Behavior",
			);
			return { created: true, behaviorId: watcherId };
		});
	} catch (error) {
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

/**
 * Backfill coverage for connections that already exist.
 */
export async function reconcileFeedAutoPauseBehavior(args: {
	organizationId: string;
	createdBy?: string | null;
	db?: DbClient;
}): Promise<void> {
	const sql = args.db ?? getDb();
	const rows = (await sql`
		SELECT DISTINCT connector_key
		FROM connections
		WHERE organization_id = ${args.organizationId}
		  AND deleted_at IS NULL
	`) as Array<{ connector_key: string }>;

	for (const row of rows) {
		if (!row.connector_key) continue;
		await ensureFeedAutoPauseBehavior({
			organizationId: args.organizationId,
			connectorKey: row.connector_key,
			createdBy: args.createdBy,
			db: args.db,
		});
	}
}

/**
 * Rollout backfill for orgs that still lack full feed-auto-pause coverage.
 * Selects only orgs that still need work so progress is not stuck on the
 * first 50 forever.
 */
export async function backfillFeedAutoPauseBehaviors(args?: {
	limitOrgs?: number;
	db?: DbClient;
}): Promise<{ orgs: number; errors: number }> {
	const sql = args?.db ?? getDb();
	const limitOrgs = Math.min(Math.max(args?.limitOrgs ?? 50, 1), 200);

	// Orgs with system agent + live connections that either lack the Behavior
	// entirely or have a connector_key not yet on its event triggers.
	const orgs = (await sql`
		SELECT o.id AS organization_id
		FROM organization o
		WHERE o.system_agent_id IS NOT NULL
		  AND EXISTS (
		    SELECT 1 FROM connections c
		    WHERE c.organization_id = o.id
		      AND c.deleted_at IS NULL
		  )
		  AND (
		    NOT EXISTS (
		      SELECT 1 FROM watchers w
		      WHERE w.organization_id = o.id
		        AND w.slug = ${FEED_AUTO_PAUSE_BEHAVIOR_SLUG}
		        AND w.status = 'active'
		    )
		    OR EXISTS (
		      SELECT 1
		      FROM connections c
		      WHERE c.organization_id = o.id
		        AND c.deleted_at IS NULL
		        AND NOT EXISTS (
		          SELECT 1
		          FROM watchers w,
		               jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) t
		          WHERE w.organization_id = o.id
		            AND w.slug = ${FEED_AUTO_PAUSE_BEHAVIOR_SLUG}
		            AND w.status = 'active'
		            AND t->>'kind' = 'event'
		            AND t->>'connector_key' = c.connector_key
		            AND t->'event_types' ? ${PLATFORM_EVENT_FEED_AUTO_PAUSED}
		        )
		    )
		  )
		ORDER BY o.id
		LIMIT ${limitOrgs}
	`) as Array<{ organization_id: string }>;

	let errors = 0;
	for (const org of orgs) {
		try {
			const actor = await resolveOrgActorUserId(sql, String(org.organization_id));
			if (!actor) {
				errors++;
				logger.warn(
					{ organization_id: org.organization_id },
					"[feed-auto-pause] backfill skipped — no owner/admin user",
				);
				continue;
			}
			await reconcileFeedAutoPauseBehavior({
				organizationId: String(org.organization_id),
				createdBy: actor,
				db: sql,
			});
		} catch (err) {
			errors++;
			logger.warn(
				{
					organization_id: org.organization_id,
					error: String(err),
				},
				"[feed-auto-pause] backfill org failed",
			);
		}
	}
	return { orgs: orgs.length, errors };
}
