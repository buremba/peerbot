/**
 * ClientSDK `feeds` namespace. Thin wrapper over `manageFeeds`.
 *
 * `create_feed` requires `feed_key` — the connector-declared identifier for the
 * data surface this feed will sync.
 */

import type { Env } from "../../index";
import { manageFeeds } from "../../tools/admin/manage_feeds";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface FeedsCreateInput {
	connection_id: number;
	feed_key: string;
	display_name?: string;
	entity_ids?: number[];
	config?: Record<string, unknown>;
	schedule?: string;
	/** IANA zone the schedule is evaluated in; omit for server time (UTC). */
	timezone?: string;
}

export interface FeedsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: { connection_id?: number; feed_ids?: number[] }): Promise<unknown>;
	get(input: { feed_id: number; search_term?: string }): Promise<unknown>;
	readMany(input: {
		feed_ids: number[];
		limit?: number;
		timeout_ms?: number;
		/** For VIRTUAL feeds: term pushed to each connector's search() pushdown. */
		search_term?: string;
	}): Promise<unknown>;
	create(input: FeedsCreateInput): Promise<unknown>;
	update(input: {
		feed_id: number;
		display_name?: string;
		status?: string;
		entity_ids?: number[];
		config?: Record<string, unknown>;
		schedule?: string;
		/** IANA zone for the schedule; null clears it (server time). */
		timezone?: string | null;
	}): Promise<unknown>;
	delete(input: { feed_id: number }): Promise<unknown>;
	trigger(input: {
		feed_id: number;
		/**
		 * Run the connector for real but persist nothing — no events, entities or
		 * attachments, and the feed's checkpoint and sync state stay put. Once the
		 * run completes, a capped preview of what would have been ingested is on
		 * its `dry_run_preview`, readable via `feeds.get`.
		 */
		dry_run?: boolean;
	}): Promise<unknown>;
}

export function buildFeedsNamespace(
	ctx: ToolContext,
	env: Env,
): FeedsNamespace {
	const { manage, action } = createActionCaller(manageFeeds, env, ctx, "feeds");

	return {
		manage,
		list: (input) => action("list_feeds", input, "list"),
		get: (input) => action("read_feed", input, "get"),
		readMany: (input) => action("read_feeds", input, "readMany"),
		create: (input) => action("create_feed", input, "create"),
		update: (input) => action("update_feed", input, "update"),
		delete: (input) => action("delete_feed", input, "delete"),
		trigger: (input) => action("trigger_feed", input, "trigger"),
	};
}
