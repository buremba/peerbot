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

      const manager = getChatInstanceManager();
      if (!manager?.getLiveConversationHistory) {
        return c.json({ messages: [], nextCursor: null, hasMore: false });
      }
      // SECURITY: read through the AUTHORIZED connection only (target.connectionId),
      // never a global by-platform re-selection — otherwise an agent could read
      // another tenant's cached transcript for a colliding channel id. This also
      // pulls real platform history (not the 10-message cache).
      const history = await manager.getLiveConversationHistory(
        target.connectionId,
        target.channelKey,
        limit
      );
      return c.json({ ...history, nextCursor: null, hasMore: false });
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
      // Fail closed: the per-run send cap is the runaway-watcher backstop, so a
      // token without a conversation id (which would skip the cap) is rejected
      // rather than allowed through uncapped.
      const runConversationId = worker.conversationId;
      if (!runConversationId) {
        return errorResponse(c, "Token missing conversation context", 403);
      }

      // Per-run send cap.
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

      // Idempotency key: explicit client key, else derived from
      // (org, agent, run, target, thread, content). Whole-job retries replay the
      // same tool call → same key → no double post.
      // Always namespace by (org, agent) — including a client-supplied key —
      // since the ledger PK is global; otherwise agent B could pass agent A's
      // key and get back A's message handle.
      const clientKey = body.idempotency_key?.trim();
      const keyMaterial = clientKey
        ? [worker.organizationId, worker.agentId, "client", clientKey]
        : [
            worker.organizationId,
            worker.agentId,
            runConversationId,
            target.handle,
            threadId ?? "",
            createHash("sha256").update(text).digest("hex").slice(0, 16),
          ];
      const idempotencyKey = createHash("sha256")
        .update(keyMaterial.join("|"))
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
      // Prefer the adapter's returned thread id (root) when it carries one
      // (reply-in-existing-thread); fall back to the new message id (the root
      // of a freshly-opened thread).
      const threadRoot =
        typeof sent.threadId === "string" && sent.threadId.split(":")[2]
          ? sent.threadId.split(":")[2]
          : sent.messageId;
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
