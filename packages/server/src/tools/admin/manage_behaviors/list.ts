/**
 * list action handler for manage_behaviors.
 */

import {
	ListBehaviorsResultSchema,
	type ListBehaviorsArgs,
	type ListBehaviorsResult,
} from "@lobu/core/contracts/tools/manage-behaviors";
import { getDb } from "../../../db/client";
import type { Env } from "../../../index";
import { canonicalizeBehaviorText } from "../../../utils/behavior-vocabulary";
import { ToolUserError } from "../../../utils/errors";
import logger from "../../../utils/logger";
import {
	buildBehaviorUrl,
	getOrganizationSlug,
	getPublicWebUrl,
} from "../../../utils/url-builder";
import { buildLatestWatcherRunJoinSql } from "../../../watchers/automation";
import { computeBehaviorHealth } from "../../../watchers/behavior-health";
import type { ToolContext } from "../../registry";
import { batchCountUnanalyzedContent } from "./shared";

export { ListBehaviorsResultSchema };

// ============================================
// handleList
// ============================================

export async function handleList(
	args: ListBehaviorsArgs,
	_env: Env,
	ctx: ToolContext
): Promise<ListBehaviorsResult> {
	const sql = getDb();

	if (args.entity_id) {
		const entityCheck = await sql`
			SELECT id
			FROM entities
			WHERE id = ${args.entity_id}
			  AND organization_id = ${ctx.organizationId}
		`;
		if (entityCheck.length === 0) {
			throw new ToolUserError(`Entity with ID ${args.entity_id} not found`, 404);
		}
	}

	let query = `
    SELECT
      i.id as behavior_id,
      i.name,
      i.slug,
      i.status,
      i.version,
      i.created_at,
      i.updated_at,
      i.triggers,
      i.next_run_at,
      i.agent_id,
      i.device_worker_id,
      i.last_fired_at,
      -- Materialized completion stamp of the most recent completed run,
      -- written by a trigger on runs. last_fired_at is NOT a substitute: only
      -- the worker-api terminal-report path stamps it, so runs that finish
      -- through any other terminal writer leave it NULL or stale and the
      -- listing renders "Never run" for a Behavior that ran minutes ago.
      i.last_run_completed_at,
      i.model_config,
      i.execution_config,
      i.sources,
      -- With fetch_types:false (see db/client.ts) postgres.js does not parse
      -- arrays, so text[] arrives as the literal "{a,b}"; wrap in to_jsonb so
      -- clients get a real JSON array.
      to_jsonb(i.tags) AS tags,
      i.notification_channel,
      i.notification_priority,
      i.delivery_target,
      i.min_cooldown_seconds,
      i.agent_kind,
      i.watcher_group_id::text AS behavior_group_id,
      i.source_watcher_id::text AS source_behavior_id,
      wr.id as behavior_run_id,
      wr.status as behavior_run_status,
      wr.outcome as behavior_run_outcome,
      wr.error_message as behavior_run_error,
      wr.created_at as behavior_run_created_at,
      wr.completed_at as behavior_run_completed_at,
      e.id as entity_id,
      et.slug AS entity_type,
      e.name as entity_name,
      e.slug as entity_slug,
      -- The Behavior's OWN org, not the entity's. The entities join is a LEFT
      -- JOIN, so an org-scoped Behavior (empty entity_ids — the common shape)
      -- yielded NULL here, which stranded the slug lookup below and dropped
      -- both organization_slug and view_url from every such row.
      -- watchers.organization_id is NOT NULL, so this always resolves.
      i.organization_id,
      parent.id as parent_id,
      parent.name as parent_name,
      parent.slug as parent_slug,
      pet.slug as parent_entity_type,
      i.current_version_id,
      (SELECT COUNT(*) FROM canvas_windows iw WHERE iw.watcher_id = i.id) as windows_count,
      (SELECT COUNT(DISTINCT iw.client_id) FROM canvas_windows iw WHERE iw.watcher_id = i.id AND iw.client_id IS NOT NULL) as processing_client_count
  `;

	if (args.include_details) {
		query += `,
      cv.description,
      cv.prompt,
      cv.skills,
      cv.classifiers,
      cv.outputs,
      cv.reactions_guidance
    `;
	}

	query += `
    FROM watchers i
    LEFT JOIN entities e ON e.id = ANY(i.entity_ids)
    LEFT JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities parent ON e.parent_id = parent.id
    LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
    LEFT JOIN watcher_versions cv ON i.current_version_id = cv.id
    ${buildLatestWatcherRunJoinSql("i", "wr")}
  `;

	const conditions: string[] = [];
	const params: any[] = [];
	let paramCount = 1;

	conditions.push(`i.organization_id = $${paramCount}::text`);
	params.push(ctx.organizationId);
	paramCount++;

	if (args.entity_id) {
		conditions.push(`$${paramCount} = ANY(i.entity_ids)`);
		params.push(args.entity_id);
		paramCount++;
	}

	if (args.behavior_id) {
		conditions.push(`i.id = $${paramCount}`);
		params.push(args.behavior_id);
		paramCount++;
	}

	if (args.agent_id) {
		conditions.push(`i.agent_id = $${paramCount}`);
		params.push(args.agent_id);
		paramCount++;
	}

	if (args.status) {
		conditions.push(`i.status = $${paramCount}`);
		params.push(args.status);
		paramCount++;
	} else {
		// Default to active watchers only (exclude archived)
		conditions.push(`i.status = 'active'`);
	}

	// Discovery filter for executors: match the LATEST run per Behavior (the
	// lateral join prioritizes active runs), e.g. pending manual-open runs.
	if (args.run_status) {
		conditions.push(`wr.status = $${paramCount}`);
		params.push(args.run_status);
		paramCount++;
	}

	query += ` WHERE ${conditions.join(" AND ")}`;

	const orderDir = args.order_dir === "asc" ? "ASC" : "DESC";
	if (args.order_by === "last_fired_at") {
		query += ` ORDER BY i.last_fired_at ${orderDir} NULLS LAST, i.updated_at ${orderDir}`;
	} else {
		query += ` ORDER BY i.created_at ${orderDir}`;
	}

	if (args.limit != null && args.limit > 0) {
		query += ` LIMIT $${paramCount}`;
		params.push(args.limit);
		paramCount++;
	}

	const result = await sql.unsafe(query, params);

	const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
	const watcherIds = (result as any[]).map((i) => Number(i.behavior_id));

	let counts: Map<number, { pending: number; historical: number }>;
	try {
		counts = await batchCountUnanalyzedContent(watcherIds);
	} catch (error) {
		logger.error(
			{ error },
			"[manage_behaviors] Error batch counting unanalyzed content"
		);
		counts = new Map();
	}

	const uniqueOrgIds = [
		...new Set(
			(result as any[]).map((r) => r.organization_id as string).filter(Boolean)
		),
	];
	const orgSlugMap = new Map<string, string>();
	for (const orgId of uniqueOrgIds) {
		const slug = await getOrganizationSlug(orgId);
		if (slug) orgSlugMap.set(orgId, slug);
	}

	const watchersWithPendingCount = (result as any[]).map((watcher) => {
		const watcherId = Number(watcher.behavior_id);
		const countData = counts.get(watcherId) || { pending: 0, historical: 0 };
		const orgSlug = orgSlugMap.get(watcher.organization_id as string) ?? null;

		// Workspace-level route: agentless (device-pinned / manual-only)
		// Behaviors carry a view_url just like agent-owned ones.
		const viewUrl = orgSlug
			? buildBehaviorUrl(orgSlug, watcherId, baseUrl)
			: undefined;

		const { organization_id: _orgId, ...rest } = watcher;

		// Old persisted run-error rows can carry the internal `client.watchers.*`
		// namespace (the SDK alias was renamed watchers→behaviors; forward-path
		// templates already emit `client.behaviors.*`, but archived error_message
		// rows still hold the legacy string). Rewrite it at read time so the
		// public projection never surfaces the internal vocabulary.
		if (typeof (rest as Record<string, unknown>).behavior_run_error === "string") {
			(rest as Record<string, unknown>).behavior_run_error = canonicalizeBehaviorText(
				(rest as Record<string, unknown>).behavior_run_error as string,
			);
		}

		if (!args.include_details) {
			delete (rest as Record<string, unknown>).prompt;
			delete (rest as Record<string, unknown>).skills;
			delete (rest as Record<string, unknown>).classifiers;
			delete (rest as Record<string, unknown>).description;
		}

		// Stringify `behavior_id` to match the rest of the manage_behaviors
		// contract: `handleCreate` returns `String(watcherId)`, the input schema
		// declares `behavior_id` as a string, and downstream callers (CLI
		// `apply-cmd.ts` → `updateWatcher`, MCP tools) forward whatever they
		// receive straight back. Without the cast the raw integer leaks through
		// and a follow-up `update`/`upgrade` call fails the schema gate with
		// `/behavior_id: Expected string`. Same bug pattern for `current_version_id`
		// (kept as-is — no consumer feeds it back into manage_behaviors today).
		if ((rest as Record<string, unknown>).behavior_id != null) {
			(rest as Record<string, unknown>).behavior_id = String(
				(rest as Record<string, unknown>).behavior_id
			);
		}

		// Computed health (item 3, #2033) — derived from the
		// already-selected schedule/run columns, no extra query.
		const behaviorHealth = computeBehaviorHealth({
			status: watcher.status,
			nextRunAt: watcher.next_run_at,
			latestRunStatus: watcher.behavior_run_status,
			latestRunCreatedAt: watcher.behavior_run_created_at,
			// Use the vocab-rewritten error so last_scheduling_error also carries the
			// public `client.behaviors.*` namespace, not the legacy internal one.
			latestRunError: (rest as Record<string, unknown>).behavior_run_error as
				| string
				| null
				| undefined,
			latestRunOutcome: watcher.behavior_run_outcome,
		});

		return {
			...rest,
			organization_slug: orgSlug,
			pending_content_count: countData.pending,
			historical_content_count: countData.historical,
			view_url: viewUrl,
			health: behaviorHealth.health,
			...(behaviorHealth.reasons.length > 0 && {
				health_reasons: behaviorHealth.reasons,
			}),
			last_scheduling_error: behaviorHealth.last_scheduling_error,
			last_run_outcome: behaviorHealth.last_run_outcome,
		};
	});

	return { action: "list", behaviors: watchersWithPendingCount };
}
