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
  /** One minute in milliseconds */
  MINUTE_MS: 60 * 1000,
  /** Five seconds in milliseconds */
  FIVE_SECONDS_MS: 5000,
  /** Thirty seconds */
  THIRTY_SECONDS: 30,
  /** Three hours in milliseconds (for interaction timeout) */
  THREE_HOURS_MS: 3 * 60 * 60 * 1000,
  /** Three hours in seconds (for TTLs that expect seconds) */
  THREE_HOURS_SECONDS: 3 * 60 * 60,
} as const;

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
