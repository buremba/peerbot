/**
 * ClientSDK `notifications` namespace. Thin wrapper over the `notify` tool.
 *
 * Lets watcher reactions (and `run_sdk` scripts) deliver a notification:
 * `createNotificationForUsers` writes an `agent_message` notification event and
 * fans it out to the org's active bot connections (Slack/Telegram) via
 * `deliverToBotConnections`. This restores the `notify` capability the legacy
 * `ReactionSDK` had before reactions were consolidated onto the ClientSDK
 * (PR #348 carried `notify` over only as an agent-facing MCP tool, not onto the
 * reaction client) — so a reaction can now push its digest to Slack directly.
 */

import type { Env } from "../../index";
import { notify } from "../../tools/admin/notify";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface NotificationsSendInput {
  /** Notification title (≤200 chars). */
  title: string;
  /** Body text (≤1000 chars). */
  body?: string;
  /**
   * Who to notify. `"admins"` (default): org admins/owners. `"all"`: every
   * member. Or an array of specific user IDs.
   */
  recipients?: "admins" | "all" | string[];
  /** Relative URL the notification links to (e.g. `/acme/entities`). */
  resource_url?: string;
  /** Deliver only through this specific bot connection (its id). */
  connection_id?: string;
  /** Arbitrary JSON payload appended to the body as formatted JSON. */
  data?: Record<string, unknown>;
  /** Attribution when sent from a watcher reaction — both ids are numeric. */
  watcher_source?: { watcher_id: number; window_id: number };
}

export interface NotificationsNamespace {
  send(input: NotificationsSendInput): Promise<{ notified_count: number }>;
}

export function buildNotificationsNamespace(
  ctx: ToolContext,
  env: Env,
): NotificationsNamespace {
  const { action } = createActionCaller(notify, env, ctx);

  return {
    send: (input) => action("send", input),
  };
}
