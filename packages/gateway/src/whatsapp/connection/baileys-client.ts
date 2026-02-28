/**
 * Baileys WebSocket client wrapper.
 * Manages WhatsApp Web connection lifecycle.
 */

import { EventEmitter } from "node:events";
import { createLogger } from "@lobu/core";
import {
  type AnyMessageContent,
  type BaileysEventMap,
  type ConnectionState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import type { WhatsAppConfig } from "../config";
import type { ConnectionCloseReason, WhatsAppConnectionStatus } from "../types";
import { e164ToJid, jidToE164 } from "../types";
import {
  createAuthState,
  loadCredentialsFromEnv,
  logCredentialsUpdateInstruction,
} from "./auth-state";
import { ReconnectionManager } from "./reconnection";

const logger = createLogger("whatsapp-client");

export interface BaileysClientEvents {
  connected: [];
  disconnected: [reason: ConnectionCloseReason];
  qr: [qrCode: string];
  logout: [];
  credentialsUpdated: [serialized: string];
  message: [message: BaileysEventMap["messages.upsert"]];
  reaction: [reaction: BaileysEventMap["messages.reaction"]];
  messageUpdate: [update: BaileysEventMap["messages.update"]];
}

/**
 * Baileys client wrapper with connection management.
 */
export class BaileysClient extends EventEmitter<BaileysClientEvents> {
  private socket: WASocket | null = null;
  private config: WhatsAppConfig;
  private reconnectionManager: ReconnectionManager;
  private status: WhatsAppConnectionStatus;
  private authState: ReturnType<typeof createAuthState> | null = null;
  private isShuttingDown = false;

  constructor(config: WhatsAppConfig) {
    super();
    this.config = config;
    this.reconnectionManager = new ReconnectionManager({
      initialMs: config.reconnectBaseDelay,
      maxMs: config.reconnectMaxDelay,
      factor: config.reconnectFactor,
      jitter: config.reconnectJitter,
      maxAttempts: config.reconnectMaxAttempts,
    });
    this.status = {
      connected: false,
      reconnectAttempts: 0,
      qrPending: false,
    };
  }

  /**
   * Get current connection status.
   */
  getStatus(): WhatsAppConnectionStatus {
    return { ...this.status };
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.status.connected;
  }

  /**
   * Get the bot's own JID.
   */
  getSelfJid(): string | null {
    return this.socket?.user?.id ?? null;
  }

  /**
   * Get the bot's own E.164 number.
   */
  getSelfE164(): string | null {
    const jid = this.getSelfJid();
    return jid ? jidToE164(jid) : null;
  }

  /**
   * Get the updateMediaMessage function for re-requesting media from CDN.
   * Used when WhatsApp CDN returns stale/expired media URLs.
   */
  getUpdateMediaMessage(): WASocket["updateMediaMessage"] | undefined {
    return this.socket?.updateMediaMessage;
  }

  /**
   * Connect to WhatsApp.
   */
  async connect(): Promise<void> {
    this.isShuttingDown = false;

    // Load credentials from env - required for production
    logger.debug("Loading WhatsApp credentials");
    const initialState = loadCredentialsFromEnv(this.config.credentials);
    if (!initialState) {
      throw new Error(
        "WhatsApp credentials not configured. " +
          "Run 'bun packages/gateway/src/cli/index.ts whatsapp-setup' to obtain WHATSAPP_CREDENTIALS."
      );
    }

    this.authState = createAuthState(initialState);
    await this.createSocket();
    logger.debug("WhatsApp socket created");
  }

  /**
   * Create the Baileys socket.
   */
  private async createSocket(): Promise<void> {
    if (!this.authState) {
      throw new Error("Auth state not initialized");
    }

    // Silent pino logger for Baileys
    const baileysLogger = pino({ level: "silent" }) as unknown as ReturnType<
      typeof pino
    >;

    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      auth: {
        creds: this.authState.state.creds,
        keys: makeCacheableSignalKeyStore(
          this.authState.state.keys as any,
          baileysLogger
        ),
      },
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ["lobu", "gateway", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for Baileys socket.
   */
  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Connection state updates
    this.socket.ev.on("connection.update", (update) => {
      this.handleConnectionUpdate(update);
    });

    // Credential updates
    this.socket.ev.on("creds.update", async () => {
      if (this.authState) {
        const serialized = await this.authState.saveCreds();
        this.emit("credentialsUpdated", serialized);
        logCredentialsUpdateInstruction(serialized.length);
      }
    });

    // Message updates
    this.socket.ev.on("messages.upsert", (upsert) => {
      logger.info(
        { type: upsert.type, messageCount: upsert.messages?.length },
        "Received messages.upsert event"
      );
      this.status.lastMessageAt = new Date();
      this.emit("message", upsert);
    });

    // Message reactions
    this.socket.ev.on("messages.reaction", (reactions) => {
      logger.info({ count: reactions.length }, "Received message reactions");
      this.emit("reaction", reactions);
    });

    // Message updates (edits, deletes)
    this.socket.ev.on("messages.update", (updates) => {
      logger.info({ count: updates.length }, "Received message updates");
      this.emit("messageUpdate", updates);
    });

    // WebSocket error handling
    if (
      this.socket.ws &&
      typeof (this.socket.ws as unknown as { on?: unknown }).on === "function"
    ) {
      this.socket.ws.on("error", (err: Error) => {
        logger.error({ error: String(err) }, "WebSocket error");
      });
    }
  }

  /**
   * Handle connection state updates.
   */
  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    // QR code for authentication
    if (qr) {
      this.status.qrPending = true;
      logger.info("QR code received, scan with WhatsApp Linked Devices");
      qrcode.generate(qr, { small: true });
      this.emit("qr", qr);
    }

    // Connection opened
    if (connection === "open") {
      this.status.connected = true;
      this.status.qrPending = false;
      this.status.lastConnectedAt = new Date();
      this.status.reconnectAttempts = 0;
      this.reconnectionManager.reset();

      const selfE164 = this.getSelfE164();
      logger.info(`WhatsApp connected (selfE164=${selfE164})`);
      this.emit("connected");

      // Send available presence
      this.socket?.sendPresenceUpdate("available").catch((err) => {
        logger.warn(
          { error: String(err) },
          "Failed to send available presence"
        );
      });
    }

    // Connection closed
    if (connection === "close") {
      this.status.connected = false;
      const statusCode = this.getStatusCode(lastDisconnect?.error);
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      this.status.lastDisconnectReason = isLoggedOut
        ? "logged_out"
        : `status_${statusCode}`;

      const reason: ConnectionCloseReason = {
        status: statusCode,
        isLoggedOut,
        error: lastDisconnect?.error,
      };

      // Log full error details for debugging
      const errorMessage =
        lastDisconnect?.error instanceof Error
          ? lastDisconnect.error.message
          : String(lastDisconnect?.error || "unknown");

      logger.warn(
        `WhatsApp disconnected: statusCode=${statusCode}, isLoggedOut=${isLoggedOut}, errorMessage=${errorMessage}`
      );
      this.emit("disconnected", reason);

      if (isLoggedOut) {
        logger.error("Session logged out, credentials invalidated");
        this.emit("logout");
      } else if (!this.isShuttingDown) {
        this.handleReconnect();
      }
    }
  }

  /**
   * Extract status code from error.
   */
  private getStatusCode(err: unknown): number | undefined {
    return (
      (err as { output?: { statusCode?: number } })?.output?.statusCode ??
      (err as { status?: number })?.status
    );
  }

  /**
   * Handle reconnection logic.
   */
  private async handleReconnect(): Promise<void> {
    if (!this.reconnectionManager.shouldReconnect()) {
      logger.error(
        { attempts: this.reconnectionManager.getAttempts() },
        "Max reconnection attempts reached"
      );
      return;
    }

    const delay = this.reconnectionManager.getCurrentDelay();
    logger.info(
      `Scheduling reconnection (delay=${delay}ms, attempt=${this.reconnectionManager.getAttempts() + 1})`
    );

    const shouldRetry = await this.reconnectionManager.waitForNextAttempt();
    if (!shouldRetry || this.isShuttingDown) {
      return;
    }

    this.status.reconnectAttempts = this.reconnectionManager.getAttempts();

    try {
      await this.createSocket();
    } catch (err) {
      logger.error({ error: String(err) }, "Reconnection failed");
      this.handleReconnect();
    }
  }

  /**
   * Disconnect from WhatsApp.
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.reconnectionManager.abort();

    if (this.socket) {
      try {
        this.socket.ws?.close();
      } catch (err) {
        logger.warn({ error: String(err) }, "Error closing socket");
      }
      this.socket = null;
    }

    this.status.connected = false;
  }

  /**
   * Send a text message.
   */
  async sendMessage(
    to: string,
    content: AnyMessageContent
  ): Promise<{ messageId: string }> {
    if (!this.socket) {
      throw new Error("Not connected to WhatsApp");
    }

    // Normalize JID - keep @lid as-is (it's a linked device ID, NOT a phone number)
    const jid = to.includes("@") ? to : e164ToJid(to);
    // Note: @lid JIDs must be sent as-is - WhatsApp routes them internally
    // Do NOT convert @lid to @s.whatsapp.net as the digits are not phone numbers

    logger.info(
      { jid, contentType: Object.keys(content)[0] },
      "Sending WhatsApp message"
    );
    const result = await this.socket.sendMessage(jid, content);
    return { messageId: result?.key?.id ?? "unknown" };
  }

  /**
   * Send typing indicator.
   */
  async sendTyping(to: string, duration?: number): Promise<void> {
    if (!this.socket) return;

    const jid = to.includes("@") ? to : e164ToJid(to);
    await this.socket.sendPresenceUpdate("composing", jid);

    // Auto-clear typing after duration
    if (duration) {
      setTimeout(async () => {
        try {
          await this.socket?.sendPresenceUpdate("paused", jid);
        } catch {
          // Ignore
        }
      }, duration);
    }
  }

  /**
   * Mark messages as read.
   */
  async markRead(
    remoteJid: string,
    messageId: string,
    participant?: string
  ): Promise<void> {
    if (!this.socket) return;

    await this.socket.readMessages([
      { remoteJid, id: messageId, participant, fromMe: false },
    ]);
  }

  /**
   * Get group metadata.
   */
  async getGroupMetadata(groupJid: string): Promise<{
    subject?: string;
    participants?: string[];
  }> {
    if (!this.socket) {
      return {};
    }

    try {
      const meta = await this.socket.groupMetadata(groupJid);
      const participants = meta.participants
        ?.map((p) => jidToE164(p.id) ?? p.id)
        .filter(Boolean);

      return {
        subject: meta.subject,
        participants,
      };
    } catch (err) {
      logger.warn(
        { groupJid, error: String(err) },
        "Failed to fetch group metadata"
      );
      return {};
    }
  }
}
