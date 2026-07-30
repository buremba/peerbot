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
			// Serialize provisioning per org (hashtext is stable; lock is tx-scoped).
			await tx`
				SELECT pg_advisory_xact_lock(
					hashtext(${`feed-auto-pause:${args.organizationId}`})
				)
			`;

			// Match on slug alone, NOT `status = 'active'`: idx_watchers_org_slug is
			// UNIQUE on (organization_id, slug) WHERE slug IS NOT NULL and is not
			// scoped by status, so an archived/deactivated helper still reserves the
			// slug. Filtering by status here would fall through to the INSERT, hit
			// the unique constraint, and lose args.connectorKey inside the
			// "install failed (non-fatal)" catch.
			const existing = (await tx`
				SELECT id, triggers, status
				FROM watchers
				WHERE organization_id = ${args.organizationId}
				  AND slug = ${FEED_AUTO_PAUSE_BEHAVIOR_SLUG}
				LIMIT 1
				FOR UPDATE
			`) as Array<{ id: number; triggers: unknown; status: string }>;

			if (existing.length > 0) {
				const triggers = Array.isArray(existing[0].triggers)
					? (existing[0].triggers as BehaviorEventTrigger[])
					: [];
				if (existing[0].status !== "active") {
					// Record coverage but never resurrect a Behavior the org turned
					// off — that is a deliberate user state, not drift.
					logger.info(
						{
							organization_id: args.organizationId,
							behavior_id: Number(existing[0].id),
							status: existing[0].status,
							connector_key: args.connectorKey,
						},
						"[feed-auto-pause] existing Behavior is not active — leaving status as-is",
					);
				}
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

			// watchers.created_by is NOT NULL with an FK to "user", so the org's
			// system agent id is NOT a usable fallback — inserting it raises a
			// constraint error that the outer catch would swallow as
			// "install failed (non-fatal)". Skip honestly instead.
			const createdBy = args.createdBy;
			if (!createdBy) {
				logger.debug(
					{
						organization_id: args.organizationId,
						connector_key: args.connectorKey,
					},
					"[feed-auto-pause] no attributable user — skip Behavior install",
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
 *
 * `ensureFeedAutoPauseBehavior` no-ops when the org has no system agent yet, so
 * a connector connected before `organization.system_agent_id` was populated
 * would never get a trigger — later connects only add their own connector_key.
 * Call this once the pointer is set so those earlier connectors are covered.
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
 * Rollout backfill: for every org that has a system agent and at least one
 * live connection, ensure the feed-auto-pause Behavior covers those connectors.
 * Bounded + single-claimant job only — not request path.
 */
export async function backfillFeedAutoPauseBehaviors(args?: {
	limitOrgs?: number;
	db?: DbClient;
}): Promise<{ orgs: number; errors: number }> {
	const sql = args?.db ?? getDb();
	const limitOrgs = Math.min(Math.max(args?.limitOrgs ?? 50, 1), 200);

	const orgs = (await sql`
		SELECT o.id AS organization_id, o.system_agent_id
		FROM organization o
		WHERE o.system_agent_id IS NOT NULL
		  AND EXISTS (
		    SELECT 1 FROM connections c
		    WHERE c.organization_id = o.id
		      AND c.deleted_at IS NULL
		  )
		ORDER BY o.id
		LIMIT ${limitOrgs}
	`) as Array<{ organization_id: string; system_agent_id: string }>;

	let errors = 0;
	for (const org of orgs) {
		try {
			await reconcileFeedAutoPauseBehavior({
				organizationId: String(org.organization_id),
				createdBy: org.system_agent_id,
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
