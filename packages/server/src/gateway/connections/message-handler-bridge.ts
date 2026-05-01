/**
 * Message handler bridge — connects Chat SDK events to the message queue.
 * Bridges all 9 feature gaps: history, agent auto-creation, provider setup,
 * settings links, allowlist, audio transcription, etc.
 */

import {
  createLogger,
  createRootSpan,
  flushTracing,
  generateTraceId,
} from "@lobu/core";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import { createChatReply } from "../commands/command-reply-adapters.js";
import type { ArtifactStore } from "../files/artifact-store.js";
import type { CoreServices } from "../platform.js";
import {
  buildMessagePayload,
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers.js";
import type { ConversationStateStore } from "./conversation-state-store.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import type { PlatformConnection } from "./types.js";

const logger = createLogger("chat-message-bridge");

/**
 * Inbound file shape passed to the worker on platformMetadata.files.
 * `downloadUrl` is a signed, time-limited public artifact URL the worker
 * can fetch over the proxy without any platform-specific auth.
 */
interface IngestedFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  downloadUrl: string;
}

const AUDIO_MIMES_PREFIX = ["audio/"] as const;
const AUDIO_MIMES_EXACT = new Set(["application/ogg"]);

function isAudioAttachment(mime: string | undefined): boolean {
  if (!mime) return false;
  if (AUDIO_MIMES_EXACT.has(mime)) return true;
  return AUDIO_MIMES_PREFIX.some((p) => mime.startsWith(p));
}

function deriveFilename(
  attachment: { name?: string; mimeType?: string; type?: string },
  index: number
): string {
  if (attachment.name?.trim()) return attachment.name.trim();
  const ext = attachment.mimeType?.split("/")[1]?.split(";")[0];
  const stem = attachment.type || "attachment";
  return ext ? `${stem}-${index + 1}.${ext}` : `${stem}-${index + 1}`;
}

/**
 * Inbound chat SDK attachment shape (loose subset of `chat.Attachment`).
 * Defined here so that this module — and its tests — don't have to take a
 * runtime dependency on the chat SDK.
 */
export interface InboundAttachmentLike {
  data?: Buffer | Blob;
  fetchData?: () => Promise<Buffer>;
  mimeType?: string;
  name?: string;
  size?: number;
  type?: string;
}

/**
 * Fetch every inbound attachment via the chat SDK's auth-aware
 * `Attachment.fetchData()` and publish each as a gateway artifact. Returns
 * the worker-facing `files` array (signed `downloadUrl` per file) and the
 * raw audio buffers needed by the transcription path. Errors fetching an
 * individual attachment are logged and skipped — they must not abort the
 * whole message.
 */
export async function ingestInboundAttachments(
  attachments: InboundAttachmentLike[] | undefined,
  artifactStore: ArtifactStore,
  publicGatewayUrl: string
): Promise<{
  files: IngestedFile[];
  audioBytes: Array<{ buffer: Buffer; mimeType: string }>;
}> {
  if (!attachments?.length) return { files: [], audioBytes: [] };

  const files: IngestedFile[] = [];
  const audioBytes: Array<{ buffer: Buffer; mimeType: string }> = [];

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]!;
    try {
      let buffer: Buffer | undefined;
      if (att.data) {
        buffer = Buffer.isBuffer(att.data)
          ? att.data
          : Buffer.from(await (att.data as Blob).arrayBuffer());
      } else if (att.fetchData) {
        buffer = await att.fetchData();
      }
      if (!buffer || buffer.length === 0) {
        logger.warn(
          { mimeType: att.mimeType, type: att.type, name: att.name },
          "Skipping inbound attachment with no fetchable data"
        );
        continue;
      }
      const mimeType = att.mimeType || "application/octet-stream";
      if (isAudioAttachment(mimeType)) {
        audioBytes.push({ buffer, mimeType });
      }
      const filename = deriveFilename(att, i);
      const published = await artifactStore.publish({
        buffer,
        filename,
        contentType: mimeType,
        publicGatewayUrl,
      });
      files.push({
        id: published.artifactId,
        name: published.filename,
        mimetype: published.contentType,
        size: published.size,
        downloadUrl: published.downloadUrl,
      });
    } catch (error) {
      logger.error(
        {
          error: String(error),
          mimeType: att.mimeType,
          type: att.type,
          name: att.name,
        },
        "Failed to ingest inbound attachment"
      );
    }
  }

  return { files, audioBytes };
}

export function isSenderAllowed(
  allowFrom: string[] | undefined,
  userId: string
): boolean {
  if (!Array.isArray(allowFrom)) {
    return true;
  }
  return allowFrom.includes(userId);
}

/**
 * Register Chat SDK event handlers for a connection.
 *
 * Returns the bridge instance so callers (e.g. ChatInstanceManager) can
 * reuse its enqueue pipeline for non-`onNewMention` ingress points —
 * specifically, button clicks from the interaction bridge.
 */
export function registerMessageHandlers(
  chat: any,
  connection: PlatformConnection,
  services: CoreServices,
  manager: ChatInstanceManager,
  commandDispatcher?: CommandDispatcher
): MessageHandlerBridge {
  const handler = new MessageHandlerBridge(
    connection,
    services,
    manager,
    commandDispatcher
  );

  chat.onNewMention(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "mention");
  });

  chat.onDirectMessage(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "dm");
  });

  chat.onSubscribedMessage(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "subscribed");
  });

  return handler;
}

export class MessageHandlerBridge {
  private artifactStore: ArtifactStore;
  private publicGatewayUrl: string;

  constructor(
    private connection: PlatformConnection,
    private services: CoreServices,
    private manager: ChatInstanceManager,
    private commandDispatcher?: CommandDispatcher
  ) {
    this.artifactStore = services.getArtifactStore();
    this.publicGatewayUrl = services.getPublicGatewayUrl();
  }

  /**
   * Locate the per-connection history store. Read lazily since the instance
   * is registered after `registerMessageHandlers` runs.
   */
  private conversationState(): ConversationStateStore | null {
    return (
      this.manager.getInstance(this.connection.id)?.conversationState ?? null
    );
  }

  async handleMessage(
    thread: any,
    message: any,
    source: "mention" | "dm" | "subscribed"
  ): Promise<void> {
    const { connection } = this;

    // Guard: drop messages if the connection was stopped/removed
    if (!this.manager.has(connection.id)) {
      logger.info(
        { connectionId: connection.id },
        "Connection no longer active, dropping message"
      );
      return;
    }

    const platform = connection.platform;
    const userId = message.author?.userId ?? "unknown";
    const channelId = thread.channelId ?? thread.id ?? "unknown";
    const messageId = message.id ?? String(Date.now());
    const isGroup = source === "mention" || source === "subscribed";
    // Collapse to the canonical `thread.id` whenever we're inside an existing
    // thread — group thread reply OR DM thread reply alike. Slack encodes
    // `slack:{channel}:{thread_ts}` (top-level DM has empty thread_ts so the id
    // ends with a trailing `:`); Telegram encodes `telegram:{chatId}` for
    // top-level and `telegram:{chatId}:{topicId}` inside a forum topic. Without
    // this, a `onDirectMessage` event for a reply in a DM thread (e.g. the
    // worker posted a scheduled-fire follow-up message and the user
    // clicked Reply on it) would fall back to the channel id and the bot's
    // response would land in the main DM pane instead of the thread.
    const isThreadReply =
      typeof thread.id === "string" &&
      thread.id !== channelId &&
      thread.id !== `${channelId}:`;
    const conversationId =
      isGroup || isThreadReply ? (thread.id as string) : channelId;

    logger.info(
      {
        connectionId: connection.id,
        platform,
        userId,
        channelId,
        messageId,
        source,
      },
      "Processing inbound message"
    );

    // Gap 6: Allowlist check
    if (!isSenderAllowed(connection.settings?.allowFrom, userId)) {
      logger.info({ userId }, "Blocked by allowlist");
      return;
    }

    // Gap 6: Group check
    if (isGroup && connection.settings?.allowGroups === false) {
      logger.info({ channelId }, "Groups not allowed");
      return;
    }

    // Subscribe to thread for follow-up messages
    if (source === "mention" || source === "dm") {
      try {
        await thread.subscribe();
      } catch {
        // some platforms may not support subscribe
      }
    }

    // Gap 2: Resolve agent ID (cross-platform) — see resolveAgentId's contract
    // for the 3-tier precedence (binding → template → shadow). We own the
    // auto-bind side effect here so resolveAgentId can stay pure.
    const channelBindingService = this.services.getChannelBindingService();
    const rawTeamId =
      (message.raw as Record<string, unknown> | undefined)?.team_id ??
      (message.raw as Record<string, unknown> | undefined)?.team;
    const teamId = typeof rawTeamId === "string" ? rawTeamId : undefined;

    const resolved = await resolveAgentId({
      platform,
      userId,
      channelId,
      isGroup,
      teamId,
      templateAgentId: this.connection.templateAgentId,
      channelBindingService,
    });
    const agentId = resolved.agentId;

    // Tier 2 hit → persist a binding so subsequent events are O(1) tier-1
    // hits and the binding is visible via the admin API.
    if (resolved.source === "template" && channelBindingService) {
      try {
        await channelBindingService.createBinding(
          agentId,
          platform,
          channelId,
          teamId,
          { configuredBy: `connection:${this.connection.id}` }
        );
        logger.info(
          { agentId, platform, channelId, teamId },
          "Auto-bound channel to connection template agent"
        );
      } catch (error) {
        logger.warn(
          { agentId, platform, channelId, error: String(error) },
          "Failed to persist channel binding from connection template"
        );
      }
    }

    // Gap 2: Auto-create agent metadata for shadow agents only.
    // When the resolved agent is the connection's owning template (either
    // routed there by an existing binding or just auto-bound above), the
    // agent metadata is already owned by the template's definition — do
    // NOT overwrite it with a shadow owner/name, or we clobber the real
    // agent's identity every time someone new DMs the bot.
    const isTemplateAgent = agentId === this.connection.templateAgentId;
    if (!isTemplateAgent) {
      const agentMetadataStore = this.services.getAgentMetadataStore();
      const userAgentsStore = this.services.getUserAgentsStore();
      if (agentMetadataStore) {
        const existing = await agentMetadataStore.getMetadata(agentId);
        if (!existing) {
          const agentName = isGroup
            ? `${platform} Group ${channelId}`
            : `${platform} ${message.author?.fullName || userId}`;
          await agentMetadataStore.createAgent(
            agentId,
            agentName,
            platform,
            userId,
            { parentConnectionId: this.connection.id }
          );
          await userAgentsStore?.addAgent(platform, userId, agentId);
          logger.info({ agentId, userId }, "Auto-created shadow agent");
        }
      }
    }

    // Ingest every inbound attachment as an artifact, regardless of type.
    // Workers consume them via `platformMetadata.files`; we never hand the
    // worker platform-specific file IDs or bot tokens.
    const { files: ingestedFiles, audioBytes } = await ingestInboundAttachments(
      message.attachments,
      this.artifactStore,
      this.publicGatewayUrl
    );

    // Gap 7: Audio transcription — runs over the bytes we already fetched.
    let messageText = message.text ?? "";
    const transcriptionService = this.services.getTranscriptionService();
    if (transcriptionService && audioBytes.length > 0) {
      for (const audio of audioBytes) {
        try {
          const result = await transcriptionService.transcribe(
            audio.buffer,
            agentId,
            audio.mimeType
          );
          if ("text" in result && result.text) {
            messageText = messageText
              ? `${messageText}\n\n[Voice message]: ${result.text}`
              : result.text;
          }
        } catch (error) {
          logger.warn(
            { error: String(error), messageId },
            "Audio transcription failed"
          );
        }
      }
    }

    // Remove bot mention from text. Slack delivers raw `<@Uxxx>` tokens; the
    // Chat SDK may strip the brackets, so we also catch the bare `@Uxxx` form.
    const botMetadata = this.manager.getInstance(this.connection.id)?.connection
      .metadata;
    const botUsername = botMetadata?.botUsername as string | undefined;
    const botUserId = botMetadata?.botUserId as string | undefined;
    if (botUsername) {
      messageText = messageText.replace(`@${botUsername}`, "").trim();
    }
    if (botUserId) {
      messageText = messageText
        .replace(new RegExp(`<@${botUserId}>`, "g"), "")
        .replace(new RegExp(`@${botUserId}\\b`, "g"), "")
        .replace(/\s+/g, " ")
        .trim();
    }

    // Intercept /new and /clear before slash dispatch
    let sessionReset = false;
    const trimmedLower = messageText.trim().toLowerCase();
    if (trimmedLower === "/new") {
      messageText = "Starting new session.";
      sessionReset = true;
    } else if (trimmedLower === "/clear") {
      await this.conversationState()?.clearHistory(
        this.connection.id,
        channelId
      );
      await thread.post({ text: "Chat history cleared." });
      return;
    }

    // Slash command dispatch — intercept before queueing to worker
    if (!sessionReset && this.commandDispatcher) {
      const handled = await this.commandDispatcher.tryHandleSlashText(
        messageText,
        {
          platform,
          userId,
          channelId,
          isGroup,
          conversationId,
          connectionId: this.connection.id,
          reply: createChatReply((content) => thread.post(content)),
        }
      );
      if (handled) return;
    }

    // Gap 1: Retrieve + append conversation history via the SDK state adapter.
    const conversationState = this.conversationState();

    // Backfill: when the bot is first activated in a thread (mention or
    // first subscribed event), ask the Chat SDK adapter for the thread's
    // prior messages. Slack maps this to `conversations.replies` (Tier 3,
    // generous limit). Without this, a mid-thread mention has no context
    // for the messages that preceded it. `claimThreadBackfill` is an
    // atomic per-thread one-shot guard — runs at most once per thread per
    // HISTORY_TTL_MS window, regardless of how many events race in.
    if (
      conversationState &&
      isGroup &&
      (await conversationState.claimThreadBackfill(
        this.connection.id,
        thread.id
      ))
    ) {
      let backfillSucceeded = false;
      try {
        const adapter = (thread as any).adapter;
        if (adapter?.fetchMessages) {
          const result = await adapter.fetchMessages(thread.id, {
            limit: 50,
            direction: "forward",
          });
          for (const prior of result.messages ?? []) {
            if (prior.id === messageId) continue;
            const text = (prior.text ?? "").trim();
            if (!text) continue;
            const sentAt =
              prior.metadata?.dateSent instanceof Date
                ? prior.metadata.dateSent.getTime()
                : Date.now();
            await conversationState.appendHistory(
              this.connection.id,
              channelId,
              {
                role: prior.author?.isMe ? "assistant" : "user",
                content: text,
                authorName: prior.author?.fullName,
                timestamp: sentAt,
              }
            );
          }
          backfillSucceeded = true;
        } else {
          // Adapter doesn't expose fetchMessages — nothing to retry, treat
          // as "successful" so we don't hammer it on every event.
          backfillSucceeded = true;
        }
      } catch (error) {
        logger.warn(
          { connectionId: this.connection.id, channelId, error: String(error) },
          "Thread backfill failed; will retry on next event"
        );
      }
      if (!backfillSucceeded) {
        await conversationState.releaseThreadBackfill(
          this.connection.id,
          thread.id
        );
      }
    }

    const conversationHistory =
      (await conversationState?.getHistory(this.connection.id, channelId)) ??
      [];

    await conversationState?.appendHistory(this.connection.id, channelId, {
      role: "user",
      content: messageText,
      authorName: message.author?.fullName,
      timestamp: Date.now(),
    });

    // Build payload and enqueue
    const traceId = generateTraceId(messageId);
    const agentSettingsStore = this.services.getAgentSettingsStore();

    // Create root span for distributed tracing
    const { span: rootSpan, traceparent } = createRootSpan("message_received", {
      "lobu.agent_id": agentId,
      "lobu.message_id": messageId,
      "lobu.platform": platform,
      "lobu.connection_id": this.connection.id,
    });

    try {
      const agentOptions = await resolveAgentOptions(
        agentId,
        {},
        agentSettingsStore
      );

      const payload = buildMessagePayload({
        platform,
        userId,
        botId: platform,
        conversationId,
        teamId: isGroup ? channelId : platform,
        agentId,
        messageId,
        messageText,
        channelId,
        platformMetadata: {
          traceId,
          traceparent: traceparent || undefined,
          agentId,
          chatId: channelId,
          senderId: userId,
          senderUsername: message.author?.userName,
          senderDisplayName: message.author?.fullName,
          // Platform-native team/workspace id (Slack: team_id). Used by the
          // Chat SDK as a fallback hint for ephemeral/DM routing. Undefined
          // for platforms that don't carry a workspace concept (Telegram, etc.)
          teamId,
          isGroup,
          connectionId: this.connection.id,
          responseChannel: channelId,
          responseId: messageId,
          responseThreadId: thread.id,
          conversationHistory:
            conversationHistory.length > 0 ? conversationHistory : undefined,
          ...(ingestedFiles.length > 0 && { files: ingestedFiles }),
          ...(sessionReset && { sessionReset: true }),
        },
        agentOptions,
      });

      const queueProducer = this.services.getQueueProducer();
      await queueProducer.enqueueMessage(payload);

      logger.info(
        {
          traceId,
          traceparent,
          messageId,
          agentId,
          connectionId: this.connection.id,
        },
        "Message enqueued via Chat SDK bridge"
      );

      // Show typing indicator
      try {
        await thread.startTyping?.("Processing...");
      } catch {
        // best effort
      }
    } finally {
      rootSpan?.end();
      void flushTracing();
    }
  }

  /**
   * Feed a button-click into the same enqueue pipeline as a typed inbound
   * message. Chat SDK filters bot self-posts via `isMe`, so posting the
   * clicked value back into the thread does NOT trigger `handleMessage` —
   * this method is what makes a question-click actually become a new
   * worker turn.
   *
   * The caller supplies the original PostedQuestion context (userId,
   * channelId, conversationId, teamId, agentId) so routing stays identical
   * to the original session. The clicked `value` becomes the new
   * `messageText`.
   */
  async ingestClick(params: {
    userId: string;
    channelId: string;
    conversationId: string;
    teamId?: string;
    authorName?: string;
    authorUsername?: string;
    value: string;
    thread: any;
    responseThreadId?: string;
  }): Promise<void> {
    const { connection } = this;

    if (!this.manager.has(connection.id)) {
      logger.info(
        { connectionId: connection.id },
        "Connection no longer active, dropping click ingest"
      );
      return;
    }

    const platform = connection.platform;
    const {
      userId,
      channelId,
      conversationId,
      teamId,
      authorName,
      authorUsername,
      value,
      thread,
      responseThreadId,
    } = params;

    if (!isSenderAllowed(connection.settings?.allowFrom, userId)) {
      logger.info({ userId }, "Click blocked by allowlist");
      return;
    }

    const messageId = `click-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isGroup = conversationId !== channelId;

    const channelBindingService = this.services.getChannelBindingService();
    const resolved = await resolveAgentId({
      platform,
      userId,
      channelId,
      isGroup,
      teamId,
      templateAgentId: this.connection.templateAgentId,
      channelBindingService,
    });
    const agentId = resolved.agentId;

    const conversationState = this.conversationState();
    const conversationHistory =
      (await conversationState?.getHistory(this.connection.id, channelId)) ??
      [];

    await conversationState?.appendHistory(this.connection.id, channelId, {
      role: "user",
      content: value,
      authorName,
      timestamp: Date.now(),
    });

    const traceId = generateTraceId(messageId);
    const agentSettingsStore = this.services.getAgentSettingsStore();

    const { span: rootSpan, traceparent } = createRootSpan(
      "question_click_received",
      {
        "lobu.agent_id": agentId,
        "lobu.message_id": messageId,
        "lobu.platform": platform,
        "lobu.connection_id": this.connection.id,
      }
    );

    try {
      const agentOptions = await resolveAgentOptions(
        agentId,
        {},
        agentSettingsStore
      );

      const payload = buildMessagePayload({
        platform,
        userId,
        botId: platform,
        conversationId,
        teamId: teamId || platform,
        agentId,
        messageId,
        messageText: value,
        channelId,
        platformMetadata: {
          traceId,
          traceparent: traceparent || undefined,
          agentId,
          chatId: channelId,
          senderId: userId,
          senderUsername: authorUsername,
          senderDisplayName: authorName,
          teamId,
          isGroup,
          connectionId: this.connection.id,
          responseChannel: channelId,
          responseId: messageId,
          responseThreadId: responseThreadId ?? thread.id,
          conversationHistory:
            conversationHistory.length > 0 ? conversationHistory : undefined,
        },
        agentOptions,
      });

      const queueProducer = this.services.getQueueProducer();
      await queueProducer.enqueueMessage(payload);

      logger.info(
        {
          traceId,
          messageId,
          agentId,
          connectionId: this.connection.id,
          value,
        },
        "Question click enqueued via Chat SDK bridge"
      );

      try {
        await thread.startTyping?.("Processing...");
      } catch {
        // best effort
      }
    } finally {
      rootSpan?.end();
      void flushTracing();
    }
  }
}
