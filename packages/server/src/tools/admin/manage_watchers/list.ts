/**
 * list_watchers handler for manage_watchers.
 */

import { getDb } from "../../../db/client";
import type { Env } from "../../../index";
import logger from "../../../utils/logger";
import {
	buildWatchersUrl,
	getOrganizationSlug,
	getPublicWebUrl,
} from "../../../utils/url-builder";
import { buildLatestWatcherRunJoinSql } from "../../../watchers/automation";
import type { ToolContext } from "../../registry";
import { toEntityInfo } from "../../view-urls";
import { batchCountUnanalyzedContent } from "./shared";

export type ListWatchersArgs = {
	watcher_id?: string;
	entity_id?: number;
	agent_id?: string;
	watcher_group_id?: number;
	status?: string;
	include_details?: boolean;
	order_by?: "last_fired_at" | "created_at";
	order_dir?: "asc" | "desc";
	limit?: number;
};

export type ListWatchersResult = { watchers: any[] };

// ============================================
// handleList
// ============================================

export async function handleList(
	args: ListWatchersArgs,
	_env: Env,
	ctx: ToolContext,
): Promise<ListWatchersResult> {
	const sql = getDb();

	if (args.entity_id) {
		const entityCheck =
			await sql`SELECT id FROM entities WHERE id = ${args.entity_id}`;
		if (entityCheck.length === 0) {
			throw new Error(`Entity with ID ${args.entity_id} not found`);
		}
	}

	let query = `
    SELECT
      i.id as watcher_id,
      i.name,
      i.slug,
      i.status,
      i.version,
      i.created_at,
      i.updated_at,
      i.schedule,
      i.next_run_at,
      i.agent_id,
      i.device_worker_id,
      i.last_fired_at,
      i.scheduler_client_id,
      i.model_config,
      i.execution_config,
      i.sources,
      -- With fetch_types:false (see db/client.ts) postgres.js does not parse
      -- arrays, so text[] arrives as the literal "{a,b}"; wrap in to_jsonb so
      -- clients get a real JSON array.
      to_jsonb(i.tags) AS tags,
      i.notification_channel,
      i.notification_priority,
      i.min_cooldown_seconds,
      i.agent_kind,
      i.watcher_group_id,
      i.source_watcher_id,
      wr.id as watcher_run_id,
      wr.status as watcher_run_status,
      wr.error_message as watcher_run_error,
      wr.created_at as watcher_run_created_at,
      wr.completed_at as watcher_run_completed_at,
      e.id as entity_id,
      et.slug AS entity_type,
      e.name as entity_name,
      e.slug as entity_slug,
      e.organization_id,
      parent.id as parent_id,
      parent.name as parent_name,
      parent.slug as parent_slug,
      pet.slug as parent_entity_type,
      i.current_version_id,
      (SELECT COUNT(*) FROM watcher_windows iw WHERE iw.watcher_id = i.id) as windows_count
  `;

	if (args.include_details) {
		query += `,
      cv.description,
      cv.prompt,
      cv.classifiers,
      cv.keying_config,
      cv.condensation_prompt,
      cv.condensation_window_count,
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

	if (args.watcher_id) {
		conditions.push(`i.id = $${paramCount}`);
		params.push(args.watcher_id);
		paramCount++;
	}

	if (args.agent_id) {
		conditions.push(`i.agent_id = $${paramCount}`);
		params.push(args.agent_id);
		paramCount++;
	}

	if (args.watcher_group_id != null) {
		conditions.push(`i.watcher_group_id = $${paramCount}`);
		params.push(args.watcher_group_id);
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
	const watcherIds = (result as any[]).map((i) => Number(i.watcher_id));

	let counts: Map<number, { pending: number; historical: number }>;
	try {
		counts = await batchCountUnanalyzedContent(watcherIds);
	} catch (error) {
		logger.error(
			{ error },
			"[manage_watchers] Error batch counting unanalyzed content",
		);
		counts = new Map();
	}

	const uniqueOrgIds = [
		...new Set(
			(result as any[]).map((r) => r.organization_id as string).filter(Boolean),
		),
	];
	const orgSlugMap = new Map<string, string>();
	for (const orgId of uniqueOrgIds) {
		const slug = await getOrganizationSlug(orgId);
		if (slug) orgSlugMap.set(orgId, slug);
	}

	const watchersWithPendingCount = (result as any[]).map((watcher) => {
		const watcherId = Number(watcher.watcher_id);
		const countData = counts.get(watcherId) || { pending: 0, historical: 0 };
		const orgSlug = orgSlugMap.get(watcher.organization_id as string) ?? null;

		const entityInfo = orgSlug
			? toEntityInfo(orgSlug, {
					entity_type: watcher.entity_type,
					slug: watcher.entity_slug,
					parent_entity_type: watcher.parent_entity_type ?? null,
					parent_slug: watcher.parent_slug ?? null,
				})
			: null;
		const viewUrl = entityInfo
			? buildWatchersUrl(entityInfo, baseUrl)
			: undefined;

		const { organization_id: _orgId, ...rest } = watcher;

		if (!args.include_details) {
			delete (rest as Record<string, unknown>).prompt;
			delete (rest as Record<string, unknown>).classifiers;
			delete (rest as Record<string, unknown>).description;
		}

		// Stringify `watcher_id` to match the rest of the manage_watchers
		// contract: `handleCreate` returns `String(watcherId)`, the input schema
		// declares `watcher_id` as a string, and downstream callers (CLI
		// `apply-cmd.ts` → `updateWatcher`, MCP tools) forward whatever they
		// receive straight back. Without the cast the raw integer leaks through
		// and a follow-up `update`/`upgrade` call fails the schema gate with
		// `/watcher_id: Expected string`. Same bug pattern for `current_version_id`
		// (kept as-is — no consumer feeds it back into manage_watchers today).
		if ((rest as Record<string, unknown>).watcher_id != null) {
			(rest as Record<string, unknown>).watcher_id = String(
				(rest as Record<string, unknown>).watcher_id,
			);
		}

		return {
			...rest,
			organization_slug: orgSlug,
			pending_content_count: countData.pending,
			historical_content_count: countData.historical,
			view_url: viewUrl,
		};
	});

	return { watchers: watchersWithPendingCount };
}
