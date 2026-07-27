/**
 * Shared parser for Lobu runtime `session.jsonl` files.
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
    content?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
    /**
     * `bashExecution` messages (pi's `!command` records) carry their payload
     * directly on `message` rather than in `content` — see pi's
     * `BashExecutionMessage` / `recordBashResult`. These fields are only
     * present when `role === "bashExecution"`.
     */
    command?: string;
    output?: string;
    exitCode?: number;
    cancelled?: boolean;
    truncated?: boolean;
    fullOutputPath?: string;
    excludeFromContext?: boolean;
  };
  summary?: string;
  provider?: string;
  modelId?: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
}

/**
 * The set of `type` discriminants a {@link ParsedMessage} can carry. Kept as a
 * closed union so API consumers (and the typed client) can exhaustively switch
 * on it. `bashExecution` projects pi's `!command` records — the command and its
 * output, so a `!`-bash turn survives a page reload.
 */
export type ParsedMessageType =
  | "message"
  | "compaction"
  | "model_change"
  | "custom_message"
  | "bashExecution";

/**
 * Structured `content` for a `bashExecution` {@link ParsedMessage}. `exitCode`
 * is `undefined` while a command is still running / was cancelled before exit.
 * `excludeFromContext` mirrors pi's `!!` (hidden-from-model) flag — it does NOT
 * hide the record from the transcript.
 */
export interface BashExecutionContent {
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  excludeFromContext?: boolean;
  fullOutputPath?: string;
}

/** Display-friendly projection emitted to API consumers (`/session/messages`). */
export interface ParsedMessage {
  id: string;
  type: ParsedMessageType;
  role?: string;
  content: unknown;
  model?: string;
  timestamp: string;
  isVerbose?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
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
 * A `message` entry whose inner `role` is `bashExecution` (pi's `!command`
 * record) is projected as a `bashExecution` message with a structured
 * {@link BashExecutionContent} payload, so a `!`-bash turn survives reload.
 *
 * `isVerbose` marks entries the UI hides behind a "verbose" toggle —
 * tool results, compaction/model-change markers, custom system events
 * that aren't explicitly displayed. A `bashExecution` record is never
 * verbose: even `!!` (`excludeFromContext: true`) is hidden only from the
 * model's context, not from the transcript.
 */
export function entryToMessage(entry: SessionEntry): ParsedMessage | null {
  if (entry.type === "message" && entry.message?.role === "bashExecution") {
    const m = entry.message;
    const content: BashExecutionContent = {
      command: m.command ?? "",
      output: m.output ?? "",
      exitCode: m.exitCode,
      cancelled: m.cancelled ?? false,
      truncated: m.truncated ?? false,
      excludeFromContext: m.excludeFromContext,
      fullOutputPath: m.fullOutputPath,
    };
    return {
      id: entry.id,
      type: "bashExecution",
      role: "bashExecution",
      content,
      timestamp: entry.timestamp,
      isVerbose: false,
    };
  }
  if (entry.type === "message" && entry.message) {
    return {
      id: entry.id,
      type: "message",
      role: entry.message.role,
      // Only the user turn carries the worker's run-context scaffolding.
      content:
        entry.message.role === "user"
          ? stripRunContextFromContent(entry.message.content)
          : entry.message.content,
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

/**
 * The worker prepends a per-run context block to the USER turn (see
 * `buildRunContextBlock` in agent-worker): a `## This conversation` heading
 * followed by `- Key: value` lines, then a blank line, then what the user
 * actually typed. It is prompt scaffolding for the model — the person never
 * wrote it — but it IS part of the stored transcript.
 *
 * Live turns render from the SSE echo (the user's own text) so it never shows;
 * a RELOAD replays the transcript, and without this strip the block rendered
 * verbatim above every user message as a stray markdown heading. Strip it on
 * the way out so replay matches what the user typed.
 *
 * Deliberately conservative: only a block at the very START, only the exact
 * heading, and only through the first blank line. A user message that merely
 * contains that text later is untouched.
 */
const RUN_CONTEXT_BLOCK = /^## This conversation\n(?:-[^\n]*\n)*(?:\n+|$)/;

export function stripRunContextBlock(text: string): string {
  return text.replace(RUN_CONTEXT_BLOCK, "");
}

/**
 * Apply {@link stripRunContextBlock} to a message `content` payload, preserving
 * its shape: a bare string, or the `[{type:"text", text}, …]` part array the
 * transcript stores. Only the FIRST text part can carry the block (it is a
 * prefix of the whole turn), so later parts are left alone. Non-text content
 * (images, tool calls) passes through untouched.
 */
export function stripRunContextFromContent(content: unknown): unknown {
  if (typeof content === "string") return stripRunContextBlock(content);
  if (!Array.isArray(content)) return content;
  let stripped = false;
  return content.map((part) => {
    if (stripped) return part;
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: string }).text === "string"
    ) {
      stripped = true;
      return {
        ...(part as Record<string, unknown>),
        text: stripRunContextBlock((part as { text: string }).text),
      };
    }
    return part;
  });
}

/**
 * Thread list title: first user message text, truncated. No LLM inference —
 * the UI shows this until/unless we add an explicit title field on write.
 */
export function titleFromSessionJsonl(
  jsonl: string,
  fallback: string,
  maxLen = 42
): string {
  const { entries } = parseSessionEntries(jsonl);
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: string }).text === "string"
        ) {
          text = (part as { text: string }).text;
          break;
        }
      }
    }
    // Strip the worker's run-context block first: otherwise every derived title
    // reads "## This conversation - Platform: api - Channel: …" instead of what
    // the user asked.
    const normalized = stripRunContextBlock(text).replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    return normalized.length > maxLen
      ? `${normalized.slice(0, maxLen)}…`
      : normalized;
  }
  return fallback;
}
