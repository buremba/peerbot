/**
 * WhatsApp-specific type definitions.
 */

import type { AnyMessageContent } from "@whiskeysockets/baileys";

/**
 * WhatsApp context extracted from incoming messages.
 */
export interface WhatsAppContext {
  /** Sender's JID (e.g., "1234567890@s.whatsapp.net") */
  senderJid: string;

  /** Sender's E.164 phone number (e.g., "+1234567890") */
  senderE164?: string;

  /** Sender's display name (push name) */
  senderName?: string;

  /** Chat JID - same as sender for DMs, group JID for groups */
  chatJid: string;

  /** Whether this is a group chat */
  isGroup: boolean;

  /** Group subject/name if in a group */
  groupSubject?: string;

  /** Group participants if in a group */
  groupParticipants?: string[];

  /** Message ID */
  messageId: string;

  /** Message timestamp */
  timestamp?: number;

  /** Quoted message context if replying */
  quotedMessage?: {
    id?: string;
    body: string;
    sender: string;
  };

  /** JIDs mentioned in the message */
  mentionedJids?: string[];

  /** Whether the bot was mentioned (for group chats) */
  wasMentioned?: boolean;

  /** Bot's own JID */
  selfJid?: string;

  /** Bot's own E.164 number */
  selfE164?: string;
}

/**
 * Inbound message structure after processing.
 */
export interface WhatsAppInboundMessage {
  /** Unique message ID */
  id: string;

  /** Message text content */
  body: string;

  /** WhatsApp context */
  context: WhatsAppContext;

  /** Media attachment if present */
  media?: {
    path: string;
    mimeType: string;
    fileName?: string;
  };

  /** Helper to send typing indicator */
  sendComposing: () => Promise<void>;

  /** Helper to reply with text */
  reply: (text: string) => Promise<void>;

  /** Helper to send media */
  sendMedia: (payload: AnyMessageContent) => Promise<void>;
}

/**
 * Connection status for health monitoring.
 */
export interface WhatsAppConnectionStatus {
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt?: Date;
  lastDisconnectReason?: string;
  lastMessageAt?: Date;
  qrPending: boolean;
}

/**
 * Reconnection policy configuration.
 */
export interface ReconnectPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
  maxAttempts: number;
}

/**
 * Close reason for connection.
 */
export interface ConnectionCloseReason {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
}

/**
 * WhatsApp credentials structure (Baileys auth state).
 */
export interface WhatsAppCredentials {
  creds: Record<string, unknown>;
  keys: Record<string, unknown>;
}

/**
 * Result of sending a message.
 */
export interface SendMessageResult {
  messageId: string;
  toJid: string;
}

/**
 * Media kind for file handling.
 */
export type MediaKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "unknown";

/**
 * Helper to convert JID to E.164 format.
 * Only works for @s.whatsapp.net JIDs (real phone numbers).
 * Returns null for @lid (linked ID) JIDs which are internal WhatsApp IDs, not phone numbers.
 */
export function jidToE164(jid: string): string | null {
  if (!jid) return null;

  // @lid JIDs are internal WhatsApp linked IDs, not phone numbers
  // They look like: 167564575514790@lid (very long numbers that aren't real phone numbers)
  if (jid.endsWith("@lid")) {
    return null;
  }

  // Only convert @s.whatsapp.net JIDs which contain real phone numbers
  // Handle formats:
  // - 447512972810@s.whatsapp.net (standard)
  // - 447512972810:13@s.whatsapp.net (with device ID)
  if (!jid.endsWith("@s.whatsapp.net")) {
    return null;
  }

  const match = jid.match(/^(\d+)(?::\d+)?@/);
  if (!match || !match[1]) return null;

  // Sanity check: phone numbers are typically 7-15 digits
  const digits = match[1];
  if (digits.length < 7 || digits.length > 15) {
    return null;
  }

  return `+${digits}`;
}

/**
 * Helper to convert E.164 to WhatsApp JID.
 */
export function e164ToJid(e164: string): string {
  // Remove + and add @s.whatsapp.net
  const digits = e164.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * Normalize phone number to E.164 format.
 */
export function normalizeE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/**
 * Check if a JID is a group JID.
 */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}
