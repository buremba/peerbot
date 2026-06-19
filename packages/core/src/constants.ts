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

/**
 * Embedding chunking thresholds (multi-vector embeddings).
 *
 * The embedder (e.g. Xenova/bge-base-en-v1.5) only encodes ~512 tokens, so a
 * memory longer than roughly the window has its tail dropped from a single
 * vector and is invisible to vector search. Content over the window is split
 * into overlapping chunks and embedded separately. Chars are a deterministic
 * ~4-chars/token proxy (well under 512 tokens/chunk for tokenizer headroom).
 *
 * Shared by the worker chunker (`connector-worker/embeddings-text`) and the
 * server's "needs (re)embedding" stale rule (`server/utils/embeddings`) so the
 * split threshold and the detection threshold can never drift apart.
 */
export const EMBEDDING_MODEL_WINDOW_CHARS = 2000;
export const EMBEDDING_CHUNK_CHARS = 1600;
export const EMBEDDING_CHUNK_OVERLAP_CHARS = 160;
/** Hard cap on chunks per memory (~100KB folded into the last chunk at 64). */
export const EMBEDDING_MAX_CHUNKS_PER_EVENT = 64;
