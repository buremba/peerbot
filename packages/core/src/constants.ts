#!/usr/bin/env bun

/**
 * Shared constants across all packages
 * These are platform-agnostic and used by core, gateway, and platform adapters
 */

// Time constants (milliseconds)
export const TIME = {
  /** One hour in milliseconds */
  HOUR_MS: 60 * 60 * 1000,
  /** One day in milliseconds */
  DAY_MS: 24 * 60 * 60 * 1000,
  /** One hour in seconds */
  HOUR_SECONDS: 3600,
  /** One day in seconds */
  DAY_SECONDS: 24 * 60 * 60,
  /** Five seconds in milliseconds */
  FIVE_SECONDS_MS: 5000,
  /** Thirty seconds */
  THIRTY_SECONDS: 30,
} as const;

/**
 * MCP protocol version this codebase advertises on `initialize` handshakes.
 * Kept in one place so the gateway, CLI, and openclaw plugin stay in lockstep.
 */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

/**
 * Chat platforms Lobu operates a hosted bot for. A platform entry of one of
 * these types declared with NO credential `config` resolves to the hosted Lobu
 * bot (reachable by redeeming a `/lobu link <code>` claim) instead of a
 * self-hosted connection — the user never supplies a bot token.
 */
export const HOSTED_CHAT_PLATFORMS = ["slack", "telegram"] as const;
export type HostedChatPlatform = (typeof HOSTED_CHAT_PLATFORMS)[number];

export function isHostedChatPlatform(type: string): type is HostedChatPlatform {
  return (HOSTED_CHAT_PLATFORMS as readonly string[]).includes(type);
}

/**
 * Whether a declared chat-platform entry resolves to the hosted Lobu bot: a
 * hosted-eligible type (`slack`/`telegram`) with `config` OMITTED and no
 * declarative `channels`. Either a present `config` (even `{}`, which means
 * "resolve the token from the env fallback") or `channels` signals self-hosted
 * intent, so the entry is NOT hosted — that path must fail loud on an
 * unresolved token (via the secrets gate) rather than silently demote a
 * self-hosted app to the hosted bot. The hosted entry must never become a
 * credential-less connection row; `lobu run` reads it straight from the
 * authored config to mint a link code (`surfaces` / `codeTtlMinutes` tune that
 * code and stay hosted).
 */
export function isHostedChatEntry(entry: {
  type: string;
  config?: Record<string, unknown> | undefined;
  channels?: readonly string[] | undefined;
}): boolean {
  return (
    isHostedChatPlatform(entry.type) &&
    entry.config === undefined &&
    (entry.channels?.length ?? 0) === 0
  );
}

// Default configuration values
export const DEFAULTS = {
  /** Default session TTL in milliseconds */
  SESSION_TTL_MS: TIME.DAY_MS,
  /** Default session TTL in seconds */
  SESSION_TTL_SECONDS: TIME.DAY_SECONDS,
  /** Default queue expiration in hours */
  QUEUE_EXPIRE_HOURS: 24,
  /** Default retry limit for queue operations */
  QUEUE_RETRY_LIMIT: 3,
  /** Default retry delay in seconds */
  QUEUE_RETRY_DELAY_SECONDS: TIME.THIRTY_SECONDS,
  /** Default session timeout in minutes */
  SESSION_TIMEOUT_MINUTES: 5,
} as const;
