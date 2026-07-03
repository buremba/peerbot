/**
 * Message handler bridge — connects Chat SDK events to the message queue.
 * Bridges all 9 feature gaps: history, agent auto-creation, provider setup,
 * settings links, allowlist, audio transcription, etc.
 */

import { createLogger, createRootSpan, generateTraceId } from "@lobu/core";
import {
  previewUnlinkedNotice,
  workspaceUnlinkedNotice,
} from "../../preview/slack.js";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import { createChatReply } from "../commands/command-reply-adapters.js";
import type { ArtifactStore } from "../files/artifact-store.js";
import type { CoreServices } from "../platform.js";
import {
  buildMessagePayload,
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers.js";
import { resolveSlackBotIdentity } from "../../authz/slack-acl-sync.js";
import { stripPlatformPrefix } from "../channels/bound-channels.js";
import { captureChannelMessage } from "./channel-transcript.js";
import { createSlackWebApi } from "./slack-web.js";
import type { ConversationStateStore } from "./conversation-state-store.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import type { PlatformConnection } from "./types.js";

const logger = createLogger("chat-message-bridge");

/**
 * Inbound file shape passed to the worker on platformMetadata.files.
 * `downloadUrl` is a signed, time-limited public artifact URL the worker
 * can fetch over the proxy without any platform-specific auth.
 */
export interface IngestedFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  downloadUrl: string;
}

/**
 * Markdown-safe display label for a transcript file reference. The artifact
 * route's `Content-Disposition` still carries the real filename on download —
 * this only needs to be a label that can't break the `[name](url)` link
 * grammar, so the web's strip/lift regex stays reliable for *any* uploaded
 * filename (e.g. one containing `]`, `)`, or newlines).
 */
function sanitizeRefLabel(name: string): string {
  return name.replace(/[[\]()\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "file";
}

/**
 * Append a tokenless artifact-route reference (`[name](/api/v1/files/:id)`) for
 * each non-image attachment to the user's message text, so non-image uploads
 * survive in the (text+image-only) pi-ai transcript and the web can lift them
 * back into attachment chips on reload. Images are skipped — they persist as
 * inline transcript blocks, so a ref would render a duplicate chip. The history
 * read path re-signs these tokenless refs with a fresh download token, so the
 * persisted transcript never embeds an expiring credential.
 *
 * Pure + exported for unit testing.
 */
export function buildAttachmentTranscriptText(
  messageContent: string,
  ingestedFiles: IngestedFile[]
): string {
  const refs = ingestedFiles
    .filter((f) => !f.mimetype?.startsWith("image/"))
    .map((f) => `[${sanitizeRefLabel(f.name)}](/api/v1/files/${f.id})`);
  if (refs.length === 0) return messageContent;
  return [messageContent, refs.join("\n")]
    .filter((part) => part.length > 0)
    .join("\n\n");
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
 * Detect a preview-link redemption in plain message text. Slack blocks slash
 * commands in an "Agents & AI Apps" DM, so `lobu run`'s `/lobu link <code>`
 * can't be sent as a slash command there — Slack either rejects it ("not
 * supported in threads") or, for a bot that registers `/lobu`, never delivers
 * it as a message. So accept the code as plain text: `link <code>`, the
 * `/lobu link <code>` / `/link <code>` forms when they do arrive as text, and a
 * bare `<slug>-<CODE>` paste. Codes always contain a hyphen (`slug-SUFFIX`), so
 * we require one to avoid matching chatter like "link me". The bare form is
 * gated to DMs to avoid matching stray channel messages. Returns the code, or
 * null. The native channel slash command and `tryHandleSlashText` still handle
 * the `/`-prefixed forms.
 */
export function parsePreviewLinkCode(
  text: string,
  isGroup: boolean
): string | null {
  const t = text.trim();
  const explicit = t.match(/^(?:\/?lobu\s+)?\/?link\s+(\S+)$/i);
  if (explicit?.[1] && explicit[1].includes("-")) return explicit[1];
  if (!isGroup && /^[a-z][a-z0-9-]*-[A-Z0-9]{6}$/.test(t)) return t;
  return null;
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

    // Resolve agent ID: channel binding wins, otherwise the connection's
    // owning agent. No more shadow agent creation — if neither matches we
    // drop the message.
    const channelBindingService = this.services.getChannelBindingService();
    const rawTeamId =
      (message.raw as Record<string, unknown> | undefined)?.team_id ??
      (message.raw as Record<string, unknown> | undefined)?.team;
    const teamId = typeof rawTeamId === "string" ? rawTeamId : undefined;

    // Preview connections fan out to agents in OTHER orgs (a `/lobu link <code>`
    // binds under the claim's org, not this connection's), so resolve the
    // binding org-agnostically and route by the binding's own org.
    const isPreview = this.connection.settings?.previewMode === true;
    const resolved = await resolveAgentId({
      platform,
      channelId,
      teamId,
      agentId: this.connection.agentId,
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      channelBindingService,
      crossOrg: isPreview,
    });
    if (!resolved) {
      // A tenant's OAuth-installed Slack workspace bot has no owning agent —
      // routing is via `/lobu link` bindings. Before the tenant links a
      // channel, a non-command message resolves to nothing. Reply with a
      // one-line "link your agent" notice instead of silently dropping so the
      // install never dead-ends. (Slash commands like `/lobu link` take the
      // `onSlashCommand` path and never reach here.)
      if (
        !isPreview &&
        platform === "slack" &&
        this.connection.metadata?.teamId &&
        this.connection.organizationId
      ) {
        const linkTeamId = teamId ?? this.connection.metadata?.teamId;
        // Best-effort: resolve the channel's friendly name (#general) for the
        // notice's deep-link label. Uses this connection's own bot token via
        // conversations.info; any failure (no token, not-in-channel, rate limit)
        // just drops to the channel id in the UI — never blocks the notice.
        let channelName: string | undefined;
        if (linkTeamId) {
          try {
            const slackWeb = createSlackWebApi();
            const identity = await resolveSlackBotIdentity(
              {
                installStore: this.services.getAppInstallationStore(),
                secretStore: this.services.getSecretStore(),
                slackWeb,
              },
              {
                organizationId: this.connection.organizationId,
                teamId: linkTeamId,
                connectionId: this.connection.id,
              },
            );
            if (identity?.token) {
              const info = await slackWeb.conversationInfo(
                identity.token,
                stripPlatformPrefix(platform, channelId),
              );
              channelName = info.name ?? undefined;
            }
          } catch (err) {
            logger.debug(
              { channelId, error: String(err) },
              "unlinked-notice: channel name lookup failed (using id)"
            );
          }
        }
        const notice = await workspaceUnlinkedNotice(
          platform,
          this.connection.organizationId,
          // Fall back to the connection's stored team when the raw message omits
          // team_id, so the deep-link stays team-scoped (the binding is keyed on
          // team). The connection always carries it — it's the gate above.
          { channelId, teamId: linkTeamId, channelName },
        );
        if (notice) {
          logger.info(
            { platform, channelId, teamId, connectionId: this.connection.id },
            "Slack workspace connection: unlinked channel — replying with link notice"
          );
          await thread.post(notice);
          return;
        }
      }
      logger.warn(
        { platform, channelId, teamId, connectionId: this.connection.id },
        "No channel binding and connection has no owning agent — dropping message"
      );
      return;
    }

    const agentId = resolved.agentId;
    const routingOrgId =
      resolved.organizationId ?? this.connection.organizationId;

    // Durable transcript capture: persist this inbound message so
    // read_conversation can serve channel history from Postgres instead of the
    // throttled platform history API. Fire-and-forget + idempotent. thread_id is
    // the thread the message lives in (null at channel level).
    if (routingOrgId) {
      captureChannelMessage({
        organizationId: routingOrgId,
        connectionId: connection.id,
        platform,
        channelId,
        threadId: conversationId !== channelId ? conversationId : null,
        platformMessageId: messageId,
        authorId: userId,
        authorName: message.author?.fullName ?? message.author?.userName,
        teamId: teamId ?? null,
        isBot: message.author?.isMe === true,
        text: typeof message.text === "string" ? message.text : "",
        occurredAt:
          message.metadata?.dateSent instanceof Date
            ? message.metadata.dateSent
            : new Date(),
      });
    }

    // Whole-channel capture mode: a subscribed (non-mention) channel message is
    // now recorded above, but should NOT trigger an agent turn — the bot mirrors
    // the channel without responding to everything. Mentions/DMs still respond.
    if (
      source === "subscribed" &&
      message.isMention !== true &&
      connection.settings?.recordChannelMessages === true
    ) {
      return;
    }

    // Track first-time-seen user → agent association for visibility in the
    // admin API. Idempotent — agent_users has a (agent_id, platform, user_id)
    // unique constraint.
    const userAgentsStore = this.services.getUserAgentsStore();
    if (userAgentsStore && routingOrgId) {
      try {
        await userAgentsStore.addAgent(platform, userId, agentId, routingOrgId);
      } catch (error) {
        logger.warn(
          { agentId, userId, error: String(error) },
          "Failed to record agent_users association"
        );
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
        channelId,
        conversationId
      );
      await thread.post({ text: "Chat history cleared." });
      return;
    }

    // Preview-link redemption as plain message text — preview connections only.
    // In an AI-app DM Slack won't deliver `/lobu link <code>` as a slash command,
    // so a hosted preview bot accepts the code as a message — `link <code>` or a
    // bare `<slug>-<CODE>` paste — and redeems via the same `link` command. Gated
    // to previewMode so a normal agent bot's DMs (where a code-looking message is
    // just chat for the agent) are never swallowed. Runs before the worker
    // enqueue and the previewMode menu so a pasted code binds.
    if (
      !sessionReset &&
      this.commandDispatcher &&
      this.connection.settings?.previewMode === true
    ) {
      const linkCode = parsePreviewLinkCode(messageText, isGroup);
      if (linkCode) {
        const handled = await this.commandDispatcher.tryHandle(
          "link",
          linkCode,
          {
            platform,
            userId,
            channelId,
            teamId,
            isGroup,
            conversationId,
            connectionId: this.connection.id,
            organizationId: this.connection.organizationId,
            reply: createChatReply((content) => thread.post(content)),
          }
        );
        if (handled) return;
      }
    }

    // Slash command dispatch — intercept before queueing to worker
    if (!sessionReset && this.commandDispatcher) {
      const handled = await this.commandDispatcher.tryHandleSlashText(
        messageText,
        {
          platform,
          userId,
          channelId,
          teamId,
          isGroup,
          conversationId,
          connectionId: this.connection.id,
          organizationId: this.connection.organizationId,
          reply: createChatReply((content) => thread.post(content)),
        }
      );
      if (handled) return;
    }

    // Preview connection (a hosted Lobu workspace bot — Slack, Telegram, …):
    // an unlinked DM/@-mention that ISN'T a command. Don't run the connection's
    // placeholder owning agent — reply with the "pick a demo agent" menu (or the
    // "wire your own agent" instructions) and stop. This MUST come after the
    // slash dispatch above: `/lobu link <code>` / `/lobu try <id>` arrive as
    // slash commands in channels, but as plain message text in an "Agents & AI
    // Apps" DM — they have to bind/pick via the dispatcher before we'd otherwise
    // preempt them with this menu.
    if (
      resolved.source === "connection" &&
      this.connection.settings?.previewMode === true
    ) {
      const notice = await previewUnlinkedNotice(platform, this.connection.id);
      if (notice) {
        logger.info(
          { platform, channelId, teamId, connectionId: this.connection.id },
          "Preview connection: unlinked chat — replying with demo-agent menu"
        );
        await thread.post(notice);
        return;
      }
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
              conversationId,
              {
                role: prior.author?.isMe ? "assistant" : "user",
                content: text,
                authorName: prior.author?.fullName,
                timestamp: sentAt,
              }
            );
            // Seed the durable transcript from the thread's prior messages too.
            if (routingOrgId && prior.id) {
              captureChannelMessage({
                organizationId: routingOrgId,
                connectionId: this.connection.id,
                platform,
                channelId,
                threadId: conversationId !== channelId ? conversationId : null,
                platformMessageId: prior.id,
                authorId: prior.author?.userId,
                authorName: prior.author?.fullName,
                teamId: teamId ?? null,
                isBot: prior.author?.isMe === true,
                text,
                occurredAt: new Date(sentAt),
              });
            }
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

    await this.enqueueUserTurn({
      agentId,
      organizationId: routingOrgId,
      userId,
      channelId,
      conversationId,
      messageId,
      messageText,
      isGroup,
      thread,
      teamId,
      payloadTeamId: isGroup ? channelId : platform,
      senderUsername: message.author?.userName,
      senderDisplayName: message.author?.fullName,
      responseThreadId: thread.id,
      extraMetadata: {
        ...(ingestedFiles.length > 0 && { files: ingestedFiles }),
        ...(sessionReset && { sessionReset: true }),
      },
      spanName: "message_received",
      logMessage: "Message enqueued via Chat SDK bridge",
    });
  }

  /**
   * Shared enqueue tail for inbound turns. Owns the history append, payload
   * build, queue enqueue, and typing indicator that `handleMessage` and
   * `ingestClick` both perform identically; each caller supplies its
   * inbound-specific fields (message text, sender hints, span name, …).
   *
   * `senderDisplayName` doubles as the history `authorName` — both callers
   * pass the same value for the two.
   */
  private async enqueueUserTurn(args: {
    agentId: string;
    /** Org the turn runs under. For preview connections this is the bound
     * agent's org (cross-org), not necessarily the connection's org. */
    organizationId: string | undefined;
    userId: string;
    channelId: string;
    conversationId: string;
    messageId: string;
    messageText: string;
    isGroup: boolean;
    thread: any;
    /**
     * Platform-native team/workspace id (Slack: team_id) carried on
     * platformMetadata as a Chat-SDK ephemeral/DM routing hint. Undefined for
     * platforms with no workspace concept (Telegram, etc.).
     */
    teamId: string | undefined;
    /** The `teamId` field passed to `buildMessagePayload` (routing key). */
    payloadTeamId: string;
    senderUsername?: string;
    senderDisplayName?: string;
    responseThreadId?: string;
    extraMetadata?: Record<string, unknown>;
    spanName: string;
    logMessage: string;
    logExtra?: Record<string, unknown>;
  }): Promise<void> {
    const {
      agentId,
      organizationId,
      userId,
      channelId,
      conversationId,
      messageId,
      messageText,
      isGroup,
      thread,
      teamId,
      payloadTeamId,
      senderUsername,
      senderDisplayName,
      responseThreadId,
      extraMetadata,
      spanName,
      logMessage,
      logExtra,
    } = args;
    const platform = this.connection.platform;

    const conversationState = this.conversationState();
    const conversationHistory =
      (await conversationState?.getHistory(
        this.connection.id,
        channelId,
        conversationId
      )) ?? [];

    await conversationState?.appendHistory(
      this.connection.id,
      channelId,
      conversationId,
      {
        role: "user",
        content: messageText,
        authorName: senderDisplayName,
        timestamp: Date.now(),
      }
    );

    // Build payload and enqueue
    const traceId = generateTraceId(messageId);
    const agentSettingsStore = this.services.getAgentSettingsStore();

    // Create root span for distributed tracing
    const { span: rootSpan, traceparent } = createRootSpan(spanName, {
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
        teamId: payloadTeamId,
        agentId,
        organizationId,
        messageId,
        messageText,
        channelId,
        platformMetadata: {
          traceId,
          traceparent: traceparent || undefined,
          agentId,
          chatId: channelId,
          senderId: userId,
          senderUsername,
          senderDisplayName,
          teamId,
          isGroup,
          connectionId: this.connection.id,
          responseChannel: channelId,
          responseId: messageId,
          responseThreadId,
          conversationHistory:
            conversationHistory.length > 0 ? conversationHistory : undefined,
          ...extraMetadata,
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
          ...logExtra,
        },
        logMessage
      );

      // Show typing indicator
      try {
        await thread.startTyping?.("Processing...");
      } catch {
        // best effort
      }
    } finally {
      rootSpan?.end();
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
    const isPreview = this.connection.settings?.previewMode === true;
    const resolved = await resolveAgentId({
      platform,
      channelId,
      teamId,
      agentId: this.connection.agentId,
      organizationId: this.connection.organizationId,
      connectionId: this.connection.id,
      channelBindingService,
      crossOrg: isPreview,
    });
    if (!resolved) {
      logger.warn(
        { platform, channelId, teamId, connectionId: this.connection.id },
        "No channel binding and connection has no owning agent — dropping interaction"
      );
      return;
    }
    const agentId = resolved.agentId;
    const routingOrgId =
      resolved.organizationId ?? this.connection.organizationId;

    await this.enqueueUserTurn({
      agentId,
      organizationId: routingOrgId,
      userId,
      channelId,
      conversationId,
      messageId,
      messageText: value,
      isGroup,
      thread,
      teamId,
      payloadTeamId: teamId || platform,
      senderUsername: authorUsername,
      senderDisplayName: authorName,
      responseThreadId: responseThreadId ?? thread.id,
      spanName: "question_click_received",
      logMessage: "Question click enqueued via Chat SDK bridge",
      logExtra: { value },
    });
  }
}
