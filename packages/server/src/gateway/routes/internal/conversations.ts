import { createHash } from "node:crypto";
import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import {
  resolveAddressableTargets,
  resolveAuthorizedTarget,
  resolveAuthorizedThread,
  threadHandleForMessage,
  type AddressableTarget,
} from "../../conversations/authorization.js";
import { getChatInstanceManager } from "../../../lobu/gateway.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

const logger = createLogger("conversations-routes");

// Defense-in-depth caps (pi review). A runaway watcher that posts every tick is
// stopped by policy, not luck. Rate budgets per-agent/day are a phase-2 add.
const MAX_SENDS_PER_RUN = 20;
const MAX_CONTENT_LENGTH = 4000;
// Slack broadcast tokens: refuse mass-mentions outright in v1.
const MASS_MENTION = /(^|\s)@(channel|here|everyone)\b/i;

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
      const before = c.req.query("before") || undefined;

      const manager = getChatInstanceManager();
      if (!manager?.getPlatformConversationHistory) {
        return c.json({ messages: [], nextCursor: null, hasMore: false });
      }
      // conversationId === channelId collapses history to channel-level.
      const history = await manager.getPlatformConversationHistory(
        target.platform,
        target.channelId,
        target.channelId,
        limit,
        before
      );
      return c.json(history);
    } catch (error) {
      logger.error(`read conversation failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
    }
  });

  // POST /conversations/send { target, text, reply_to?, idempotency_key? }
  router.post("/conversations/send", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (!worker.agentId || !worker.organizationId) {
        return errorResponse(c, "Token missing agent/org context", 403);
      }
      const body = (await c.req.json().catch(() => null)) as {
        target?: string;
        text?: string;
        idempotency_key?: string;
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

      const sql = getDb();
      const runConversationId = worker.conversationId || null;

      // Per-run send cap.
      if (runConversationId) {
        const countRows = (await sql`
          SELECT count(*)::int AS n
          FROM conversation_sends
          WHERE run_conversation_id = ${runConversationId}
        `) as Array<{ n: number }>;
        if ((countRows[0]?.n ?? 0) >= MAX_SENDS_PER_RUN) {
          return errorResponse(
            c,
            `Per-run send limit reached (${MAX_SENDS_PER_RUN})`,
            429
          );
        }
      }

      // Idempotency key: explicit client key, else derived from
      // (org, agent, run, target, thread, content). Whole-job retries replay the
      // same tool call → same key → no double post.
      const contentHash = createHash("sha256")
        .update(text)
        .digest("hex")
        .slice(0, 16);
      const idempotencyKey =
        body.idempotency_key?.trim() ||
        createHash("sha256")
          .update(
            [
              worker.organizationId,
              worker.agentId,
              runConversationId ?? "",
              target.handle,
              threadId ?? "",
              contentHash,
            ].join("|")
          )
          .digest("hex");

      // Claim the send first so a crash mid-post doesn't permanently dedup: on
      // post failure we release the claim and a retry re-posts.
      const claimed = (await sql`
        INSERT INTO conversation_sends (
          idempotency_key, organization_id, agent_id, run_conversation_id,
          connection_id, platform, target_handle, channel_id, thread_id
        ) VALUES (
          ${idempotencyKey}, ${worker.organizationId}, ${worker.agentId},
          ${runConversationId}, ${target.connectionId}, ${target.platform},
          ${target.handle}, ${target.channelId}, ${threadId ?? null}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `) as Array<{ idempotency_key: string }>;

      if (claimed.length === 0) {
        // Duplicate — return the prior result without re-posting.
        const prior = (await sql`
          SELECT message_id, thread_id FROM conversation_sends
          WHERE idempotency_key = ${idempotencyKey}
        `) as Array<{ message_id: string | null; thread_id: string | null }>;
        const priorMsg = prior[0]?.message_id ?? null;
        return c.json({
          deduped: true,
          messageId: priorMsg,
          thread: priorMsg
            ? threadHandleForMessage(target, priorMsg)
            : undefined,
        });
      }

      let sent: { messageId: string; threadId: string };
      try {
        const manager = getChatInstanceManager();
        if (!manager?.postToConversation) {
          throw new Error("Chat instance manager unavailable");
        }
        sent = await manager.postToConversation(target.connectionId, {
          platform: target.platform,
          channelKey: target.channelKey,
          channelId: target.channelId,
          threadId,
          content: { markdown: text },
        });
      } catch (postErr) {
        // Release the claim so a job retry can re-post.
        await sql`DELETE FROM conversation_sends WHERE idempotency_key = ${idempotencyKey}`;
        throw postErr;
      }

      await sql`
        UPDATE conversation_sends
        SET message_id = ${sent.messageId || null}
        WHERE idempotency_key = ${idempotencyKey}
      `;

      logger.info(
        `agent ${worker.agentId} sent to ${target.platform}/${target.channelId}${threadId ? " (thread)" : ""} via ${target.connectionId}`
      );

      // A thread handle lets a later run reply into this message's thread.
      const threadHandle = sent.messageId
        ? threadHandleForMessage(target, sent.messageId)
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
