/**
 * ClientSDK `feeds` namespace. Thin wrapper over `manageFeeds`.
 *
 * `create_feed` requires `feed_key` — the connector-declared identifier for the
 * data surface this feed will sync.
 */

import type { ActionInput } from "@lobu/core/contracts/tools/action-input";
import type { ManageFeedsArgs } from "@lobu/core/contracts/tools/manage-feeds";
import type { Env } from "../../index";
import { manageFeeds } from "../../tools/admin/manage_feeds";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export type FeedsListInput = ActionInput<ManageFeedsArgs, "list_feeds">;
export type FeedsGetInput = ActionInput<ManageFeedsArgs, "read_feed">;
export type FeedsReadManyInput = ActionInput<ManageFeedsArgs, "read_feeds">;
export type FeedsCreateInput = ActionInput<ManageFeedsArgs, "create_feed">;
export type FeedsUpdateInput = ActionInput<ManageFeedsArgs, "update_feed">;
export type FeedsDeleteInput = ActionInput<ManageFeedsArgs, "delete_feed">;
export type FeedsTriggerInput = ActionInput<ManageFeedsArgs, "trigger_feed">;

export interface FeedsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	list(input?: FeedsListInput): Promise<unknown>;
	get(input: FeedsGetInput): Promise<unknown>;
	readMany(input: FeedsReadManyInput): Promise<unknown>;
	create(input: FeedsCreateInput): Promise<unknown>;
	update(input: FeedsUpdateInput): Promise<unknown>;
	delete(input: FeedsDeleteInput): Promise<unknown>;
	trigger(input: FeedsTriggerInput): Promise<unknown>;
}

export function buildFeedsNamespace(
	ctx: ToolContext,
	env: Env,
): FeedsNamespace {
	const { manage, method } = createActionCaller(manageFeeds, env, ctx, "feeds");

	return {
		manage,
		list: method("list_feeds", { publicMethod: "list" }),
		get: method("read_feed", { publicMethod: "get" }),
		readMany: method("read_feeds", { publicMethod: "readMany" }),
		create: method("create_feed", { publicMethod: "create" }),
		update: method("update_feed", { publicMethod: "update" }),
		delete: method("delete_feed", { publicMethod: "delete" }),
		trigger: method("trigger_feed", { publicMethod: "trigger" }),
	};
}
