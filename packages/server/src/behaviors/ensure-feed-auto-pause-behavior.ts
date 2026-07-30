/**
 * Ensure the org has the catalog "feed-auto-pause" Behavior installed, with
 * per-connector event triggers for feed.auto_paused.
 *
 * Source of truth for name / prompt / tags / notification defaults is
 * BEHAVIOR_CATALOG_TEMPLATES (id `feed-auto-pause`). This module only:
 *   1. materializes that catalog template once per org, and
 *   2. merges connector_key-scoped event triggers as connections appear.
 *
 * Multi-replica: transaction-scoped advisory lock per org before RMW.
 */

import type { BehaviorEventTrigger } from "@lobu/core/contracts/tools/manage-behaviors";
import { BEHAVIOR_CATALOG_TEMPLATES } from "../catalog/behavior-templates";
import type { DbClient } from "../db/client";
import { getDb, pgTextArray } from "../db/client";
import { getNextNumericId } from "../tools/admin/helpers/db-helpers";
import logger from "../utils/logger";
import { PLATFORM_EVENT_FEED_AUTO_PAUSED } from "./platform-event-catalog";

/** Catalog entry id + installed Behavior slug (must stay in sync with templates). */
export const FEED_AUTO_PAUSE_CATALOG_ID = "feed-auto-pause";
export const FEED_AUTO_PAUSE_BEHAVIOR_SLUG = FEED_AUTO_PAUSE_CATALOG_ID;

function feedAutoPauseCatalogTemplate(): {
	name: string;
	slug: string;
	description: string | null;
	prompt: string;
	tags: string[];
	notification_channel: string;
	notification_priority: string;
} {
	const entry = BEHAVIOR_CATALOG_TEMPLATES.find(
		(t) => t.id === FEED_AUTO_PAUSE_CATALOG_ID,
	);
	if (!entry) {
		throw new Error(
			`Behavior catalog is missing required template '${FEED_AUTO_PAUSE_CATALOG_ID}'`,
		);
	}
	const detail = entry.detail ?? {};
	const slug =
		typeof detail.slug === "string" && detail.slug.length > 0
			? detail.slug
			: FEED_AUTO_PAUSE_BEHAVIOR_SLUG;
	const prompt = typeof detail.prompt === "string" ? detail.prompt : "";
	if (!prompt) {
		throw new Error(
			`Behavior catalog template '${FEED_AUTO_PAUSE_CATALOG_ID}' has no prompt`,
		);
	}
	const tags = Array.isArray(detail.tags)
		? detail.tags.filter((t): t is string => typeof t === "string")
		: ["platform", "feed-health"];
	return {
		name: entry.name,
		slug,
		description:
			typeof entry.description === "string" ? entry.description : null,
		prompt,
		tags,
		notification_channel:
			typeof detail.notification_channel === "string"
				? detail.notification_channel
				: "notification",
		notification_priority:
			typeof detail.notification_priority === "string"
				? detail.notification_priority
				: "high",
	};
}

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
 * Install the catalog feed-auto-pause template if missing, then ensure this
 * connector_key has a feed.auto_paused event trigger on it.
 */
export async function ensureFeedAutoPauseBehavior(args: {
	organizationId: string;
	connectorKey: string;
	createdBy?: string | null;
	db?: DbClient;
}): Promise<{ created: boolean; behaviorId: number | null }> {
	const sql = args.db ?? getDb();
	const eventTrigger = buildEventTrigger(args.connectorKey);
	const template = feedAutoPauseCatalogTemplate();

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
				  AND slug = ${template.slug}
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
					${template.name},
					${template.slug},
					${template.description},
					${args.organizationId},
					'{}'::bigint[],
					NULL, NULL,
					${tx.json([eventTrigger])},
					${agentId},
					'{}'::jsonb,
					'[]'::jsonb,
					1, NULL,
					${pgTextArray(template.tags)}::text[],
					'active', ${createdBy},
					current_timestamp, current_timestamp, ${watcherId},
					'lobu',
					${template.notification_channel},
					${template.notification_priority},
					0
				)
			`;

			await tx`
				INSERT INTO watcher_versions (
					id, watcher_id, version, name, description, prompt,
					version_sources, change_notes, created_by, created_at
				) VALUES (
					${versionId}, ${watcherId}, 1,
					${template.name},
					${template.description},
					${template.prompt},
					'[]'::jsonb,
					${`Installed from catalog template ${FEED_AUTO_PAUSE_CATALOG_ID}`},
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
					catalog_id: FEED_AUTO_PAUSE_CATALOG_ID,
				},
				"[feed-auto-pause] installed catalog Behavior",
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

/** Backfill coverage for connections that already exist in one org. */
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
	const slug = feedAutoPauseCatalogTemplate().slug;

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
		        AND w.slug = ${slug}
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
		            AND w.slug = ${slug}
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
