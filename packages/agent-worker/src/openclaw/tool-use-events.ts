/**
 * Helpers for surfacing tool-call traces from worker → gateway → SSE clients.
 *
 * Workers emit a `tool_use` custom event per `tool_execution_end` so any SSE
 * subscriber (the @lobu/promptfoo-provider, the Mac menubar, the CLI eval) can
 * inspect tool calls without having to scrape worker logs. The shape mirrors
 * Anthropic's tool-use block (name + input) plus a `result_summary` field for
 * structured, tool-specific metadata that's small enough to ship over SSE.
 *
 * For retrieval tools (`search_memory` / `lobu_search_memory`) we extract the
 * matched event IDs and the snippet text content so promptfoo RAG assertions
 * (`context-recall`, `context-faithfulness`, custom `javascript`) can join the
 * agent's answer back to the retrieved evidence.
 */

export interface ToolUseEventPayload {
  toolCallId: string;
  name: string;
  input: unknown;
  isError: boolean;
  result_summary?: ToolUseResultSummary;
}

export interface ToolUseResultSummary {
  /** Event IDs the tool returned (search_memory etc). */
  event_ids?: number[];
  /** Inline snippet text keyed by event id — populated by retrieval tools so
   * provider clients can compute `retrievedContext` without a round-trip. */
  snippets?: Array<{ id: number; text: string }>;
  /** Tools may also include a short error string. */
  error?: string;
}

const SEARCH_MEMORY_TOOL_NAMES = new Set([
  "search_memory",
  "lobu_search_memory",
]);

/**
 * Build the SSE payload for a `tool_execution_end` pi-agent event.
 *
 * Always returns a record — even on parse failure — so the SSE event reliably
 * fires for every tool call. `result_summary` is best-effort: tool-specific
 * shape parsing is wrapped in try/catch and a parse failure just leaves the
 * summary off, never throws.
 */
export function buildToolUseEventPayload(event: {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result: unknown;
  isError: boolean;
}): ToolUseEventPayload {
  const payload: ToolUseEventPayload = {
    toolCallId: event.toolCallId,
    name: event.toolName,
    input: event.args ?? null,
    isError: event.isError === true,
  };

  if (event.isError) {
    const message = extractErrorMessage(event.result);
    if (message) {
      payload.result_summary = { error: message };
    }
    return payload;
  }

  if (SEARCH_MEMORY_TOOL_NAMES.has(event.toolName)) {
    const summary = summarizeSearchMemoryResult(event.result);
    if (summary) {
      payload.result_summary = summary;
    }
  }

  return payload;
}

function summarizeSearchMemoryResult(
  raw: unknown
): ToolUseResultSummary | null {
  const result = extractSearchMemoryBody(raw);
  if (!result || typeof result !== "object") return null;

  const summary: ToolUseResultSummary = {};
  const contentArr = (result as { content?: unknown }).content;
  if (Array.isArray(contentArr) && contentArr.length > 0) {
    const ids: number[] = [];
    const snippets: Array<{ id: number; text: string }> = [];
    for (const snippet of contentArr) {
      if (!snippet || typeof snippet !== "object") continue;
      const idVal = (snippet as { id?: unknown }).id;
      const textVal = (snippet as { text_content?: unknown }).text_content;
      if (typeof idVal !== "number") continue;
      ids.push(idVal);
      if (typeof textVal === "string" && textVal.length > 0) {
        snippets.push({ id: idVal, text: textVal });
      }
    }
    if (ids.length > 0) summary.event_ids = ids;
    if (snippets.length > 0) summary.snippets = snippets;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

/**
 * MCP tool results from the gateway proxy land here as
 *   { content: [{ type: 'text', text: '<json>' }], isError: false }
 * but in-process tools sometimes pass the raw object straight through. Handle
 * both shapes.
 */
function extractSearchMemoryBody(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return null;

  // MCP CallToolResult shape — text content holds a JSON-stringified payload.
  const mcpContent = (raw as { content?: unknown }).content;
  if (Array.isArray(mcpContent)) {
    for (const part of mcpContent) {
      if (!part || typeof part !== "object") continue;
      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;
      if (type === "text" && typeof text === "string") {
        try {
          return JSON.parse(text);
        } catch {
          // Plain text result — nothing to summarise.
          return null;
        }
      }
    }
  }

  // Already the search_memory body.
  return raw;
}

function extractErrorMessage(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;
  const msg = (result as { message?: unknown }).message;
  if (typeof msg === "string") return msg;
  const err = (result as { error?: unknown }).error;
  if (typeof err === "string") return err;
  return null;
}
