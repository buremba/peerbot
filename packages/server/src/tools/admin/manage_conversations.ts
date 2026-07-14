/**
 * Tool: manage_conversations
 *
 * Read an agent's conversations and drive a turn against one.
 *
 * Actions:
 * - list: List an agent's conversations, newest-first (the materialized
 *   `conversations` entity — the same source the sidebar reads).
 * - get:  Fetch one conversation by (platform, conversation_id).
 * - send: Enqueue a message to an agent conversation and, by default, block
 *   until the turn completes and return its reply. `wait:false` returns
 *   immediately with the message id (fire-and-forget).
 *
 * `send` targets the app-owned `web` realm: it builds the API conversation id
 * (`{agent}_{user}_{org}[_{thread}]`) and enqueues a `platform: "api"` payload,
 * exactly like the web panel's `POST /messages` and the scheduled-job wake. The
 * per-conversation sandbox pin (message-consumer → resolvePinnedSelection) then
 * freezes/reuses this conversation's runtime realm — the SDK caller never picks
 * a sandbox; the pin does. The reply is read from the durable `runs`
 * thread-response rows (cross-replica-safe), never a pod-local SSE buffer.
 */

import { randomUUID } from "node:crypto";
import {
  type ManageConversationsArgs,
  ManageConversationsSchema,
} from "@lobu/core/contracts/tools/manage-conversations";
import { createDbClientFromEnv } from "../../db/client";
import { buildApiConversationId } from "../../gateway/services/api-conversation-id";
import {
  type ConversationListRow,
  getConversation,
  listConversations,
  readConversationReply,
} from "../../gateway/services/conversations-store";
import {
  buildMessagePayload,
  resolveAgentOptions,
} from "../../gateway/services/platform-helpers";
import type { Env } from "../../index";
import { getLobuCoreServices } from "../../lobu/gateway";
import { ToolUserError } from "../../utils/errors";
import {
  requireOrgReadAccess,
  requireOrgWriteAccess,
} from "../../utils/organization-access";
import type { ToolContext } from "../registry";
import { withValidatedArgs } from "../validate-args";
import { defineFlatActionTool, flatAction } from "./action-tool";

export { ManageConversationsSchema };

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 170_000;
const POLL_INTERVAL_MS = 1_000;

function serializeRow(r: ConversationListRow) {
  return {
    platform: r.platform,
    conversation_id: r.conversationId,
    kind: r.kind,
    user_id: r.userId,
    title: r.title,
    last_activity_at: r.lastActivityAt.toISOString(),
    created_at: r.createdAt.toISOString(),
  };
}

/** Assert the agent exists in this org before listing/sending against it. */
async function assertAgentInOrg(
  agentId: string,
  ctx: ToolContext,
  env: Env,
): Promise<void> {
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT 1 FROM agents
    WHERE organization_id = ${ctx.organizationId} AND id = ${agentId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Agent "${agentId}" not found`, 404);
  }
}

async function handleList(
  args: ManageConversationsArgs,
  ctx: ToolContext,
  env: Env,
) {
  await assertAgentInOrg(args.agent_id, ctx, env);
  // A member scoped to their own user reads only their owned threads; an
  // admin/owner (or a cross-user caller) sees every conversation. Mirror the
  // sidebar's scope split.
  const scope = ctx.userId ? "user" : "all";
  const conversations = await listConversations({
    organizationId: ctx.organizationId,
    agentId: args.agent_id,
    scope,
    userId: ctx.userId ?? "",
  });
  return {
    action: "list" as const,
    conversations: conversations.map(serializeRow),
  };
}

async function handleGet(
  args: ManageConversationsArgs,
  ctx: ToolContext,
  env: Env,
) {
  if (!args.conversation_id) {
    throw new ToolUserError("conversation_id is required for get action");
  }
  await assertAgentInOrg(args.agent_id, ctx, env);
  const platform = (args.platform ?? "web").toLowerCase();
  const row = await getConversation({
    organizationId: ctx.organizationId,
    agentId: args.agent_id,
    platform,
    conversationId: args.conversation_id,
  });
  if (!row) {
    throw new ToolUserError(
      `Conversation "${args.conversation_id}" not found for agent "${args.agent_id}"`,
      404,
    );
  }
  return { action: "get" as const, conversation: serializeRow(row) };
}

/** Abort-aware sleep so a wait-loop unblocks the instant the script times out. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function handleSend(
  args: ManageConversationsArgs,
  ctx: ToolContext,
  env: Env,
) {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text.trim()) {
    throw new ToolUserError("text is required for send action");
  }
  if (!ctx.userId) {
    throw new ToolUserError(
      "send requires an authenticated caller (the conversation is bound to the caller's user id)",
    );
  }
  await assertAgentInOrg(args.agent_id, ctx, env);

  const coreServices = getLobuCoreServices();
  const queueProducer = coreServices?.getQueueProducer?.();
  if (!queueProducer) {
    throw new ToolUserError(
      "Message dispatch is unavailable in this runtime (no queue producer).",
      503,
    );
  }
  const agentSettingsStore = coreServices?.getAgentSettingsStore?.();

  const userId = ctx.userId;
  // A named thread targets/opens a distinct web conversation (own history + own
  // pinned sandbox); omitting `thread` uses the caller's default thread. Prefer
  // an explicit conversation_id (resume an exact conversation) over `thread`.
  const conversationId =
    args.conversation_id ??
    buildApiConversationId({
      agentId: args.agent_id,
      userId,
      organizationId: ctx.organizationId,
      threadId: args.thread || undefined,
    });
  const channelId = `api_${userId}`;
  const messageId = randomUUID();

  const behaviorModel =
    typeof args.model === "string" && args.model.trim()
      ? args.model.trim()
      : undefined;
  const agentOptions = await resolveAgentOptions(
    args.agent_id,
    {
      provider: "claude",
      model: behaviorModel,
      ...(behaviorModel ? { behaviorModelOverride: true } : {}),
    },
    agentSettingsStore,
    ctx.organizationId,
  );

  await queueProducer.enqueueMessage(
    buildMessagePayload({
      platform: "api",
      userId,
      botId: "lobu-api",
      conversationId,
      teamId: "api",
      agentId: args.agent_id,
      organizationId: ctx.organizationId,
      messageId,
      messageText: text,
      channelId,
      platformMetadata: {
        agentId: args.agent_id,
        organizationId: ctx.organizationId,
        source: "sdk-conversations-send",
      },
      agentOptions,
    }),
  );

  const wait = args.wait !== false;
  if (!wait) {
    return {
      action: "send" as const,
      conversation_id: conversationId,
      message_id: messageId,
      status: "queued" as const,
    };
  }

  const timeoutMs = Math.min(
    args.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
    MAX_WAIT_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeoutMs;
  // Poll the durable runs rows for the terminal outcome. Deliberately NOT SSE:
  // the completion row is visible from any replica, so a wait-loop works even
  // when a different pod drained the deltas. Aborts at the script budget.
  while (Date.now() < deadline && !ctx.abortSignal?.aborted) {
    const reply = await readConversationReply({
      organizationId: ctx.organizationId,
      conversationId,
      messageId,
    });
    if (reply?.status === "complete") {
      return {
        action: "send" as const,
        conversation_id: conversationId,
        message_id: messageId,
        status: "complete" as const,
        reply: reply.text,
      };
    }
    if (reply?.status === "error") {
      return {
        action: "send" as const,
        conversation_id: conversationId,
        message_id: messageId,
        status: "error" as const,
        error: reply.error,
      };
    }
    await sleep(POLL_INTERVAL_MS, ctx.abortSignal);
  }

  // Timed out (or the script's budget ran out). The turn keeps running; the
  // caller can read the reply later via `get` / the transcript.
  return {
    action: "send" as const,
    conversation_id: conversationId,
    message_id: messageId,
    status: "timeout" as const,
  };
}

export const manageConversations = withValidatedArgs(
  "manage_conversations",
  ManageConversationsSchema,
  manageConversationsImpl,
);

async function manageConversationsImpl(
  args: ManageConversationsArgs,
  env: Env,
  ctx: ToolContext,
) {
  const pgSql = createDbClientFromEnv(env);
  if (args.action === "send") {
    await requireOrgWriteAccess(pgSql, ctx);
  } else {
    await requireOrgReadAccess(pgSql, ctx);
  }
  return runManageConversations(args, env, ctx);
}

const runManageConversations = defineFlatActionTool<
  ManageConversationsArgs,
  Awaited<ReturnType<typeof handleList | typeof handleGet | typeof handleSend>>
>("manage_conversations", {
  list: flatAction((args, ctx, env) => handleList(args, ctx, env)),
  get: flatAction((args, ctx, env) => handleGet(args, ctx, env)),
  send: flatAction((args, ctx, env) => handleSend(args, ctx, env)),
});
