/**
 * Starter-chip cache (`agent_starters`) — one live row per agent+org.
 *
 * Starters are a derived, disposable cache, not conversation history, so they
 * do NOT live on the append-only `events` substrate that backs per-conversation
 * suggestion chips: there is exactly one current value per (org, agent), it is
 * read by a single lookup, and every regeneration replaces the previous one. An
 * upsert expresses that directly; the message-bound durable lease below orders
 * competing generations across replicas.
 */
import { type SuggestedPrompt, sanitizeSuggestionPrompts } from "@lobu/core";
import type { DbClient } from "../../db/client.js";
import { getDb } from "../../db/client.js";

export const STARTERS_LEASE_PREFIX = "starter-generation";

export interface CachedStarters {
  prompts: SuggestedPrompt[];
  generatedAt: Date;
  failedAt: Date | null;
}

/**
 * Minimum age before an otherwise-stale cache is regenerated.
 *
 * The endpoint is read on every fresh-chat landing. This interval keeps those
 * reads from dispatching a hidden LLM turn more than once per agent per window.
 */
export const STARTERS_MIN_AGE_MS = 6 * 60 * 60 * 1000; // 6h

/** Back-off after a generation that produced no usable chips. */
export const STARTERS_FAILURE_BACKOFF_MS = 60 * 60 * 1000; // 1h

/** Read the cached starter set for an agent+org, or null when never generated. */
export async function readCachedStarters(
  organizationId: string,
  agentId: string,
  sql: DbClient = getDb(),
): Promise<CachedStarters | null> {
  const rows = (await sql`
    SELECT prompts, generated_at, failed_at
    FROM public.agent_starters
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
  `) as Array<{
    prompts: unknown;
    generated_at: Date;
    failed_at: Date | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    prompts: sanitizeSuggestionPrompts(row.prompts),
    generatedAt: row.generated_at,
    failedAt: row.failed_at,
  };
}

/**
 * Replace the agent+org starter set. `prompts` is stored as given (already
 * sanitized by the caller); an empty array records a failed generation so the
 * next landing backs off instead of redispatching immediately.
 */
export async function writeCachedStarters(args: {
  organizationId: string;
  agentId: string;
  prompts: SuggestedPrompt[];
  sql?: DbClient;
}): Promise<void> {
  const { organizationId, agentId, prompts } = args;
  const sql = args.sql ?? getDb();
  const failed = prompts.length === 0;
  await sql`
    INSERT INTO public.agent_starters (
      organization_id, agent_id, prompts, generated_at, failed_at
    ) VALUES (
      ${organizationId}, ${agentId}, ${sql.json(prompts)}, now(),
      ${failed ? sql`now()` : null}
    )
    ON CONFLICT (organization_id, agent_id) DO UPDATE
      SET prompts = EXCLUDED.prompts,
          generated_at = EXCLUDED.generated_at,
          failed_at = EXCLUDED.failed_at
  `;
}

/**
 * Finish the hidden turn that currently owns the generation lease.
 *
 * The lease token is the turn's signed message id. Deleting it and writing the
 * result in one transaction prevents a late terminal or tool call from an
 * expired turn from overwriting a newer generation. An empty result records a
 * failed generation so the endpoint stops polling and observes the back-off.
 */
export async function finalizeStarterGeneration(args: {
  organizationId: string;
  agentId: string;
  messageId: string;
  prompts: SuggestedPrompt[];
}): Promise<boolean> {
  const { organizationId, agentId, messageId, prompts } = args;
  const leaseKey = `${organizationId}:${agentId}`;
  return getDb().begin(async (tx) => {
    const released = await tx<{ token: string }>`
      DELETE FROM chat_state_locks
      WHERE key_prefix = ${STARTERS_LEASE_PREFIX}
        AND thread_id = ${leaseKey}
        AND token = ${messageId}
      RETURNING token
    `;
    if (released.length === 0) return false;
    await writeCachedStarters({
      organizationId,
      agentId,
      prompts,
      sql: tx,
    });
    return true;
  });
}

/**
 * Should a fresh generation be dispatched?
 *
 * Never generated → yes. Otherwise refresh only once the cache has aged past
 * the minimum interval, and only once a failed generation has served its
 * back-off.
 */
export function shouldRegenerate(
  cached: CachedStarters | null,
  now: number = Date.now(),
): boolean {
  if (!cached) return true;
  if (cached.failedAt) {
    return now - cached.failedAt.getTime() >= STARTERS_FAILURE_BACKOFF_MS;
  }
  if (cached.prompts.length === 0) return true;
  return now - cached.generatedAt.getTime() >= STARTERS_MIN_AGE_MS;
}
