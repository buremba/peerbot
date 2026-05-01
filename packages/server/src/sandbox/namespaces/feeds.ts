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
}

export interface FeedsNamespace {
  manage(input: Record<string, unknown>): Promise<unknown>;
  list(input?: { connection_id?: number }): Promise<unknown>;
  get(feed_id: number): Promise<unknown>;
  create(input: FeedsCreateInput): Promise<unknown>;
  update(input: {
    feed_id: number;
    display_name?: string;
    status?: string;
    entity_ids?: number[];
    config?: Record<string, unknown>;
    schedule?: string;
  }): Promise<unknown>;
  delete(feed_id: number): Promise<unknown>;
  trigger(feed_id: number): Promise<unknown>;
}

export function buildFeedsNamespace(
  ctx: ToolContext,
  env: Env,
): FeedsNamespace {
  const { manage, action } = createActionCaller(manageFeeds, env, ctx);

  return {
    manage,
    list: (input) => action("list_feeds", input),
    get: (feed_id) => action("get_feed", { feed_id }),
    create: (input) => action("create_feed", input),
    update: (input) => action("update_feed", input),
    delete: (feed_id) => action("delete_feed", { feed_id }),
    trigger: (feed_id) => action("trigger_feed", { feed_id }),
  };
}
