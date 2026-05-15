/**
 * Platform connection types for API-driven Chat SDK integrations.
 * Config types are derived directly from adapter factory signatures — zero maintenance.
 */

import type { createDiscordAdapter } from "@chat-adapter/discord";
import type { createGoogleChatAdapter } from "@chat-adapter/gchat";
import type { createSlackAdapter } from "@chat-adapter/slack";
import type { createTeamsAdapter } from "@chat-adapter/teams";
import type { createTelegramAdapter } from "@chat-adapter/telegram";
import type { createWhatsAppAdapter } from "@chat-adapter/whatsapp";

// Derive config types from what the adapter factories actually accept
export type TelegramAdapterConfig = NonNullable<
  Parameters<typeof createTelegramAdapter>[0]
> & { platform: "telegram" };
export type SlackAdapterConfig = NonNullable<
  Parameters<typeof createSlackAdapter>[0]
> & { platform: "slack" };
export type DiscordAdapterConfig = NonNullable<
  Parameters<typeof createDiscordAdapter>[0]
> & { platform: "discord" };
export type WhatsAppAdapterConfig = NonNullable<
  Parameters<typeof createWhatsAppAdapter>[0]
> & { platform: "whatsapp" };
export type TeamsAdapterConfig = NonNullable<
  Parameters<typeof createTeamsAdapter>[0]
> & { platform: "teams" };
export type GoogleChatAdapterConfig = NonNullable<
  Parameters<typeof createGoogleChatAdapter>[0]
> & { platform: "gchat" };

export type PlatformAdapterConfig =
  | TelegramAdapterConfig
  | SlackAdapterConfig
  | DiscordAdapterConfig
  | WhatsAppAdapterConfig
  | TeamsAdapterConfig
  | GoogleChatAdapterConfig;

/** Narrow a connection's config to the Telegram shape. */
export function isTelegramConfig(
  config: PlatformAdapterConfig
): config is TelegramAdapterConfig {
  return config.platform === "telegram";
}

/** Narrow a connection's config to the Slack shape. */
export function isSlackConfig(
  config: PlatformAdapterConfig
): config is SlackAdapterConfig {
  return config.platform === "slack";
}

export interface PlatformConnection {
  id: string;
  platform: string;
  agentId?: string;
  /**
   * Organization id this connection belongs to. Mirrors
   * `agent_connections.organization_id`. Optional in the type for
   * back-compat with in-memory tests; required at the storage layer.
   */
  organizationId?: string;
  config: PlatformAdapterConfig;
  settings: ConnectionSettings;
  metadata: Record<string, any>;
  status: "active" | "stopped" | "error";
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export type UserConfigScope =
  | "model"
  | "view-model"
  | "system-prompt"
  | "skills"
  | "permissions"
  | "packages";

export interface ConnectionSettings {
  allowFrom?: string[];
  allowGroups?: boolean;
  userConfigScopes?: UserConfigScope[];
  /**
   * Marks this connection as a hosted "Preview" workspace bot (today: Slack —
   * the public "Lobu" workspace). When a DM/@-mention arrives for a chat that
   * hasn't been linked to an agent yet, the message-handler replies with the
   * linking instructions instead of running the connection's (placeholder)
   * owning agent. The connection's `platform` determines which notice/link
   * mechanism applies.
   */
  previewMode?: boolean;
}

/** Heuristic: field names matching these patterns contain secrets and must be encrypted at rest. */
const SECRET_FIELD_PATTERNS = [
  "token",
  "secret",
  "password",
  "key",
  "credential",
];

export function isSecretField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return SECRET_FIELD_PATTERNS.some((p) => lower.includes(p));
}
