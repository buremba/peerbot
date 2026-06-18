import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import {
  resolveAddressableTargets,
  resolveAuthorizedTarget,
  resolveAuthorizedThread,
  threadHandleForMessage,
  type AddressableTarget,
} from "../../conversations/authorization.js";
import { getChatInstanceManager } from "../../../lobu/gateway.js";
import {
  captureChannelMessage,
  readChannelTranscript,
} from "../../connections/channel-transcript.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

const logger = createLogger("conversations-routes");

const MAX_CONTENT_LENGTH = 4000;
// Refuse mass-mentions: both the human-written `@channel` form (anywhere, not
// just after whitespace) and Slack's actual broadcast tokens `<!channel>` /
// `<!here>` / `<!everyone>` / `<!subteam^…>`.
const MASS_MENTION =
  /@(channel|here|everyone)\b|<!(channel|here|everyone|subteam)\b/i;

/** Public (model-facing) shape of an addressable conversation. */
function toPublicTarget(t: AddressableTarget): {
  handle: string;
  kind: string;
  platform: string;
  label: string;
} {
  return {
    handle: t.handle,
    kind: t.kind,
    platform: t.platform,
    label: t.label ?? t.channelId,
  };
}

/**
 * Internal routes backing the native conversation tools (list/read/send).
 *
 * SECURITY: the acting agent + org come ONLY from the verified worker token.
 * The model never supplies a raw channel/user id — it passes opaque `handle`s
 * from `list`, which the authorization layer re-resolves against the agent's
 * CURRENT bindings on every call (revocation-safe; no cross-tenant reach).
 */
export function createConversationsRoutes(): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  // GET /conversations/list — the conversations this agent may read+post to.
  router.get("/conversations/list", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (!worker.agentId || !worker.organizationId) {
        return errorResponse(c, "Token missing agent/org context", 403);
      }
      const targets = await resolveAddressableTargets(
        worker.agentId,
        worker.organizationId
      );
      return c.json({ conversations: targets.map(toPublicTarget) });
    } catch (error) {
      logger.error(`list conversations failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
    }
  });

  // GET /conversations/read?target=<handle>&limit=&before=
  router.get("/conversations/read", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (!worker.agentId || !worker.organizationId) {
        return errorResponse(c, "Token missing agent/org context", 403);
      }
      const handle = c.req.query("target");
      if (!handle) return errorResponse(c, "Missing target", 400);

      const target = await resolveAuthorizedTarget(
        worker.agentId,
        worker.organizationId,
        handle
      );
      if (!target) {
        // Forged handle or revoked binding — indistinguishable on purpose.
        return errorResponse(c, "Not authorized for this conversation", 403);
      }

      const limit = Math.min(
        Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1),
        100
      );

      // Primary: serve the durable transcript from Postgres, scoped to the
      // AUTHORIZED connection (the tenant fence) — no platform history-API call,
      // so Slack's throttle doesn't apply.
      const messages = await readChannelTranscript(
        worker.organizationId,
        target.connectionId,
        target.channelId,
        limit
      );
      if (messages.length > 0) {
        return c.json({ messages, nextCursor: null, hasMore: false });
      }

      // Cold start (nothing captured yet for this channel): best-effort one-shot
      // live fetch to seed the read, subject to the platform's history limit.
      const manager = getChatInstanceManager();
      if (manager?.getLiveConversationHistory) {
        const live = await manager.getLiveConversationHistory(
          target.connectionId,
          target.channelKey,
          limit
        );
        return c.json({ ...live, nextCursor: null, hasMore: false });
      }
      return c.json({ messages: [], nextCursor: null, hasMore: false });
    } catch (error) {
      logger.error(`read conversation failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
    }
  });

  // POST /conversations/send { target, text }
  router.post("/conversations/send", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (!worker.agentId || !worker.organizationId) {
        return errorResponse(c, "Token missing agent/org context", 403);
      }
      const body = (await c.req.json().catch(() => null)) as {
        target?: string;
        text?: string;
      } | null;
      const text = body?.text?.trim();
      if (!body?.target || !text) {
        return errorResponse(c, "target and text are required", 400);
      }
      if (text.length > MAX_CONTENT_LENGTH) {
        return errorResponse(
          c,
          `Message too long (max ${MAX_CONTENT_LENGTH} chars)`,
          400
        );
      }
      if (MASS_MENTION.test(text)) {
        return errorResponse(
          c,
          "Mass mentions (@channel/@here/@everyone) are not allowed",
          400
        );
      }

      // `target` is either a channel handle (top-level post) or a thread handle
      // from a prior send (reply in that thread). A thread handle re-authorizes
      // its own channel binding, so try it first; fall back to channel.
      let target: AddressableTarget;
      let threadId: string | undefined;
      const asThread = await resolveAuthorizedThread(
        worker.agentId,
        worker.organizationId,
        body.target
      );
      if (asThread) {
        target = asThread.target;
        threadId = asThread.threadId;
      } else {
        const resolved = await resolveAuthorizedTarget(
          worker.agentId,
          worker.organizationId,
          body.target
        );
        if (!resolved) {
          return errorResponse(c, "Not authorized for this conversation", 403);
        }
        target = resolved;
      }

      const manager = getChatInstanceManager();
      if (!manager?.postToConversation) {
        return errorResponse(c, "Chat instance manager unavailable", 503);
      }
      const sent = (await manager.postToConversation(target.connectionId, {
        platform: target.platform,
        channelKey: target.channelKey,
        channelId: target.channelId,
        threadId,
        content: { markdown: text },
        // Follow the thread we just posted into so replies (e.g. lunch orders)
        // come back to us and land in the transcript.
        subscribe: true,
      })) as { messageId: string; threadId: string };

      logger.info(
        `agent ${worker.agentId} sent to ${target.platform}/${target.channelId}${threadId ? " (thread)" : ""} via ${target.connectionId}`
      );

      // Persist the bot's own post into the transcript (with the real platform
      // message id) so read_conversation includes it AND the inbound echo of
      // this message dedups against it.
      if (sent.messageId) {
        captureChannelMessage({
          organizationId: worker.organizationId,
          connectionId: target.connectionId,
          platform: target.platform,
          channelId: target.channelId,
          threadId: threadId ?? null,
          platformMessageId: sent.messageId,
          authorId: worker.agentId,
          authorName: worker.agentId,
          isBot: true,
          text,
          occurredAt: new Date(),
        });
      }

      // A thread handle lets a later run reply into this message's thread.
      // Prefer the adapter's returned thread id (root) when it carries one
      // (reply-in-existing-thread); fall back to the new message id (the root
      // of a freshly-opened thread). Telegram's message id is `${chatId}:${n}`,
      // so strip the redundant channel prefix — else the thread handle encodes a
      // 4-segment `platform:channel:chatId:n` that its own 3-part decode rejects
      // (and createThread can't resolve). No-op for ids that aren't prefixed
      // (e.g. a Slack `ts`).
      const rawRoot =
        typeof sent.threadId === "string" && sent.threadId.split(":")[2]
          ? sent.threadId.split(":")[2]
          : sent.messageId;
      const threadRoot = rawRoot.startsWith(`${target.channelId}:`)
        ? rawRoot.slice(target.channelId.length + 1)
        : rawRoot;
      const threadHandle = threadRoot
        ? threadHandleForMessage(target, threadRoot)
        : undefined;
      return c.json({
        messageId: sent.messageId || null,
        thread: threadHandle,
      });
    } catch (error) {
      logger.error(`send conversation failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
    }
  });

  return router;
}
