/**
 * Chat response bridge — handles outbound responses from workers back through Chat SDK.
 *
 * Streaming is delegated to Chat SDK: deltas are pushed into an AsyncIterable which
 * is handed to `target.post()`. The adapter owns throttling, chunking, and
 * platform-specific rendering (Telegram buffers, Slack streams, etc.), so this
 * bridge is platform-agnostic.
 *
 * Platform quirks (e.g. Slack posting a single chunked `markdown_text` at
 * completion) live in `./platform-strategies`; the bridge picks one per
 * payload and delegates delta/completion shape to it.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger, type GuardrailRegistry } from "@lobu/core";
import { Actions, Card, CardText, LinkButton } from "chat";
import { getDb } from "../../db/client.js";
import { getOrganizationSlug } from "../../utils/url-builder.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import {
  OutputGuardrailScanner,
  type OutputGuardrailTrip,
} from "../guardrails/output-scan.js";
import type { ThreadResponsePayload } from "../infrastructure/queue/index.js";
import { extractSettingsLinkButtons } from "../platform/link-buttons.js";
import type { ResponseRenderer } from "../platform/response-renderer.js";
import { captureChannelMessage } from "./channel-transcript.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import {
  type PlatformMetadata,
  platformMetadataString,
  readPlatformMetadata,
} from "./platform-metadata.js";
import {
  getResponseStrategy,
  type PlatformResponseStrategy,
  type StreamState,
} from "./platform-strategies/index.js";
import { resolveChatTarget } from "./platforms/shared.js";

const logger = createLogger("chat-response-bridge");

/**
 * Build the agent's admin-settings URL — `<publicWebUrl>/<orgSlug>/agents/<agentId>`
 * — for surfacing in user-facing error messages (e.g. NO_MODEL_CONFIGURED tells
 * the user where to connect a provider). Returns null when any required piece
 * is missing; callers fall back to non-linked guidance.
 *
 * `manager.publicGatewayUrl` is the gateway base, which in embedded mode
 * includes the `/lobu` path suffix (the gateway is mounted at `/lobu` under
 * the web app). Admin UI routes live at the web origin (`/<slug>/agents/...`)
 * NOT under `/lobu`, so strip a trailing `/lobu` before composing the link.
 */
async function buildAgentSettingsUrl(
  publicGatewayUrl: string | undefined,
  organizationId: string | undefined,
  agentId: string | undefined
): Promise<string | null> {
  if (!publicGatewayUrl || !organizationId || !agentId) return null;
  const slug = await getOrganizationSlug(organizationId).catch(() => null);
  if (!slug) return null;
  const webOrigin = publicGatewayUrl
    .replace(/\/+$/, "")
    .replace(/\/lobu$/, "");
  return `${webOrigin}/${slug}/agents/${encodeURIComponent(agentId)}`;
}

/**
 * Construct a minimal Chat SDK `Message`-shaped object from the inbound
 * sender carried on `platformMetadata`. We only need enough to keep the SDK's
 * streaming code path happy — it reads `_currentMessage.author.userId` and
 * `_currentMessage.raw.team_id`/`raw.team` for ephemeral/DM fallback hints.
 * Passing `{}` crashes the SDK; passing `undefined` silently disables the
 * recipient hint; a proper Message preserves it.
 */
function buildCurrentMessageFromMetadata(
  threadId: string,
  platformMetadata: PlatformMetadata
): Record<string, unknown> | undefined {
  const senderId = platformMetadata.senderId;
  if (!senderId) return undefined;
  const senderUsername = platformMetadata.senderUsername;
  const senderDisplayName = platformMetadata.senderDisplayName;
  const teamId = platformMetadata.teamId;
  return {
    threadId,
    text: "",
    author: {
      userId: senderId,
      userName: senderUsername,
      fullName: senderDisplayName,
    },
    raw: teamId ? { team_id: teamId, team: teamId } : {},
  };
}

interface ResponseContext {
  connectionId: string;
  instance: any;
  channelId: string;
  platform: string;
  strategy: PlatformResponseStrategy;
}

/**
 * ChatResponseBridge implements ResponseRenderer so it can be plugged into
 * the unified thread consumer alongside legacy platform renderers.
 */
export class ChatResponseBridge implements ResponseRenderer {
  private streams = new Map<string, StreamState>();
  /**
   * Output-stage guardrails. Shared with the API/SSE path
   * (UnifiedThreadResponseConsumer) so both surfaces enforce ONE policy:
   * when an agent has output guardrails, streaming deltas are withheld and
   * only the scanned, authoritative terminal text is delivered. This replaces
   * the bridge's former per-delta rolling-tail scanner + blockedStreams set —
   * that state was pod-local (so it never caught a secret split across deltas
   * on different replicas) and was not cleared on the error path (a trip then
   * an error left the next turn's stream silently blocked).
   */
  private readonly outputGuardrail = new OutputGuardrailScanner();

  constructor(private manager: ChatInstanceManager) {}

  /**
   * Wire output-stage guardrails. Both must be set for guardrails to run;
   * with neither, the bridge behaves as before.
   */
  setGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.outputGuardrail.setGuardrails(registry, settingsStore);
  }

  /**
   * Resolve the agentId for a payload: payload metadata first, then the
   * bound connection's agent. Returns `null` when neither is known so
   * the caller can skip guardrails rather than block.
   */
  private resolveAgentId(
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): string | null {
    const md = readPlatformMetadata(payload.platformMetadata);
    if (md.agentId) return md.agentId;
    const fromConnection = ctx.instance?.connection?.agentId;
    return typeof fromConnection === "string" && fromConnection
      ? fromConnection
      : null;
  }

  /**
   * Resolve the organization id for audit attribution: payload metadata
   * first, then the connection record. Undefined only when neither is
   * available — the audit module logs that gap loudly.
   */
  private resolveOrganizationId(
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): string | undefined {
    const md = readPlatformMetadata(payload.platformMetadata);
    if (md.organizationId) return md.organizationId;
    const fromConnection = ctx.instance?.connection?.organizationId;
    return typeof fromConnection === "string" && fromConnection
      ? fromConnection
      : undefined;
  }

  /**
   * Whether this payload's agent has output guardrails configured. When true,
   * streaming deltas are withheld and only the scanned terminal text is sent.
   */
  private async hasOutputGuardrails(
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): Promise<boolean> {
    const agentId = this.resolveAgentId(payload, ctx);
    if (!agentId) return false;
    return this.outputGuardrail.hasOutputGuardrails(
      agentId,
      this.resolveOrganizationId(payload, ctx)
    );
  }

  /**
   * Scan the authoritative terminal text (reply or error). Returns the trip
   * (already audited) on block, `null` when safe to send / no guardrails.
   */
  private async scanTerminalOutput(
    text: string,
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): Promise<OutputGuardrailTrip | null> {
    const agentId = this.resolveAgentId(payload, ctx);
    if (!agentId || !text) return null;
    return this.outputGuardrail.scanFinal(text, {
      agentId,
      organizationId: this.resolveOrganizationId(payload, ctx),
      userId: payload.userId,
      conversationId: payload.conversationId,
      platform: ctx.platform,
    });
  }

  private extractResponseContext(
    payload: ThreadResponsePayload
  ): ResponseContext | null {
    const md = readPlatformMetadata(payload.platformMetadata);
    const connectionId = md.connectionId;
    if (!connectionId) return null;

    const instance = this.manager.getInstance(connectionId);
    if (!instance) return null;

    const channelId = md.chatId ?? md.responseChannel ?? payload.channelId;

    const platform = instance.connection.platform;

    return {
      connectionId,
      instance,
      channelId,
      platform,
      strategy: getResponseStrategy(platform),
    };
  }

  /**
   * Check if this payload belongs to a Chat SDK connection AND make this
   * replica able to deliver it. Connections hydrate lazily (no boot
   * warm-start), so whichever replica claims a thread_response hydrates the
   * connection from its row before rendering — gating on a warm instance
   * alone would make the webhook-receiving pod the only possible deliverer,
   * which breaks the moment it restarts. Returns false for non-Chat-SDK
   * payloads and for connections this replica cannot run (deleted, stopped,
   * or an exclusive transport owned by another replica — the consumer's
   * retry re-queues those until the owner claims the job).
   */
  async ensureDeliverable(data: ThreadResponsePayload): Promise<boolean> {
    const connectionId = platformMetadataString(
      data.platformMetadata,
      "connectionId"
    );
    if (!connectionId) return false;
    return this.manager.warmConnection(connectionId);
  }

  async handleDelta(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<string | null> {
    void sessionKey;
    if (payload.delta === undefined) return null;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return null;

    const { strategy, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    // Withhold streaming deltas when the agent has output guardrails: a secret
    // split across deltas (and, under N>1, scattered across replicas) cannot be
    // reliably scanned mid-stream, so we don't stream at all. The full,
    // authoritative text is scanned and delivered at completion instead
    // (handleCompletion). Agents without output guardrails stream unchanged.
    if (await this.hasOutputGuardrails(payload, ctx)) return null;

    // Full-replacement disposes the prior stream so the strategy starts fresh.
    const existingForReplacement = this.streams.get(key);
    if (payload.isFullReplacement && existingForReplacement) {
      await strategy.disposeOnFullReplacement(existingForReplacement);
      this.streams.delete(key);
    }

    // After the (possible) full-replacement dispose, `current` is
    // undefined and the strategy starts a fresh stream.
    const current = this.streams.get(key);

    const next = await strategy.handleDelta({
      ctx,
      payload,
      existing: current,
      resolveTarget: () => this.resolveTargetForPayload(ctx, payload),
    });

    if (next) {
      this.streams.set(key, next);
    } else {
      this.streams.delete(key);
    }
    return null;
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId, strategy, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    const stream = this.streams.get(key);
    if (stream) {
      // Close the iterator and drain the in-flight post regardless of
      // strategy — Slack's iterator is already closed (no-op), default's
      // needs explicit close+await before final delivery steps run.
      stream.iterator.close();
      try {
        await stream.streamPromise;
      } catch (error) {
        logger.debug(
          { connectionId, error: String(error) },
          "Adapter stream errored during completion"
        );
      }
    }

    // Deliver when this replica has a local stream OR when this is a post-once
    // strategy (Slack) carrying the worker's full text. Under N>1 replicas the
    // delta rows and the terminal row are claimed competitively from the shared
    // `thread_response` queue with no per-conversation affinity, so the
    // completion can land on a pod that buffered no (or only some) deltas — only
    // `payload.finalText` is authoritative there. A live-streaming strategy with
    // no local stream already posted its deltas on the claiming replica, so it
    // is intentionally skipped (re-posting would duplicate).
    const canDeliverFromFinalText =
      strategy.deliversAtCompletion && !!payload.finalText?.trim();

    // When streaming was WITHHELD (guardrail agent), no deltas were sent on any
    // replica, so the authoritative finalText must be delivered here even for a
    // live-streaming strategy — its own handleCompletion returns early without a
    // local stream. (For non-guardrail agents this is false, preserving the
    // existing cross-pod no-double-post behavior.)
    const deliverWithheldFinalText =
      !strategy.deliversAtCompletion &&
      !stream &&
      !!payload.finalText?.trim() &&
      (await this.hasOutputGuardrails(payload, ctx));

    // Output guardrail on the full, authoritative terminal text. This is the
    // SINGLE enforcement point (deltas were withheld upstream for guardrail
    // agents), so it is replica-safe: it scans `payload.finalText` — set by the
    // worker on every completion — not pod-local stream buffers. On a trip:
    // post the block message and suppress both delivery and history.
    let blockedAtCompletion = false;
    {
      const completionText = payload.finalText ?? stream?.buffer ?? "";
      if (completionText.trim()) {
        const trip = await this.scanTerminalOutput(completionText, payload, ctx);
        if (trip) {
          blockedAtCompletion = true;
          await this.postGuardrailBlock(
            payload,
            ctx,
            trip,
            "Failed to post guardrail block message at completion"
          );
        }
      }
    }

    if (!blockedAtCompletion && (stream || canDeliverFromFinalText)) {
      await strategy.handleCompletion({ ctx, payload, stream: stream ?? null });
    } else if (!blockedAtCompletion && deliverWithheldFinalText) {
      // Post the scanned finalText directly — the live-streaming strategy can't
      // deliver it stream-less, and nothing was streamed (deltas withheld).
      await this.postToPayloadTarget(
        payload,
        ctx,
        payload.finalText as string,
        "Failed to deliver withheld final text"
      );
    }
    if (stream) this.streams.delete(key);

    const conversationState =
      this.manager.getInstance(connectionId)?.conversationState;

    // Gap 1: Store outgoing response in history. Wrap so that a state-store
    // outage doesn't fail the whole response delivery — the user has
    // already seen the message; missing history is recoverable, a 500
    // here is not. Prefer the worker's authoritative finalText: under N>1
    // replicas `stream?.buffer` is null (cross-pod) or only the subset of
    // deltas this pod claimed, so persisting it would store a truncated reply.
    const historyText = payload.finalText ?? stream?.buffer;
    if (!blockedAtCompletion && historyText?.trim() && conversationState) {
      try {
        await conversationState.appendHistory(
          connectionId,
          channelId,
          payload.conversationId,
          {
            role: "assistant",
            content: historyText,
            timestamp: Date.now(),
          }
        );
      } catch (error) {
        logger.warn(
          { connectionId, channelId, error: String(error) },
          "Failed to persist assistant response to history (continuing)"
        );
      }
      // Durable transcript: persist the bot's interactive reply too, so
      // read_conversation shows both sides. No platform message id is surfaced
      // here, so key on the turn's messageId (stable across a redelivered
      // completion). Fire-and-forget + idempotent.
      const replyMd = readPlatformMetadata(payload.platformMetadata);
      if (replyMd.organizationId) {
        captureChannelMessage({
          organizationId: replyMd.organizationId,
          connectionId,
          platform: ctx.platform,
          channelId,
          threadId:
            payload.conversationId && payload.conversationId !== channelId
              ? payload.conversationId
              : null,
          platformMessageId: `bot:${payload.messageId}`,
          authorId: replyMd.agentId,
          authorName: replyMd.agentId,
          teamId: replyMd.teamId ?? null,
          isBot: true,
          text: historyText,
          occurredAt: new Date(),
        });
      }
    }

    // Session reset: clear history and delete session file
    const completionMd = readPlatformMetadata(payload.platformMetadata);
    if (completionMd.sessionReset) {
      const agentId = completionMd.agentId;
      try {
        await conversationState?.clearHistory(
          connectionId,
          channelId,
          payload.conversationId
        );
        logger.info(
          { connectionId, channelId, conversationId: payload.conversationId },
          "Cleared chat history for session reset"
        );
      } catch (error) {
        logger.warn(
          { error: String(error) },
          "Failed to clear chat history on session reset"
        );
      }
      if (agentId) {
        try {
          const sessionPath = resolve(
            "workspaces",
            agentId,
            ".openclaw",
            "session.jsonl"
          );
          await unlink(sessionPath);
          logger.info(
            { agentId, sessionPath },
            "Deleted session file for session reset"
          );
        } catch (error) {
          // File may not exist — that's fine
          logger.debug(
            { agentId, error: String(error) },
            "No session file to delete on reset"
          );
        }

        // The next worker boot would rehydrate from Postgres unless we
        // also purge the snapshot rows for this conversation. The
        // worker's reset path does the same purge via the
        // `/worker/transcript/snapshot` DELETE endpoint, but we
        // belt-and-suspenders here in case the worker exited before it
        // got to that step. Resolve the org via `agents.organization_id`
        // — the bridge doesn't carry org on the response payload.
        try {
          const sql = getDb();
          const deleted = await sql<{ id: number }>`
            DELETE FROM public.agent_transcript_snapshot s
            USING public.agents a
            WHERE s.agent_id = ${agentId}
              AND s.conversation_id = ${payload.conversationId}
              AND a.id = s.agent_id
              AND a.organization_id = s.organization_id
            RETURNING s.id
          `;
          if (deleted.length > 0) {
            logger.info(
              { agentId, conversationId: payload.conversationId, count: deleted.length },
              "Purged agent_transcript_snapshot rows for session reset"
            );
          }
        } catch (error) {
          logger.warn(
            { agentId, conversationId: payload.conversationId, error: String(error) },
            "Failed to purge transcript snapshots on session reset (next boot may rehydrate stale history)"
          );
        }
      }
    }

    logger.info(
      {
        connectionId,
        channelId,
        conversationId: payload.conversationId,
      },
      "Response completed via Chat SDK bridge"
    );
  }

  async handleError(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    if (!payload.error) return;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    // Clean up stream — close iterator so the adapter call resolves.
    // Capture whether the worker already delivered a complete, self-contained
    // user-facing message (via `sendStreamDelta(..., isFullReplacement=true)`).
    // When it did, we must NOT post the fallback raw "Error: …" because the
    // user already saw a formatted failure message like "❌ Session failed: …".
    //
    // For partial streams that errored mid-way (`isFullReplacement` never set),
    // the fallback still fires so the user sees a failure indicator instead of
    // silently-truncated output.
    const stream = this.streams.get(key);
    const alreadyDeliveredCompleteMessage = !!stream?.wasFullyReplaced;
    if (stream) {
      stream.iterator.close();
      try {
        await stream.streamPromise;
      } catch {
        // swallow — we're already in error path
      }
      this.streams.delete(key);
    }

    if (alreadyDeliveredCompleteMessage) {
      logger.debug(
        { connectionId, channelId },
        "Skipping fallback error text — worker already delivered a complete user-facing message"
      );
      return;
    }

    // Session timeouts are retried automatically by the runs queue. The worker
    // deliberately suppresses its own user-facing crash delta for them, so the
    // platform fallback must stay silent too — otherwise the user sees a raw
    // "Error: SESSION_TIMEOUT" for a turn that is about to be retried.
    if (payload.errorCode === "SESSION_TIMEOUT") {
      logger.debug(
        { connectionId, channelId },
        "Skipping fallback error text — session timed out and will be retried"
      );
      return;
    }

    // For known error codes, render user-facing guidance with a real link
    // into the admin UI when we can resolve one. The settings page for an
    // agent is `<publicWebUrl>/<orgSlug>/agents/<agentId>`.
    if (payload.errorCode === "NO_MODEL_CONFIGURED") {
      const settingsUrl = await buildAgentSettingsUrl(
        this.manager.getPublicGatewayUrl(),
        this.resolveOrganizationId(payload, ctx) ?? undefined,
        this.resolveAgentId(payload, ctx) ?? undefined
      );
      payload.error = settingsUrl
        ? `No model configured. Connect a provider at ${settingsUrl}`
        : "No model configured. Ask an admin to connect a provider for the base agent.";
    }

    // Scan the error text before surfacing it — a provider/stack-trace error
    // can echo a secret. On a trip, post the generic block message instead of
    // the raw error.
    const errorTrip = await this.scanTerminalOutput(payload.error, payload, ctx);
    if (errorTrip) {
      await this.postGuardrailBlock(
        payload,
        ctx,
        errorTrip,
        "Failed to post guardrail block on error"
      );
      return;
    }

    // Fallback: plain text error via Chat SDK
    await this.postToPayloadTarget(
      payload,
      ctx,
      `Error: ${payload.error}`,
      "Failed to send error message"
    );
  }

  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    // Show typing indicator
    try {
      const target = await this.resolveTargetForPayload(ctx, payload);
      if (target) {
        await target.startTyping?.("Processing...");
      }
    } catch {
      // best effort
    }
  }

  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.content) return;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId } = ctx;

    try {
      const target = await this.resolveTargetForPayload(ctx, payload);
      if (target) {
        const { processedContent, linkButtons } = extractSettingsLinkButtons(
          payload.content
        );

        if (linkButtons.length > 0) {
          try {
            const card = Card({
              children: [
                CardText(processedContent),
                Actions(
                  linkButtons.map((button) =>
                    LinkButton({ url: button.url, label: button.text })
                  )
                ),
              ],
            });
            await target.post({
              card,
              fallbackText: `${processedContent}\n\n${linkButtons.map((button) => `${button.text}: ${button.url}`).join("\n")}`,
            });
            return;
          } catch (error) {
            logger.warn(
              { connectionId, error: String(error) },
              "Failed to render ephemeral settings button"
            );
            const fallbackText = `${processedContent}\n\n${linkButtons.map((button) => `${button.text}: ${button.url}`).join("\n")}`;
            await target.post(fallbackText.trim());
            return;
          }
        }

        await target.post(processedContent);
      }
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Failed to send ephemeral message"
      );
    }
  }

  // --- Private ---

  /**
   * Resolve the Chat-SDK post target for a payload, marshalling the
   * channel/conversation/responseThreadId/sender-hint arguments out of the
   * payload + context the same way at every call site.
   */
  private resolveTargetForPayload(
    ctx: ResponseContext,
    payload: ThreadResponsePayload
  ): Promise<any | null> {
    return this.resolveTarget(
      ctx.instance,
      ctx.channelId,
      payload.conversationId,
      platformMetadataString(payload.platformMetadata, "responseThreadId"),
      readPlatformMetadata(payload.platformMetadata)
    );
  }

  /**
   * Resolve the payload's target and post `content` to it, swallowing and
   * logging any failure. Shared by the guardrail-block and error-fallback
   * paths — a delivery failure here must never throw back into the consumer.
   */
  private async postToPayloadTarget(
    payload: ThreadResponsePayload,
    ctx: ResponseContext,
    content: unknown,
    logMessage: string
  ): Promise<void> {
    try {
      const target = await this.resolveTargetForPayload(ctx, payload);
      if (target) await target.post(content);
    } catch (err) {
      logger.error({ connectionId: ctx.connectionId, err: String(err) }, logMessage);
    }
  }

  /**
   * Post the user-facing "blocked by guardrail" notice for a trip. Shared by
   * the per-delta scan in handleDelta and the post-once scan in
   * handleCompletion so the block copy stays identical across both paths.
   */
  private postGuardrailBlock(
    payload: ThreadResponsePayload,
    ctx: ResponseContext,
    trip: { guardrail: string; reason?: string },
    logMessage: string
  ): Promise<void> {
    const blockText = `Message blocked by guardrail: ${trip.reason ?? trip.guardrail}`;
    return this.postToPayloadTarget(payload, ctx, blockText, logMessage);
  }

  private async resolveTarget(
    instance: any,
    channelId: string,
    conversationId?: string,
    responseThreadId?: string,
    platformMetadata: PlatformMetadata = {}
  ): Promise<any | null> {
    // Build the initialMessage from the inbound sender so the Chat SDK can
    // populate `_currentMessage.author` for `handleStream` (it reads
    // `.author.userId` unconditionally — passing `{}` crashes there). The
    // `threadId` field on the message is cosmetic (the SDK derives the thread
    // id from the positional arg), so one message serves both createThread
    // branches.
    const currentMessage = buildCurrentMessageFromMetadata(
      responseThreadId ?? conversationId ?? channelId,
      platformMetadata
    );
    return resolveChatTarget(instance.chat, instance.connection.platform, {
      channelId,
      conversationId,
      responseThreadId,
      currentMessage,
    });
  }
}
