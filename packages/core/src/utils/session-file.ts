/**
 * Shared parser for OpenClaw `session.jsonl` files.
 *
 * Two HTTP surfaces read these files: the worker's `/session/messages` /
 * `/session/stats` endpoints (rooted at the worker's own `WORKSPACE_DIR`)
 * and the gateway's `/session/messages` / `/session/stats` REST endpoints
 * (rooted at the gateway's `workspaces/<agentId>` tree, queried when the
 * worker is offline). The gateway proxies to the worker when it's online
 * and falls back to its own copy otherwise — so the two parsers must
 * agree, and historically they had drifted (different fields kept on
 * `SessionEntry`, different `JSON.parse` error handling, the same logic
 * copy-pasted twice).
 *
 * Anything path-policy related (where to *look* for the file) stays at
 * the call site — the worker scans one level under `WORKSPACE_DIR`; the
 * gateway scans up to three levels under the per-agent workspace dir
 * with a `SAFE_AGENT_ID` regex guarding the join. Those are intentionally
 * different and must not be collapsed without an operator decision.
 */

import { safeJsonParse } from "./json";

/**
 * Token usage stamped on each assistant message, mirroring pi-ai's `Usage`
 * shape exactly as written to disk. The four token buckets are kept distinct
 * on purpose — cache-read is ~10x cheaper than uncached input, so collapsing
 * them into a single number throws away the dominant accuracy lever for cost.
 * `cost` is pi's own flat-priced estimate written at message time; cost
 * accounting recomputes USD from the token buckets but keeps this for display.
 */
export interface SessionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

/**
 * Raw entry shape as written to `session.jsonl` by the worker.
 *
 * `tokensBefore` / `firstKeptEntryId` (worker memory-flush bookkeeping)
 * are not read by either parser today — left off this canonical shape on
 * purpose; reintroduce when a consumer actually needs them.
 */
export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role: string;
    content: unknown;
    /** Provider API flavor written by the worker, e.g. "openai-completions". */
    api?: string;
    /** Provider id stamped on each assistant message, e.g. "zai", "anthropic". */
    provider?: string;
    /** Model id stamped on each assistant message, e.g. "glm-4.6". */
    model?: string;
    usage?: SessionUsage;
  };
  summary?: string;
  provider?: string;
  modelId?: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
}

/** Display-friendly projection emitted to API consumers (`/session/messages`). */
export interface ParsedMessage {
  id: string;
  type: string;
  role?: string;
  content: unknown;
  model?: string;
  timestamp: string;
  isVerbose?: boolean;
  usage?: SessionUsage;
}

/**
 * Parse a session.jsonl blob into entries + the synthetic session id
 * found on the leading `{type: "session", id}` line.
 *
 * - Splits on `\n` and skips blank lines (same as both pre-existing copies).
 * - Uses {@link safeJsonParse} so malformed lines are skipped quietly with
 *   a debug log (debug-only because production sessions occasionally
 *   contain partial writes after crash/kill).
 * - The leading `session` entry is extracted, not pushed into `entries`.
 */
export function parseSessionEntries(content: string): {
  entries: SessionEntry[];
  sessionId?: string;
} {
  const lines = content.split("\n").filter((l) => l.trim());
  const entries: SessionEntry[] = [];
  let sessionId: string | undefined;
  for (const line of lines) {
    const parsed = safeJsonParse<SessionEntry & { id: string }>(line);
    if (!parsed) continue;
    if (parsed.type === "session") {
      sessionId = parsed.id;
      continue;
    }
    entries.push(parsed);
  }
  return { entries, sessionId };
}

/**
 * Project a single {@link SessionEntry} into the {@link ParsedMessage}
 * display shape, or `null` for entry kinds that don't surface as
 * user-visible messages (everything other than `message`, `compaction`,
 * `model_change`, `custom_message`).
 *
 * `isVerbose` marks entries the UI hides behind a "verbose" toggle —
 * tool results, compaction/model-change markers, custom system events
 * that aren't explicitly displayed.
 */
export function entryToMessage(entry: SessionEntry): ParsedMessage | null {
  if (entry.type === "message" && entry.message) {
    const { provider, model } = entry.message;
    return {
      id: entry.id,
      type: "message",
      role: entry.message.role,
      content: entry.message.content,
      model: model ? (provider ? `${provider}/${model}` : model) : undefined,
      timestamp: entry.timestamp,
      isVerbose: entry.message.role === "toolResult",
      usage: entry.message.usage,
    };
  }
  if (entry.type === "compaction") {
    return {
      id: entry.id,
      type: "compaction",
      content: entry.summary || "",
      timestamp: entry.timestamp,
      isVerbose: true,
    };
  }
  if (entry.type === "model_change") {
    return {
      id: entry.id,
      type: "model_change",
      content: `${entry.provider}/${entry.modelId}`,
      model: `${entry.provider}/${entry.modelId}`,
      timestamp: entry.timestamp,
      isVerbose: true,
    };
  }
  if (entry.type === "custom_message") {
    return {
      id: entry.id,
      type: "custom_message",
      role: "user",
      content: entry.content,
      timestamp: entry.timestamp,
      isVerbose: !entry.display,
    };
  }
  return null;
}

/** Aggregate token/cost stats over a parsed session, shared by both
 * `/session/stats` surfaces (worker + gateway) so they can't drift. */
export interface SessionStats {
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** pi's flat-priced per-message cost summed across the session (display
   * only; authoritative cost accounting recomputes from the token buckets). */
  totalCostUsd: number;
  /** Last model actually used — taken from the per-message `model` stamp and
   * any `model_change` markers, in chronological order. */
  currentModel?: string;
}

/**
 * Fold a parsed session into {@link SessionStats}.
 *
 * Reads pi-ai's real on-disk field names (`input`/`output`/`cacheRead`/
 * `cacheWrite`), not the legacy `inputTokens`/`outputTokens` that never
 * actually existed on disk. `currentModel` now tracks the per-message model
 * stamp too, so a session with no mid-run `model_change` still reports the
 * model it ran on (the old code left it undefined until a switch happened).
 */
export function computeSessionStats(entries: SessionEntry[]): SessionStats {
  const stats: SessionStats = {
    messageCount: 0,
    userMessages: 0,
    assistantMessages: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCostUsd: 0,
  };
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      stats.messageCount++;
      if (entry.message.role === "user") stats.userMessages++;
      if (entry.message.role === "assistant") {
        stats.assistantMessages++;
        const { provider, model } = entry.message;
        if (model) {
          stats.currentModel = provider ? `${provider}/${model}` : model;
        }
      }
      const u = entry.message.usage;
      if (u) {
        stats.totalInputTokens += u.input ?? 0;
        stats.totalOutputTokens += u.output ?? 0;
        stats.totalCacheReadTokens += u.cacheRead ?? 0;
        stats.totalCacheWriteTokens += u.cacheWrite ?? 0;
        stats.totalCostUsd += u.cost?.total ?? 0;
      }
    }
    if (entry.type === "model_change") {
      stats.currentModel = `${entry.provider}/${entry.modelId}`;
    }
  }
  return stats;
}

/** One model's summed usage within a session — the unit cost is priced on.
 * Only assistant messages carry usage. */
export interface ModelUsageAggregate {
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** pi's flat on-disk cost summed across this model's messages (reference). */
  piCostUsd: number;
}

/**
 * Group assistant-message usage by (provider, model). A transcript holds a
 * single provider (a provider switch resets session.jsonl), but the model can
 * change within a provider, so cost is summed per distinct model rather than
 * pricing the whole run at the last model — which would mis-price a run that
 * swapped between a cheap and an expensive same-provider model mid-session.
 */
export function aggregateUsageByModel(
  entries: SessionEntry[]
): ModelUsageAggregate[] {
  const byModel = new Map<string, ModelUsageAggregate>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") {
      continue;
    }
    const u = entry.message.usage;
    if (!u) continue;
    const { provider, model } = entry.message;
    const key = JSON.stringify([provider ?? null, model ?? null]);
    let agg = byModel.get(key);
    if (!agg) {
      agg = {
        provider,
        model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        piCostUsd: 0,
      };
      byModel.set(key, agg);
    }
    agg.input += u.input ?? 0;
    agg.output += u.output ?? 0;
    agg.cacheRead += u.cacheRead ?? 0;
    agg.cacheWrite += u.cacheWrite ?? 0;
    agg.piCostUsd += u.cost?.total ?? 0;
  }
  return [...byModel.values()];
}
