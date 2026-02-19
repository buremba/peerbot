/**
 * WhatsApp message handler.
 * Processes inbound messages and enqueues them for worker processing.
 * Adapted from clawdbot/src/web/inbound.ts
 */

import {
  type AgentOptions as CoreAgentOptions,
  createLogger,
  generateTraceId,
} from "@lobu/core";
import {
  type BaileysEventMap,
  extractMessageContent,
  normalizeMessageContent,
  type proto,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store";
import {
  type AgentSettingsStore,
  buildSettingsUrl,
  generateSettingsToken,
} from "../../auth/settings";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ChannelBindingService } from "../../channels";
import type {
  MessagePayload,
  QueueProducer,
} from "../../infrastructure/queue/queue-producer";
import { generateAgentSelectorToken } from "../../routes/public/agent-selector-page";
import type { TranscriptionService } from "../../services/transcription-service";
import type { ISessionManager } from "../../session";
import { resolveSpace } from "../../spaces";
import type { WhatsAppAuthAdapter } from "../auth-adapter";
import type { WhatsAppConfig } from "../config";
import type { BaileysClient } from "../connection/baileys-client";
import type {
  ExtractedMedia,
  MediaExtractionError,
  WhatsAppFileHandler,
} from "../file-handler";
import {
  isGroupJid,
  jidToE164,
  normalizeE164,
  type WhatsAppContext,
} from "../types";

const logger = createLogger("whatsapp-message-handler");

type AgentOptions = CoreAgentOptions;

interface StoredMessage {
  id: string;
  text: string;
  fromMe: boolean;
  senderName?: string;
  timestamp: number;
}

interface ConversationHistory {
  messages: StoredMessage[];
  lastUpdated: number;
}

/**
 * WhatsApp message handler.
 */
export class WhatsAppMessageHandler {
  private seen = new Set<string>();
  private groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  private conversationHistory = new Map<string, ConversationHistory>();
  private readonly GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private isRunning = false;
  private authAdapter?: WhatsAppAuthAdapter;
  private fileHandler?: WhatsAppFileHandler;
  private channelBindingService?: ChannelBindingService;
  private agentSettingsStore?: AgentSettingsStore;
  private transcriptionService?: TranscriptionService;
  private userAgentsStore?: UserAgentsStore;
  private agentMetadataStore?: AgentMetadataStore;

  constructor(
    private client: BaileysClient,
    private config: WhatsAppConfig,
    private queueProducer: QueueProducer,
    _sessionManager: ISessionManager, // Reserved for future use
    private agentOptions: AgentOptions
  ) {}

  /**
   * Set the channel binding service (optional)
   */
  setChannelBindingService(service: ChannelBindingService): void {
    this.channelBindingService = service;
  }

  /**
   * Set the agent settings store (optional)
   */
  setAgentSettingsStore(store: AgentSettingsStore): void {
    this.agentSettingsStore = store;
  }

  /**
   * Set the transcription service (optional)
   */
  setTranscriptionService(service: TranscriptionService): void {
    this.transcriptionService = service;
  }

  setUserAgentsStore(store: UserAgentsStore): void {
    this.userAgentsStore = store;
  }

  setAgentMetadataStore(store: AgentMetadataStore): void {
    this.agentMetadataStore = store;
  }

  /**
   * Send a configuration prompt for WhatsApp.
   * WhatsApp always uses first-user fallback for groups (limited admin API).
   */
  private async sendWhatsAppConfigPrompt(
    context: WhatsAppContext
  ): Promise<boolean> {
    if (!this.userAgentsStore || !this.agentMetadataStore) {
      return false;
    }

    try {
      const publicGatewayUrl =
        process.env.PUBLIC_GATEWAY_URL || "http://localhost:8080";
      const userId = context.senderE164 || context.senderJid;

      const token = generateAgentSelectorToken(
        userId,
        "whatsapp",
        context.chatJid
      );
      const configUrl = `${publicGatewayUrl}/agent-selector?token=${encodeURIComponent(token)}`;

      await this.client.sendMessage(context.chatJid, {
        text: `Welcome! To get started, please configure which agent should handle messages here.\n\nConfigure: ${configUrl}`,
      });

      logger.info(
        `Sent WhatsApp configuration prompt to ${userId} in ${context.chatJid}`
      );
      return true;
    } catch (error) {
      logger.error("Failed to send WhatsApp config prompt", { error });
      return false;
    }
  }

  /**
   * Get agent options with settings applied
   * Priority: agent settings > config defaults
   */
  private async getAgentOptionsWithSettings(
    agentId: string
  ): Promise<Record<string, any>> {
    const baseOptions = { ...this.agentOptions };

    if (!this.agentSettingsStore) {
      return baseOptions;
    }

    const settings = await this.agentSettingsStore.getSettings(agentId);
    if (!settings) {
      return baseOptions;
    }

    logger.info({ agentId, model: settings.model }, "Applying agent settings");

    // Merge settings into options
    const mergedOptions: Record<string, any> = { ...baseOptions };

    if (settings.model) {
      mergedOptions.model = settings.model;
    }

    // Pass additional settings through agentOptions for worker to use
    if (settings.networkConfig) {
      mergedOptions.networkConfig = settings.networkConfig;
    }

    if (settings.gitConfig) {
      mergedOptions.gitConfig = settings.gitConfig;
    }
    if (settings.nixConfig) {
      mergedOptions.nixConfig = settings.nixConfig;
    }

    if (settings.envVars) {
      mergedOptions.envVars = settings.envVars;
    }

    if (settings.toolsConfig) {
      mergedOptions.toolsConfig = settings.toolsConfig;
    }

    // MCP servers from agent settings
    if (settings.mcpServers) {
      mergedOptions.mcpServers = settings.mcpServers;
    }

    // Plugin configuration
    if (settings.pluginsConfig) {
      mergedOptions.pluginsConfig = settings.pluginsConfig;
    }

    // Verbose logging
    if (settings.verboseLogging !== undefined) {
      mergedOptions.verboseLogging = settings.verboseLogging;
    }

    return mergedOptions;
  }

  /**
   * Set the file handler for extracting media.
   */
  setFileHandler(handler: WhatsAppFileHandler): void {
    this.fileHandler = handler;
  }

  /**
   * Set the auth adapter for handling auth responses.
   */
  setAuthAdapter(adapter: WhatsAppAuthAdapter): void {
    this.authAdapter = adapter;
  }

  /**
   * Start listening for messages.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info(
      `WhatsApp message handler config: selfChatEnabled=${this.config.selfChatEnabled}, allowFrom=${JSON.stringify(this.config.allowFrom)}, requireMention=${this.config.requireMention}`
    );

    this.client.on("message", (upsert) => {
      logger.info("Message handler received event from client");
      this.handleMessagesUpsert(upsert).catch((err) => {
        logger.error({ error: String(err) }, "Error handling message upsert");
      });
    });

    // Handle reactions (for potential future use, e.g., thumbs up = approve)
    this.client.on("reaction", (reactions) => {
      this.handleReactions(
        reactions as BaileysEventMap["messages.reaction"]
      ).catch((err) => {
        logger.error({ error: String(err) }, "Error handling reactions");
      });
    });

    // Handle message updates (edits, deletes)
    this.client.on("messageUpdate", (updates) => {
      this.handleMessageUpdates(
        updates as BaileysEventMap["messages.update"]
      ).catch((err) => {
        logger.error({ error: String(err) }, "Error handling message updates");
      });
    });

    // Periodically cleanup expired histories
    setInterval(() => this.cleanupExpiredHistories(), 60 * 60 * 1000); // Every hour

    logger.info("WhatsApp message handler started");
  }

  /**
   * Stop listening for messages.
   */
  stop(): void {
    this.isRunning = false;
    logger.info("WhatsApp message handler stopped");
  }

  /**
   * Handle message upsert events from Baileys.
   */
  private async handleMessagesUpsert(
    upsert: BaileysEventMap["messages.upsert"]
  ): Promise<void> {
    logger.info(
      { type: upsert.type, messageCount: upsert.messages?.length },
      "handleMessagesUpsert called"
    );

    if (upsert.type !== "notify" && upsert.type !== "append") {
      logger.debug({ type: upsert.type }, "Skipping non-notify/append upsert");
      return;
    }

    for (const msg of upsert.messages ?? []) {
      await this.processMessage(msg, upsert.type);
    }
  }

  /**
   * Process a single message.
   */
  private async processMessage(
    msg: WAMessage,
    upsertType: string
  ): Promise<void> {
    const id = msg.key?.id;
    // DEBUG: Log raw message structure for troubleshooting
    const msgKeys = msg.message ? Object.keys(msg.message) : [];
    logger.info(
      `Raw message: id=${id}, fromMe=${msg.key?.fromMe}, remoteJid=${msg.key?.remoteJid}, msgKeys=[${msgKeys.join(",")}]`
    );

    if (!id) {
      logger.info("Skipping message: no ID");
      return;
    }

    // Dedupe on message ID (Baileys can emit retries)
    // Note: we check seen here but only add to seen AFTER stub/content checks pass
    // This handles the case where Baileys first emits a stub, then the real message
    if (this.seen.has(id)) {
      logger.info({ id }, "Skipping duplicate message");
      return;
    }

    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      logger.info({ id }, "Skipping message: no remoteJid");
      return;
    }

    // Ignore status/broadcast traffic
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      logger.info({ id, remoteJid }, "Skipping status/broadcast message");
      return;
    }

    // For @lid (linked device ID) JIDs, prefer remoteJidAlt for response routing
    // @lid JIDs are internal WhatsApp IDs that may not route correctly for sending
    const remoteJidAlt = (msg.key as { remoteJidAlt?: string })?.remoteJidAlt;
    const responseJid =
      remoteJid.endsWith("@lid") && remoteJidAlt ? remoteJidAlt : remoteJid;

    if (remoteJidAlt) {
      logger.info(
        `Message from @lid JID, using remoteJidAlt for responses: ${remoteJid} -> ${responseJid}`
      );
    }

    const isGroup = isGroupJid(responseJid);
    const participantJid = msg.key?.participant;

    // Get sender info - use responseJid for non-groups to handle @lid -> @s.whatsapp.net resolution
    const senderJid = isGroup ? participantJid : responseJid;
    const senderE164 = senderJid ? jidToE164(senderJid) : null;

    // Get self info
    const selfJid = this.client.getSelfJid();
    const selfE164 = this.client.getSelfE164();

    // Check if this is from ourselves
    const isFromMe = msg.key?.fromMe === true;
    const isSelfChat = senderE164 === selfE164;

    logger.info(
      `Processing message: id=${id}, remoteJid=${remoteJid}, isFromMe=${isFromMe}, isSelfChat=${isSelfChat}, senderE164=${senderE164}, selfE164=${selfE164}, selfChatEnabled=${this.config.selfChatEnabled}, messageStubType=${msg.messageStubType}, hasMessage=${!!msg.message}`
    );

    // Skip stub messages (system notifications, failed decryption, etc.)
    // messageStubType 2 = CIPHERTEXT (failed to decrypt)
    if (msg.messageStubType) {
      logger.info(`Skipping stub message: type=${msg.messageStubType}`);
      return;
    }

    // Skip messages with no content (decryption failed)
    if (!msg.message) {
      logger.warn(`Message ${id} has no content - possible decryption failure`);
      return;
    }

    // Mark as seen now that we know it's a real message (not stub, has content)
    this.seen.add(id);

    // Get raw message keys for logging
    const rawMessageKeys = Object.keys(msg.message);
    logger.info(`Message ${id} raw keys: ${rawMessageKeys.join(", ")}`);

    // Normalize message content to unwrap nested types (viewOnce, ephemeral, etc.)
    const normalizedContent = normalizeMessageContent(msg.message);
    const normalizedKeys = normalizedContent
      ? Object.keys(normalizedContent)
      : [];
    if (
      normalizedKeys.length > 0 &&
      normalizedKeys.join(",") !== rawMessageKeys.join(",")
    ) {
      logger.info(
        `Message ${id} normalized keys: ${normalizedKeys.join(", ")}`
      );
    }

    // Check if message is protocol-only (no user content)
    // Use BOTH raw and normalized keys to detect user content
    const userContentTypes = [
      "conversation",
      "extendedTextMessage",
      "audioMessage",
      "imageMessage",
      "videoMessage",
      "documentMessage",
      "stickerMessage",
    ];
    const hasUserContentRaw = userContentTypes.some((type) =>
      rawMessageKeys.includes(type)
    );
    const hasUserContentNormalized = userContentTypes.some((type) =>
      normalizedKeys.includes(type)
    );
    const hasUserContent = hasUserContentRaw || hasUserContentNormalized;

    // Skip pure protocol messages (no user content in raw or normalized)
    if (
      rawMessageKeys.length === 1 &&
      rawMessageKeys[0] === "protocolMessage"
    ) {
      logger.info(`Skipping protocol message ${id}`);
      return;
    }
    if (rawMessageKeys.includes("protocolMessage") && !hasUserContent) {
      logger.info(
        `Skipping protocol-only message ${id} (no user content after normalization)`
      );
      return;
    }

    // IMPORTANT: Baileys delivers our own outbound messages back via messages.upsert.
    // We must never process those as new inbound user messages, otherwise the bot can
    // respond to itself in a tight loop (and spam).
    //
    // Self-chat is the only exception: allow fromMe messages only when the chat is
    // actually with ourselves.
    if (isFromMe) {
      if (!this.config.selfChatEnabled) {
        logger.info("Skipping own message - selfChat not enabled");
        return;
      }

      if (!isSelfChat) {
        logger.info(
          { id, remoteJid, responseJid },
          "Skipping outbound echo message (not self-chat)"
        );
        return;
      }
    }

    // Authorization check for non-group messages
    if (!isGroup && !this.isAllowedSender(senderE164)) {
      logger.info(
        `Blocked unauthorized sender: ${senderE164}, allowFrom=${JSON.stringify(this.config.allowFrom)}`
      );
      return;
    }

    logger.info("Message passed authorization checks");

    // Get group metadata if needed
    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (isGroup) {
      const meta = await this.getGroupMeta(responseJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }

    // Check mention requirement for groups and self-chat
    const mentionedJids = this.extractMentionedJids(msg.message);
    const wasMentioned = selfJid
      ? (mentionedJids?.includes(selfJid) ?? false)
      : false;

    // For self-chat, require mention to prevent loops (bot replies don't have mentions)
    // Media messages (voice, image, video, etc.) are allowed through without trigger pattern
    if (isSelfChat && this.config.requireMention && !wasMentioned) {
      const mediaPlaceholder = this.extractMediaPlaceholder(msg.message);
      const hasMedia = mediaPlaceholder !== undefined;
      logger.info(
        `Self-chat check: id=${id}, hasMedia=${hasMedia}, mediaPlaceholder=${mediaPlaceholder}`
      );
      if (!hasMedia) {
        // Check for text trigger patterns like "@bot" in message body
        const bodyText = this.extractText(msg.message) || "";
        const hasTriggerPattern = /^@\w+/i.test(bodyText.trim());
        logger.info(
          `Self-chat trigger check: id=${id}, bodyText="${bodyText.substring(0, 50)}", hasTriggerPattern=${hasTriggerPattern}`
        );
        if (!hasTriggerPattern) {
          logger.info(
            `Skipping self-chat message without trigger pattern: ${id}`
          );
          return;
        }
      }
    }

    if (isGroup && this.config.requireMention && !wasMentioned) {
      return;
    }

    // Mark as read (unless self-chat)
    if (!isSelfChat) {
      await this.client
        .markRead(remoteJid, id, participantJid || undefined)
        .catch((err) => {
          logger.debug(
            { error: String(err) },
            "Failed to mark message as read"
          );
        });
    }

    // Skip history/offline catch-up messages (but allow self-chat messages)
    if (upsertType === "append" && !isSelfChat) {
      logger.info(`Skipping history/append message: ${id}`);
      return;
    }

    logger.info(
      `About to extract text from message ${id}, upsertType=${upsertType}`
    );

    // Debug: Log full message structure
    const msgJson = JSON.stringify(msg, null, 2);
    logger.info(`FULL_MESSAGE_DEBUG: ${msgJson.substring(0, 2000)}`);

    // Extract media files if file handler is available
    let extractedFiles: ExtractedMedia[] = [];
    let extractionErrors: MediaExtractionError[] = [];
    if (this.fileHandler) {
      try {
        const result = await this.fileHandler.extractMediaFromMessage(msg);
        extractedFiles = result.files;
        extractionErrors = result.errors;
        if (extractedFiles.length > 0) {
          logger.info(
            { messageId: id, fileCount: extractedFiles.length },
            "Extracted media files from message"
          );
        }
        if (extractionErrors.length > 0) {
          logger.warn(
            {
              messageId: id,
              errorCount: extractionErrors.length,
              errors: extractionErrors,
            },
            "Some media extraction failed"
          );
        }
      } catch (err) {
        logger.error(
          { error: String(err), messageId: id },
          "Failed to extract media"
        );
      }
    }

    // Extract message text
    let body = this.extractText(msg.message);
    if (!body) {
      // If we have files but no text, use a placeholder indicating files
      if (extractedFiles.length > 0) {
        const fileNames = extractedFiles.map((f) => f.name).join(", ");
        body = `[Attached: ${fileNames}]`;
      } else {
        body = this.extractMediaPlaceholder(msg.message);
        if (!body) {
          logger.info(`No text or media placeholder found in message ${id}`);
          return;
        }
      }
    }

    logger.info(`Message ${id} has body: ${body.substring(0, 50)}...`);

    // Check if this is an auth response (e.g., "1" to select provider)
    // Use responseJid (mapped JID) for consistency with auth prompt storage
    if (this.authAdapter && !isGroup) {
      const userId = senderE164 || senderJid || "";
      try {
        const handled = await this.authAdapter.handleAuthResponse(
          responseJid,
          userId,
          body
        );
        if (handled) {
          logger.info({ remoteJid, body }, "Message handled as auth response");
          return;
        }
      } catch (err) {
        logger.error({ error: String(err) }, "Error handling auth response");
      }
    }

    // Extract reply context
    const replyContext = this.describeReplyContext(msg.message);

    // Build context - use responseJid for routing (handles @lid -> @s.whatsapp.net mapping)
    const context: WhatsAppContext = {
      senderJid: senderJid || remoteJid,
      senderE164: senderE164 ?? undefined,
      senderName: msg.pushName ?? undefined,
      chatJid: responseJid, // Use responseJid for proper message routing
      isGroup,
      groupSubject,
      groupParticipants,
      messageId: id,
      timestamp: msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : undefined,
      quotedMessage: replyContext ?? undefined,
      mentionedJids,
      wasMentioned,
      selfJid: selfJid ?? undefined,
      selfE164: selfE164 ?? undefined,
    };

    logger.info(
      {
        from: senderE164 || senderJid,
        chatJid: responseJid,
        originalJid: remoteJid !== responseJid ? remoteJid : undefined,
        isGroup,
        body: body.substring(0, 100),
      },
      "Inbound message"
    );

    // Store incoming message in conversation history (use responseJid for consistency)
    this.storeMessageInHistory(responseJid, {
      id,
      text: body,
      fromMe: false,
      senderName: msg.pushName ?? undefined,
      timestamp: msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : Date.now(),
    });

    // Get in-memory conversation history for context
    const conversationHistory = this.getConversationHistory(responseJid);

    // Enqueue for processing
    await this.enqueueMessage(
      id,
      body,
      context,
      extractedFiles,
      conversationHistory,
      extractionErrors
    );
  }

  /**
   * Check if sender is allowed.
   */
  private isAllowedSender(senderE164: string | null): boolean {
    if (!senderE164) return false;

    const { allowFrom, selfChatEnabled } = this.config;
    const selfE164 = this.client.getSelfE164();

    // Self-chat always allowed if enabled
    if (selfChatEnabled && senderE164 === selfE164) {
      return true;
    }

    // Empty allowFrom means allow all
    if (!allowFrom || allowFrom.length === 0) {
      return true;
    }

    // Check wildcard
    if (allowFrom.includes("*")) {
      return true;
    }

    // Check if sender is in allowlist
    const normalizedAllowFrom = allowFrom.map(normalizeE164);
    return normalizedAllowFrom.includes(normalizeE164(senderE164));
  }

  /**
   * Get group metadata with caching.
   */
  private async getGroupMeta(
    jid: string
  ): Promise<{ subject?: string; participants?: string[] }> {
    const cached = this.groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }

    const meta = await this.client.getGroupMetadata(jid);
    const entry = {
      ...meta,
      expires: Date.now() + this.GROUP_META_TTL_MS,
    };
    this.groupMetaCache.set(jid, entry);
    return meta;
  }

  /**
   * Enqueue message for worker processing.
   */
  private async enqueueMessage(
    messageId: string,
    body: string,
    context: WhatsAppContext,
    files: ExtractedMedia[] = [],
    conversationHistory: Array<{
      role: "user" | "assistant";
      content: string;
      name?: string;
    }> = [],
    mediaErrors: MediaExtractionError[] = []
  ): Promise<void> {
    // For 1:1 chats: use chatJid for conversation continuity (all messages share context)
    // For groups: use quoted message ID or message ID (explicit reply threading)
    const conversationId = context.isGroup
      ? context.quotedMessage?.id || messageId
      : context.chatJid;

    // Generate trace ID for end-to-end observability
    const traceId = generateTraceId(messageId);

    logger.info(
      {
        traceId,
        messageId,
        conversationId,
        userId: context.senderE164 || context.senderJid,
      },
      "Message received"
    );

    // Check for channel binding first (explicit agent assignment)
    let agentId: string;
    if (this.channelBindingService) {
      const binding = await this.channelBindingService.getBinding(
        "whatsapp",
        context.chatJid
      );
      if (binding) {
        agentId = binding.agentId;
        logger.info(
          `Using bound agentId: ${agentId} for chat ${context.chatJid}`
        );
      } else {
        // No binding - send configuration prompt
        const sent = await this.sendWhatsAppConfigPrompt(context);
        if (sent) return;

        // Fallback if config prompt fails
        const space = resolveSpace({
          platform: "whatsapp",
          userId: context.senderE164 || context.senderJid,
          channelId: context.chatJid,
          isGroup: context.isGroup,
        });
        agentId = space.agentId;
      }
    } else {
      // Fall back to space-based resolution
      const space = resolveSpace({
        platform: "whatsapp",
        userId: context.senderE164 || context.senderJid,
        channelId: context.chatJid,
        isGroup: context.isGroup,
      });
      agentId = space.agentId;
    }

    // Handle /configure command - send settings magic link
    if (body.trim().toLowerCase() === "/configure") {
      const userId = context.senderE164 || context.senderJid;
      logger.info(`User ${userId} requested /configure for agent ${agentId}`);
      try {
        const token = generateSettingsToken(agentId, userId, "whatsapp");
        const settingsUrl = buildSettingsUrl(token);

        await this.client.sendMessage(context.chatJid, {
          text: `Here's your settings link (valid for 1 hour):\n${settingsUrl}\n\nUse this page to configure your agent's model, network access, git repository, and more.`,
        });
        logger.info(`Sent settings link to user ${userId}`);
      } catch (error) {
        logger.error("Failed to generate settings link", { error });
        await this.client.sendMessage(context.chatJid, {
          text: "Sorry, I couldn't generate a settings link. Please try again later.",
        });
      }
      return;
    }

    // Transcribe audio files if transcription service is available
    let transcribedBody = body;
    const audioFiles = files.filter(
      (f) => f.mimetype.startsWith("audio/") || f.mimetype === "application/ogg"
    );

    // Check if we received an audio message but couldn't download it
    const hadAudioMessage =
      body === "<media:audio>" || body.includes("<media:audio>");
    const audioError = mediaErrors.find((e) => e.mediaType === "audioMessage");
    if (hadAudioMessage && audioFiles.length === 0) {
      // Audio message was detected but download failed - inform Claude clearly
      const errorDetail = audioError?.error || "Unknown error";
      transcribedBody = `[Voice message received - audio download failed]

The user sent a voice message but the audio file could not be downloaded from WhatsApp's servers.

Error: ${errorDetail}

This is typically a temporary issue with WhatsApp's CDN - the file may not be available yet or the download link expired.

Please let the user know:
1. You received their voice message but couldn't process it due to a technical issue
2. Ask them to either send the voice message again or type their message instead
3. This is not their fault - it's a WhatsApp infrastructure timing issue`;
      logger.warn(
        { messageId, body, error: errorDetail },
        "Audio message detected but file download failed"
      );
    } else if (audioFiles.length > 0 && this.transcriptionService) {
      logger.info(
        { messageId, audioFileCount: audioFiles.length },
        "Attempting to transcribe audio files"
      );

      for (const audioFile of audioFiles) {
        const result = await this.transcriptionService.transcribe(
          audioFile.buffer,
          agentId,
          audioFile.mimetype
        );

        if ("text" in result) {
          // Successful transcription
          const transcriptionPrefix =
            transcribedBody === "<media:audio>" ||
            transcribedBody.startsWith("[Attached:")
              ? "" // Replace placeholder entirely
              : `${transcribedBody}\n\n`;
          transcribedBody = `${transcriptionPrefix}[Voice message]: ${result.text}`;
          logger.info(
            {
              messageId,
              provider: result.provider,
              textLength: result.text.length,
            },
            "Audio transcription successful"
          );
        } else {
          // Transcription not configured or failed - provide context for Claude
          const providers = result.availableProviders;
          if (result.error.includes("No transcription provider configured")) {
            transcribedBody = `[Voice message received - transcription unavailable]

The user sent a voice message but no transcription provider is configured.
Available providers that can be configured: ${providers.join(", ")}

To enable voice transcription:
1. Use the GetSettingsLink tool to generate a settings link for the user
2. They can add their preferred provider's API key (OPENAI_API_KEY, GOOGLE_API_KEY, or ELEVENLABS_API_KEY)
3. Optionally set TRANSCRIPTION_PROVIDER to choose a specific provider (openai, gemini, elevenlabs)

For now, let the user know you received a voice message but couldn't transcribe it,
and offer to help them configure transcription.`;
          } else {
            // Transcription attempt failed
            transcribedBody = `[Voice message received - transcription failed]

Error: ${result.error}

The user sent a voice message but transcription failed. Let them know and suggest they try again or type their message.`;
          }
          logger.warn(
            { messageId, error: result.error },
            "Audio transcription failed or not configured"
          );
        }
      }
    }

    // Build file metadata for payload
    const fileMetadata = files.map((f) => ({
      id: f.id,
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
    }));

    // Fetch agent settings and merge with config defaults
    const agentOptions = await this.getAgentOptionsWithSettings(agentId);

    // Extract top-level configs from agentOptions for orchestration
    const {
      networkConfig,
      gitConfig,
      nixConfig,
      mcpServers,
      ...remainingOptions
    } = agentOptions;

    const payload: MessagePayload = {
      platform: "whatsapp",
      userId: context.senderE164 || context.senderJid,
      botId: "whatsapp",
      conversationId,
      teamId: context.isGroup ? context.chatJid : "whatsapp", // Group JID for groups, "whatsapp" for DMs
      agentId,
      messageId,
      messageText: transcribedBody,
      channelId: context.chatJid,
      platformMetadata: {
        traceId, // Add trace ID for end-to-end tracing
        agentId, // Required for credential storage/lookup
        jid: context.chatJid,
        senderJid: context.senderJid,
        senderE164: context.senderE164,
        senderName: context.senderName,
        isGroup: context.isGroup,
        groupSubject: context.groupSubject,
        quotedMessageId: context.quotedMessage?.id,
        wasMentioned: context.wasMentioned,
        responseChannel: context.chatJid,
        responseId: messageId,
        files: fileMetadata.length > 0 ? fileMetadata : undefined,
        conversationHistory:
          conversationHistory.length > 0 ? conversationHistory : undefined,
      },
      agentOptions: remainingOptions,
      // Set top-level configs for orchestration
      networkConfig,
      gitConfig,
      nixConfig,
      mcpConfig: mcpServers ? { mcpServers } : undefined,
    };

    await this.queueProducer.enqueueMessage(payload);
    logger.info(
      {
        traceId,
        messageId,
        conversationId,
        chatJid: context.chatJid,
        fileCount: files.length,
        historyCount: conversationHistory.length,
      },
      "Message enqueued"
    );
  }

  /**
   * Extract text from message.
   */
  private extractText(
    rawMessage: proto.IMessage | null | undefined
  ): string | undefined {
    if (!rawMessage) {
      logger.info("extractText: rawMessage is null/undefined");
      return undefined;
    }

    logger.info(
      `extractText: rawMessage keys = ${Object.keys(rawMessage).join(", ")}`
    );

    const message = normalizeMessageContent(rawMessage);
    if (!message) {
      logger.info("extractText: normalizeMessageContent returned null");
      return undefined;
    }

    logger.info(
      `extractText: normalized message keys = ${Object.keys(message).join(", ")}`
    );

    const extracted = extractMessageContent(message);
    const candidates = [message, extracted !== message ? extracted : undefined];

    for (const candidate of candidates) {
      if (!candidate) continue;

      // Check conversation
      if (
        typeof candidate.conversation === "string" &&
        candidate.conversation.trim()
      ) {
        return candidate.conversation.trim();
      }

      // Check extended text
      const extended = candidate.extendedTextMessage?.text;
      if (extended?.trim()) return extended.trim();

      // Check captions
      const caption =
        candidate.imageMessage?.caption ??
        candidate.videoMessage?.caption ??
        candidate.documentMessage?.caption;
      if (caption?.trim()) return caption.trim();
    }

    return undefined;
  }

  /**
   * Extract media placeholder text.
   */
  private extractMediaPlaceholder(
    rawMessage: proto.IMessage | null | undefined
  ): string | undefined {
    if (!rawMessage) return undefined;

    const message = normalizeMessageContent(rawMessage);
    if (!message) return undefined;

    if (message.imageMessage) return "<media:image>";
    if (message.videoMessage) return "<media:video>";
    if (message.audioMessage) return "<media:audio>";
    if (message.documentMessage) return "<media:document>";
    if (message.stickerMessage) return "<media:sticker>";

    return undefined;
  }

  /**
   * Extract mentioned JIDs from message.
   */
  private extractMentionedJids(
    rawMessage: proto.IMessage | null | undefined
  ): string[] | undefined {
    if (!rawMessage) return undefined;

    const message = normalizeMessageContent(rawMessage);
    if (!message) return undefined;

    const candidates: Array<string[] | null | undefined> = [
      message.extendedTextMessage?.contextInfo?.mentionedJid,
      message.imageMessage?.contextInfo?.mentionedJid,
      message.videoMessage?.contextInfo?.mentionedJid,
      message.documentMessage?.contextInfo?.mentionedJid,
      message.audioMessage?.contextInfo?.mentionedJid,
    ];

    const flattened = candidates.flatMap((arr) => arr ?? []).filter(Boolean);
    if (flattened.length === 0) return undefined;

    return Array.from(new Set(flattened));
  }

  /**
   * Extract reply context from message.
   */
  private describeReplyContext(
    rawMessage: proto.IMessage | null | undefined
  ): { id?: string; body: string; sender: string } | null {
    if (!rawMessage) return null;

    const message = normalizeMessageContent(rawMessage);
    if (!message) return null;

    // Get context info from various message types
    const contextInfo =
      message.extendedTextMessage?.contextInfo ??
      message.imageMessage?.contextInfo ??
      message.videoMessage?.contextInfo ??
      message.documentMessage?.contextInfo ??
      message.audioMessage?.contextInfo;

    if (!contextInfo?.quotedMessage) return null;

    const quoted = normalizeMessageContent(contextInfo.quotedMessage);
    if (!quoted) return null;

    const body =
      this.extractText(quoted) || this.extractMediaPlaceholder(quoted);
    if (!body) return null;

    const senderJid = contextInfo.participant;
    const senderE164 = senderJid ? jidToE164(senderJid) : null;

    return {
      id: contextInfo.stanzaId || undefined,
      body,
      sender: senderE164 || senderJid || "unknown",
    };
  }

  /**
   * Store a message in conversation history.
   */
  private storeMessageInHistory(chatJid: string, message: StoredMessage): void {
    const history = this.conversationHistory.get(chatJid) || {
      messages: [],
      lastUpdated: Date.now(),
    };

    // Add message to history
    history.messages.push(message);
    history.lastUpdated = Date.now();

    // Trim to max messages
    while (history.messages.length > this.config.maxHistoryMessages) {
      history.messages.shift();
    }

    this.conversationHistory.set(chatJid, history);
  }

  /**
   * Get conversation history for a chat.
   * Returns messages in chronological order with role annotation.
   */
  private getConversationHistory(chatJid: string): Array<{
    role: "user" | "assistant";
    content: string;
    name?: string;
  }> {
    const history = this.conversationHistory.get(chatJid);
    if (!history) return [];

    // Check TTL
    const ttlMs = this.config.historyTtlSeconds * 1000;
    if (Date.now() - history.lastUpdated > ttlMs) {
      this.conversationHistory.delete(chatJid);
      return [];
    }

    return history.messages.map((msg) => ({
      role: msg.fromMe ? ("assistant" as const) : ("user" as const),
      content: msg.text,
      name: msg.senderName,
    }));
  }

  /**
   * Store an outgoing (bot) message in history.
   * Called from response renderer when sending messages.
   */
  storeOutgoingMessage(chatJid: string, text: string): void {
    this.storeMessageInHistory(chatJid, {
      id: `outgoing_${Date.now()}`,
      text,
      fromMe: true,
      timestamp: Date.now(),
    });
  }

  /**
   * Get conversation history for API endpoint.
   * Returns messages formatted for the history API.
   */
  getHistory(
    chatJid: string,
    limit: number,
    before?: string
  ): {
    messages: Array<{
      timestamp: string;
      user: string;
      text: string;
      isBot?: boolean;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  } {
    const history = this.conversationHistory.get(chatJid);
    if (!history) {
      return { messages: [], nextCursor: null, hasMore: false };
    }

    // Check TTL
    const ttlMs = this.config.historyTtlSeconds * 1000;
    if (Date.now() - history.lastUpdated > ttlMs) {
      this.conversationHistory.delete(chatJid);
      return { messages: [], nextCursor: null, hasMore: false };
    }

    // Filter by before timestamp if provided
    let messages = history.messages;
    if (before) {
      const beforeTs = new Date(before).getTime();
      messages = messages.filter((m) => m.timestamp < beforeTs);
    }

    // Sort by timestamp descending (newest first) and limit
    const sorted = [...messages]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    // Format for API response
    const formatted = sorted.map((msg) => ({
      timestamp: new Date(msg.timestamp).toISOString(),
      user: msg.senderName || (msg.fromMe ? "Assistant" : "User"),
      text: msg.text,
      isBot: msg.fromMe,
    }));

    const hasMore = messages.length > limit;
    const lastMessage = sorted[sorted.length - 1];
    const nextCursor =
      hasMore && lastMessage
        ? new Date(lastMessage.timestamp).toISOString()
        : null;

    return {
      messages: formatted,
      nextCursor,
      hasMore,
    };
  }

  /**
   * Cleanup expired conversation histories.
   */
  private cleanupExpiredHistories(): void {
    const now = Date.now();
    const ttlMs = this.config.historyTtlSeconds * 1000;

    for (const [chatJid, history] of this.conversationHistory) {
      if (now - history.lastUpdated > ttlMs) {
        this.conversationHistory.delete(chatJid);
      }
    }
  }

  /**
   * Handle message reactions.
   * Could be used to trigger actions based on specific reactions.
   */
  private async handleReactions(
    reactions: BaileysEventMap["messages.reaction"]
  ): Promise<void> {
    for (const reaction of reactions) {
      const { key, reaction: reactionData } = reaction;
      const emoji = reactionData.text;
      const messageId = key.id;
      const chatJid = key.remoteJid;

      logger.info(
        { emoji, messageId, chatJid, from: key.participant },
        "Received reaction"
      );

      // Potential future use cases:
      // - thumbs up on a tool approval message = approve
      // - thumbs down = reject
      // - checkmark = acknowledge
      // For now, just log the reaction
    }
  }

  /**
   * Handle message updates (edits, deletes).
   * Could be used to update conversation history when messages are edited.
   */
  private async handleMessageUpdates(
    updates: BaileysEventMap["messages.update"]
  ): Promise<void> {
    for (const update of updates) {
      const { key, update: updateData } = update;
      const messageId = key.id;
      const chatJid = key.remoteJid;

      // Check if message was edited
      if (updateData.message) {
        logger.info(
          { messageId, chatJid, hasNewMessage: true },
          "Message was edited"
        );

        // Could update the message in conversation history here
        // For now, just log the event
      }

      // Check if message was deleted (stub type indicates deletion)
      if (updateData.messageStubType) {
        logger.info(
          { messageId, chatJid, stubType: updateData.messageStubType },
          "Message was deleted or has stub update"
        );
      }
    }
  }
}
