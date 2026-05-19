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
import {
  createLogger,
  type GuardrailRegistry,
  runGuardrails,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { recordGuardrailTrip } from "../guardrails/audit.js";
import type { ThreadResponsePayload } from "../infrastructure/queue/index.js";
import { extractSettingsLinkButtons } from "../platform/link-buttons.js";
import type { ResponseRenderer } from "../platform/response-renderer.js";
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

const logger = createLogger("chat-response-bridge");

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
 * Streaming chunks split arbitrarily across token boundaries. A secret like
 * `sk-abc...` can arrive as `"sk-an"` then `"t-..."` and bypass every
 * per-delta regex. The bridge keeps a rolling tail of recent emitted text
 * per stream key (capped at OUTPUT_GUARDRAIL_TAIL_CHARS) and prepends it
 * to the next delta before scanning, so a pattern straddling a chunk
 * boundary still matches. Cleared on stream completion / dispose.
 *
 * 256 chars is generous against the regexes the built-ins ship — the
 * longest pattern (JWT) is bounded only on its first segment but the
 * second `.eyJ…` re-anchors, so a tail well above the first-segment
 * minimum suffices. Keep it tight to avoid quadratic scan cost on long
 * streams.
 */
const OUTPUT_GUARDRAIL_TAIL_CHARS = 256;

/**
 * ChatResponseBridge implements ResponseRenderer so it can be plugged into
 * the unified thread consumer alongside legacy platform renderers.
 */
export class ChatResponseBridge implements ResponseRenderer {
  private streams = new Map<string, StreamState>();
  /**
   * Tracks streams that an output guardrail already blocked. A stream that
   * trips mid-flight must not have any further deltas (or the final
   * completion buffer) reach the platform.
   */
  private blockedStreams = new Set<string>();
  /**
   * Per-stream rolling tail of emitted output text, used as a prefix when
   * scanning the next delta so secrets split across chunk boundaries still
   * match. Keyed by the same `key` as `streams`.
   */
  private guardrailTails = new Map<string, string>();
  private guardrailRegistry?: GuardrailRegistry;
  private agentSettingsStore?: AgentSettingsStore;

  constructor(private manager: ChatInstanceManager) {}

  /**
   * Wire output-stage guardrails. Both must be set for guardrails to run;
   * with neither, the bridge behaves as before.
   */
  setGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.guardrailRegistry = registry;
    this.agentSettingsStore = settingsStore;
  }

  /**
   * Resolve the agentId for a given response payload. Workers attach it on
   * `platformMetadata.agentId`; for cases where it's missing we fall back
   * to the bound connection's agent. Returns `null` when neither is known —
   * the caller should treat that as "skip guardrails" rather than block.
   */
  private resolveAgentId(
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): string | null {
    const md = readPlatformMetadata(payload.platformMetadata);
    if (md.agentId) return md.agentId;
    const fromConnection = ctx.instance?.connection?.agentId;
    if (typeof fromConnection === "string" && fromConnection)
      return fromConnection;
    return null;
  }

  /**
   * Resolve the organization id for audit attribution. Workers attach it
   * on `platformMetadata.organizationId`; the canonical fallback is the
   * connection record (`instance.connection.organizationId`), which is
   * set when the connection was created via the connections CRUD API and
   * is durable across requests. Returns `undefined` only when neither is
   * available — in that case the audit module logs the gap loudly.
   */
  private resolveOrganizationId(
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): string | undefined {
    const md = readPlatformMetadata(payload.platformMetadata);
    if (md.organizationId) return md.organizationId;
    const fromConnection = ctx.instance?.connection?.organizationId;
    if (typeof fromConnection === "string" && fromConnection)
      return fromConnection;
    return undefined;
  }

  /**
   * Append `delta` to the per-stream tail and return the rolling window
   * (tail-prefix + delta, capped at `OUTPUT_GUARDRAIL_TAIL_CHARS * 2`)
   * that should be scanned. The cap keeps the scanned slice bounded —
   * the slice length is at most ~2× the tail, so regex cost stays
   * proportional to the chunk being processed, not the entire stream.
   */
  private updateGuardrailTail(key: string, delta: string): string {
    const previous = this.guardrailTails.get(key) ?? "";
    const combined = previous + delta;
    // Keep the last 2 × tail chars so the next call can still build a
    // tail-prefix from this combined window if needed.
    const nextTail = combined.slice(-OUTPUT_GUARDRAIL_TAIL_CHARS * 2);
    this.guardrailTails.set(key, nextTail);
    // Return the scan slice: previous tail + current delta. Bound at
    // 2× tail to stay cheap.
    const scanSlice =
      previous.length > 0 ? previous + delta : delta;
    return scanSlice.length > OUTPUT_GUARDRAIL_TAIL_CHARS * 2
      ? scanSlice.slice(-OUTPUT_GUARDRAIL_TAIL_CHARS * 2)
      : scanSlice;
  }

  /** Drop the rolling tail when a stream finishes or is disposed. */
  private clearGuardrailTail(key: string): void {
    this.guardrailTails.delete(key);
  }

  /**
   * Run output-stage guardrails for a single delta. Returns the trip outcome
   * (already audited) when blocked, `null` when the delta is safe to send.
   * Failures inside the runner are logged and treated as a pass.
   *
   * The scan operates on `tailPrefix + delta`, not just `delta`, so a
   * secret split across two streaming chunks still trips on the second
   * chunk. The tail is updated in `handleDelta` only after a passing
   * scan — a tripped stream is disposed and its tail dropped, so we
   * never carry blocked-stream state forward.
   */
  private async runOutputGuardrails(
    scanText: string,
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): Promise<{ guardrail: string; reason?: string } | null> {
    if (!this.guardrailRegistry || !this.agentSettingsStore) return null;
    if (!scanText) return null;
    const agentId = this.resolveAgentId(payload, ctx);
    if (!agentId) return null;

    try {
      const settings = await this.agentSettingsStore.getSettings(agentId);
      const enabled = settings?.guardrails ?? [];
      if (enabled.length === 0) return null;
      const outcome = await runGuardrails(
        this.guardrailRegistry,
        "output",
        enabled,
        {
          agentId,
          userId: payload.userId,
          text: scanText,
          platform: ctx.platform,
          conversationId: payload.conversationId,
        }
      );
      if (!outcome.tripped) return null;
      // Fire-and-forget: the audit module returns a promise that never
      // rejects. Don't block delivery of the block message on the write.
      void recordGuardrailTrip({
        organizationId: this.resolveOrganizationId(payload, ctx),
        agentId,
        userId: payload.userId,
        conversationId: payload.conversationId,
        stage: "output",
        guardrail: outcome.tripped.guardrail,
        reason: outcome.tripped.reason,
        metadata: outcome.tripped.metadata,
      });
      return {
        guardrail: outcome.tripped.guardrail,
        reason: outcome.tripped.reason,
      };
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        "Output guardrail check failed — proceeding without guardrails"
      );
      return null;
    }
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
   * Check if this payload belongs to a Chat SDK connection.
   * Returns false if the connection is not managed — the caller should fall through to legacy.
   */
  canHandle(data: ThreadResponsePayload): boolean {
    const connectionId = platformMetadataString(
      data.platformMetadata,
      "connectionId"
    );
    return !!connectionId && this.manager.has(connectionId);
  }

  async handleDelta(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<string | null> {
    void sessionKey;
    if (payload.delta === undefined) return null;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return null;

    const { strategy, instance, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    // If a prior delta in this stream tripped a guardrail, drop everything
    // else for the rest of the message. We've already posted the block
    // notice; the worker may keep streaming because trip handling here is
    // async to the worker — silently swallowing the tail is correct.
    if (this.blockedStreams.has(key)) return null;

    // Full-replacement: dispose the prior stream + drop the rolling tail
    // BEFORE scanning. Order matters: a replacement throws away the previous
    // emitted text, so the next scan must operate on the new delta alone.
    // Without clearing first, the tail would still hold the previous
    // delta's last 256 chars and the scan would run against
    // (previous-stream-bytes + new-replacement-text), which can synthesize
    // a regex match that exists in neither piece on its own — a false
    // positive trip on the very first delta of an unrelated reply.
    const existingForReplacement = this.streams.get(key);
    if (payload.isFullReplacement && existingForReplacement) {
      await strategy.disposeOnFullReplacement(existingForReplacement);
      this.streams.delete(key);
      this.clearGuardrailTail(key);
    }

    // Per-delta output guardrails. We scan `(rolling tail) + delta` so a
    // secret split across two streaming chunks ("sk-ab" then "cd…") still
    // trips on the second chunk. The tail is only updated after a passing
    // scan — tripping disposes the stream and drops its tail.
    const scanText = this.updateGuardrailTail(key, payload.delta);
    const trip = await this.runOutputGuardrails(scanText, payload, ctx);
    if (trip) {
      this.blockedStreams.add(key);
      // Drop the rolling tail — the stream is dead, no further deltas
      // will be scanned for this key, and we don't want a future stream
      // re-using the key to inherit the blocked stream's bytes.
      this.clearGuardrailTail(key);
      // Close any in-flight strategy stream so the partial output that
      // already shipped to the platform terminates cleanly. We can't
      // unsend bytes already delivered, but for the default strategy
      // (Telegram buffers a single edit) the block message will replace
      // the partial; for Slack, the user sees the partial followed by
      // the block notice. Closing here also prevents further deltas from
      // being appended.
      const existingStream = this.streams.get(key);
      if (existingStream) {
        try {
          await strategy.disposeOnFullReplacement(existingStream);
        } catch (err) {
          logger.debug(
            { err: String(err) },
            "Failed to dispose stream on guardrail block (continuing)"
          );
        }
        this.streams.delete(key);
      }
      const blockText = `Message blocked by guardrail: ${trip.reason ?? trip.guardrail}`;
      try {
        const target = await this.resolveTarget(
          instance,
          channelId,
          payload.conversationId,
          platformMetadataString(payload.platformMetadata, "responseThreadId"),
          readPlatformMetadata(payload.platformMetadata)
        );
        if (target) {
          await target.post(blockText);
        }
      } catch (err) {
        logger.error(
          { err: String(err) },
          "Failed to post guardrail block message"
        );
      }
      return null;
    }

    // Pick up the current stream after the (possible) full-replacement
    // dispose above. If we disposed, `current` stays undefined so the
    // strategy starts a fresh stream.
    const current = this.streams.get(key);

    const next = await strategy.handleDelta({
      ctx,
      payload,
      existing: current,
      resolveTarget: () =>
        this.resolveTarget(
          instance,
          channelId,
          payload.conversationId,
          platformMetadataString(payload.platformMetadata, "responseThreadId"),
          readPlatformMetadata(payload.platformMetadata)
        ),
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

    // If a guardrail blocked this stream mid-flight, skip completion
    // entirely: stream was disposed at trip time, the block message was
    // posted, and we don't want the partial buffer landing in history.
    if (this.blockedStreams.has(key)) {
      this.blockedStreams.delete(key);
      this.streams.delete(key);
      this.clearGuardrailTail(key);
      logger.info(
        { connectionId, channelId, conversationId: payload.conversationId },
        "Completion suppressed — stream was blocked by guardrail"
      );
      return;
    }

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

      await strategy.handleCompletion({ ctx, payload, stream });
      this.streams.delete(key);
    }
    // Drop the rolling guardrail tail on any non-blocked completion path —
    // next stream on the same key starts with a fresh tail.
    this.clearGuardrailTail(key);

    const conversationState =
      this.manager.getInstance(connectionId)?.conversationState;

    // Gap 1: Store outgoing response in history. Wrap so that a state-store
    // outage doesn't fail the whole response delivery — the user has
    // already seen the message; missing history is recoverable, a 500
    // here is not.
    if (stream?.buffer.trim() && conversationState) {
      try {
        await conversationState.appendHistory(connectionId, channelId, {
          role: "assistant",
          content: stream.buffer,
          timestamp: Date.now(),
        });
      } catch (error) {
        logger.warn(
          { connectionId, channelId, error: String(error) },
          "Failed to persist assistant response to history (continuing)"
        );
      }
    }

    // Session reset: clear history and delete session file
    const completionMd = readPlatformMetadata(payload.platformMetadata);
    if (completionMd.sessionReset) {
      const agentId = completionMd.agentId;
      try {
        await conversationState?.clearHistory(connectionId, channelId);
        logger.info(
          { connectionId, channelId },
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

        // Phase 5: in snapshot mode the next worker boot would rehydrate
        // from Postgres unless we also purge the snapshot rows for this
        // conversation. The worker's reset path does the same purge via
        // the `/worker/transcript/snapshot` DELETE endpoint, but we
        // belt-and-suspenders here in case the worker exited before it
        // got to that step. Resolve the org via `agents.organization_id`
        // — the bridge doesn't carry org on the response payload.
        if (process.env.LOBU_SESSION_STORE !== "file") {
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

    const { connectionId, instance, channelId } = ctx;
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

    // For known error codes, render user-facing guidance without sending users
    // to the retired end-user settings UI.
    if (payload.errorCode === "NO_MODEL_CONFIGURED") {
      payload.error =
        "No model configured. Provider setup is not available in the end-user chat flow yet. Ask an admin to connect a provider for the base agent.";
    }

    // Fallback: plain text error via Chat SDK
    try {
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        platformMetadataString(payload.platformMetadata, "responseThreadId"),
        readPlatformMetadata(payload.platformMetadata)
      );
      if (target) {
        await target.post(`Error: ${payload.error}`);
      }
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Failed to send error message"
      );
    }
  }

  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { instance, channelId } = ctx;

    // Show typing indicator
    try {
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        platformMetadataString(payload.platformMetadata, "responseThreadId"),
        readPlatformMetadata(payload.platformMetadata)
      );
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

    const { connectionId, instance, channelId } = ctx;

    try {
      const target = await this.resolveTarget(
        instance,
        channelId,
        payload.conversationId,
        platformMetadataString(payload.platformMetadata, "responseThreadId"),
        readPlatformMetadata(payload.platformMetadata)
      );
      if (target) {
        const { processedContent, linkButtons } = extractSettingsLinkButtons(
          payload.content
        );

        if (linkButtons.length > 0) {
          try {
            const { Actions, Card, CardText, LinkButton } = await import(
              "chat"
            );
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

  private async resolveTarget(
    instance: any,
    channelId: string,
    conversationId?: string,
    responseThreadId?: string,
    platformMetadata: PlatformMetadata = {}
  ): Promise<any | null> {
    const platform = instance.connection.platform;
    const chat = instance.chat;

    // If we have a full thread ID (e.g. telegram:{chatId}:{topicId}), use
    // createThread so the response lands in the correct forum topic.
    if (responseThreadId) {
      const adapter = chat.getAdapter?.(platform);
      const createThread = (chat as any).createThread;
      if (adapter && typeof createThread === "function") {
        try {
          // Build the initialMessage from the inbound sender so the Chat SDK
          // can populate `_currentMessage.author` for `handleStream` (it reads
          // `.author.userId` unconditionally — passing `{}` crashes there).
          const currentMessage = buildCurrentMessageFromMetadata(
            responseThreadId,
            platformMetadata
          );
          const thread = await createThread.call(
            chat,
            adapter,
            responseThreadId,
            currentMessage,
            false
          );
          if (thread) return thread;
        } catch (error) {
          logger.debug(
            { platform, responseThreadId, error: String(error) },
            "createThread from responseThreadId failed, falling back"
          );
        }
      }
    }

    const channelKey = `${platform}:${channelId}`;

    if (!conversationId || conversationId === channelId) {
      const channel = chat.channel?.(channelKey);
      if (channel) {
        return channel;
      }
      logger.warn(
        {
          platform,
          channelId,
          channelKey,
          conversationId,
          hasChannelFn: !!chat.channel,
        },
        "chat.channel() returned null for DM"
      );
      return null;
    }

    // Threaded fallback: `conversationId` is the Chat SDK's canonical
    // `thread.id` (e.g. `slack:{channel}:{parent_thread_ts}`) — pass it
    // straight to `createThread`.
    const adapter = chat.getAdapter?.(platform);
    const createThread = (chat as any).createThread;
    if (adapter && typeof createThread === "function") {
      try {
        const currentMessage = buildCurrentMessageFromMetadata(
          conversationId,
          platformMetadata
        );
        const thread = await createThread.call(
          chat,
          adapter,
          conversationId,
          currentMessage,
          false
        );
        if (thread) return thread;
      } catch (error) {
        logger.warn(
          { platform, conversationId, error: String(error) },
          "createThread with conversationId failed"
        );
      }
    }

    // Last-resort channel-level fallback so the response still lands somewhere
    // instead of silently disappearing.
    const channel = chat.channel?.(channelKey);
    if (!channel) {
      logger.warn(
        { platform, channelId, channelKey, conversationId },
        "resolveTarget: unable to resolve thread or channel"
      );
    }
    return channel ?? null;
  }
}
