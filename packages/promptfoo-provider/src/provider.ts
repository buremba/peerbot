import { randomUUID } from "node:crypto";

export interface LobuProviderConfig {
  /** Agent ID registered on the gateway. Defaults to `LOBU_AGENT` env. */
  agent?: string;
  /** Gateway base URL — e.g. `http://localhost:8787`. Defaults to `LOBU_GATEWAY`. */
  gateway?: string;
  /** Bearer token for the gateway. Defaults to `LOBU_TOKEN`. */
  token?: string;
  /** Optional provider override sent to the gateway when creating the session. */
  provider?: string;
  /** Optional model override sent to the gateway when creating the session. */
  model?: string;
  /** Per-call timeout in ms. Defaults to 120s. */
  timeoutMs?: number;
  /** Re-use a thread instead of creating one per call. Mostly for debugging. */
  thread?: string;
}

/**
 * Structured tool-call trace surfaced by the gateway's `tool_use` SSE event.
 * Mirrors Anthropic's tool-use block plus an optional `result_summary` field
 * that retrieval tools (`search_memory`) populate so client code can compute
 * `retrievedContext` without a round-trip back to the server.
 */
export interface LobuToolCall {
  toolCallId?: string;
  name: string;
  input: unknown;
  isError?: boolean;
  result_summary?: {
    event_ids?: number[];
    snippets?: Array<{ id: number; text: string }>;
    error?: string;
  };
}

export interface LobuProviderResponse {
  output: string;
  tokenUsage?: {
    total?: number;
    prompt?: number;
    completion?: number;
  };
  cost?: number;
  error?: string;
  metadata: {
    agent: string;
    traceId?: string;
    thread: string;
    /** Tool calls observed during the turn, in order. */
    toolCalls?: LobuToolCall[];
    /**
     * Concatenated text content of events returned by retrieval tools
     * (currently `search_memory`). Useful as `contextTransform:
     * 'metadata.retrievedContext'` for promptfoo's `context-recall` /
     * `context-faithfulness` assertions.
     */
    retrievedContext?: string;
  };
}

interface PromptfooContext {
  vars?: Record<string, unknown>;
  prompt?: { raw?: string };
}

interface CollectedResponse {
  text: string;
  latencyMs: number;
  error?: string;
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  traceId?: string;
  toolCalls?: LobuToolCall[];
  retrievedContext?: string;
}

const RETRIEVAL_TOOL_NAMES = new Set(["search_memory", "lobu_search_memory"]);

/**
 * promptfoo custom provider that drives a Lobu agent end-to-end via the
 * gateway's public Agent API:
 *
 *   POST   {gateway}/lobu/api/v1/agents                  → create session
 *   POST   {gateway}/lobu/api/v1/agents/<id>/messages    → send user message
 *   GET    {gateway}/lobu/api/v1/agents/<id>/events      → SSE stream of output
 *   DELETE {gateway}/lobu/api/v1/agents/<id>             → cleanup
 *
 * One fresh thread per `callApi` invocation by default so promptfoo's repeat /
 * scenario semantics see a clean slate. Tool-call traces are surfaced via the
 * gateway's `tool_use` SSE event and populated on `metadata.toolCalls`. For
 * retrieval tools (`search_memory`) the joined snippet text is also exposed as
 * `metadata.retrievedContext` for promptfoo's RAG assertions.
 */
export class LobuProvider {
  private readonly agent: string;
  private readonly gateway: string;
  private readonly token: string;
  private readonly providerOverride: string | undefined;
  private readonly modelOverride: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly explicitThread: string | undefined;

  constructor(options: { id?: string; config?: LobuProviderConfig } = {}) {
    const cfg = options.config ?? {};
    const agent = cfg.agent ?? process.env.LOBU_AGENT;
    const gateway =
      cfg.gateway ?? process.env.LOBU_GATEWAY ?? "http://localhost:8787";
    const token = cfg.token ?? process.env.LOBU_TOKEN;

    if (!agent) {
      throw new Error(
        "@lobu/promptfoo-provider: missing agent. Set providers[].config.agent or LOBU_AGENT."
      );
    }
    if (!token) {
      throw new Error(
        "@lobu/promptfoo-provider: missing token. Set providers[].config.token or LOBU_TOKEN."
      );
    }

    this.agent = agent;
    this.gateway = gateway.replace(/\/+$/, "");
    this.token = token;
    this.providerOverride = cfg.provider;
    this.modelOverride = cfg.model;
    this.defaultTimeoutMs = cfg.timeoutMs ?? 120_000;
    this.explicitThread = cfg.thread;
  }

  id(): string {
    return `lobu:${this.agent}`;
  }

  async callApi(
    prompt: string,
    _context?: PromptfooContext
  ): Promise<LobuProviderResponse> {
    const thread = this.explicitThread ?? `promptfoo-${randomUUID()}`;
    const session = await this.createSession(thread);

    try {
      const response = await this.sendAndCollect(
        session,
        prompt,
        this.defaultTimeoutMs
      );

      if (response.error) {
        return {
          output: response.text,
          error: response.error,
          metadata: {
            agent: this.agent,
            thread,
            traceId: response.traceId,
          },
        };
      }

      return {
        output: response.text,
        tokenUsage: response.tokens
          ? {
              prompt: response.tokens.inputTokens,
              completion: response.tokens.outputTokens,
              total: response.tokens.totalTokens,
            }
          : undefined,
        metadata: {
          agent: this.agent,
          thread,
          traceId: response.traceId,
          ...(response.toolCalls && response.toolCalls.length > 0
            ? { toolCalls: response.toolCalls }
            : {}),
          ...(response.retrievedContext
            ? { retrievedContext: response.retrievedContext }
            : {}),
        },
      };
    } finally {
      await this.deleteSession(session);
    }
  }

  // ─── internals: gateway protocol ────────────────────────────────────────

  private async createSession(thread: string): Promise<Session> {
    const body: Record<string, unknown> = {
      agentId: this.agent,
      thread,
      forceNew: true,
      dryRun: true,
    };
    if (this.providerOverride) body.provider = this.providerOverride;
    if (this.modelOverride) body.model = this.modelOverride;

    const res = await fetch(`${this.gateway}/lobu/api/v1/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to create Lobu session (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { agentId: string; token: string };
    return {
      agentId: data.agentId,
      sessionToken: data.token,
      // Public Agent API is mounted at /lobu (mainApp serves org-scoped REST
      // at /). See packages/server/src/server.ts.
      base: `${this.gateway}/lobu/api/v1/agents/${data.agentId}`,
    };
  }

  private async sendMessage(
    session: Session,
    content: string
  ): Promise<{ traceId?: string; messageId?: string }> {
    const res = await fetch(`${session.base}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.sessionToken}`,
      },
      body: JSON.stringify({ content }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to send message (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      traceparent?: string;
      messageId?: string;
    };
    const traceId = data.traceparent?.split("-")[1];
    return { traceId, messageId: data.messageId };
  }

  private async collectResponse(
    session: Session,
    timeoutMs: number,
    messageId?: string
  ): Promise<CollectedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    let readerForCleanup:
      | { cancel(reason?: unknown): Promise<void> }
      | undefined;

    try {
      const res = await fetch(`${session.base}/events`, {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed (${res.status})`);
      }

      const reader = res.body.getReader();
      readerForCleanup = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let text = "";
      const toolCalls: LobuToolCall[] = [];
      const retrievedSnippets: Array<{ id: number; text: string }> = [];
      const seenSnippetIds = new Set<number>();

      const matchesTarget = (eventMessageId: unknown): boolean => {
        if (!messageId) return true;
        return (
          typeof eventMessageId === "string" && eventMessageId === messageId
        );
      };

      const finalize = (
        extra: Partial<CollectedResponse> = {}
      ): CollectedResponse => {
        const result: CollectedResponse = {
          text,
          latencyMs: Date.now() - start,
          ...extra,
        };
        if (toolCalls.length > 0) result.toolCalls = toolCalls;
        if (retrievedSnippets.length > 0) {
          result.retrievedContext = retrievedSnippets
            .map((s) => s.text)
            .join("\n\n");
        }
        return result;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent) {
            const data = parseJSON(line.slice(6));
            if (!data) continue;

            switch (currentEvent) {
              case "output":
                if (
                  typeof data.content === "string" &&
                  matchesTarget(data.messageId)
                ) {
                  text += data.content;
                }
                break;
              case "tool_use": {
                if (!matchesTarget(data.messageId)) break;
                const call = normaliseToolUseEvent(data);
                if (!call) break;
                toolCalls.push(call);
                if (
                  RETRIEVAL_TOOL_NAMES.has(call.name) &&
                  call.result_summary?.snippets
                ) {
                  for (const snippet of call.result_summary.snippets) {
                    if (seenSnippetIds.has(snippet.id)) continue;
                    seenSnippetIds.add(snippet.id);
                    retrievedSnippets.push(snippet);
                  }
                }
                break;
              }
              case "complete": {
                if (!matchesTarget(data.messageId)) break;
                const usage = data.usage as Record<string, number> | undefined;
                return finalize({
                  tokens: usage
                    ? {
                        inputTokens: usage.input_tokens ?? usage.inputTokens,
                        outputTokens: usage.output_tokens ?? usage.outputTokens,
                        totalTokens:
                          (usage.input_tokens ?? usage.inputTokens ?? 0) +
                          (usage.output_tokens ?? usage.outputTokens ?? 0),
                      }
                    : undefined,
                });
              }
              case "error":
                if (!matchesTarget(data.messageId)) break;
                return finalize({
                  error: String(data.error ?? "Unknown error"),
                });
            }
            currentEvent = "";
          } else if (line === "") {
            currentEvent = "";
          }
        }
      }

      return finalize();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return { text: "", latencyMs: Date.now() - start, error: "Timeout" };
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (readerForCleanup) {
        await readerForCleanup.cancel().catch(() => undefined);
      }
    }
  }

  private async sendAndCollect(
    session: Session,
    content: string,
    timeoutMs: number
  ): Promise<CollectedResponse> {
    const { traceId, messageId } = await this.sendMessage(session, content);
    const response = await this.collectResponse(session, timeoutMs, messageId);
    response.traceId = traceId;
    return response;
  }

  private async deleteSession(session: Session): Promise<void> {
    await fetch(`${session.base}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    }).catch(() => undefined);
  }
}

interface Session {
  agentId: string;
  sessionToken: string;
  base: string;
}

function parseJSON(str: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(str);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function normaliseToolUseEvent(
  data: Record<string, unknown>
): LobuToolCall | null {
  const name = data.name;
  if (typeof name !== "string" || !name) return null;
  const call: LobuToolCall = {
    name,
    input: data.input ?? null,
  };
  if (typeof data.toolCallId === "string") call.toolCallId = data.toolCallId;
  if (data.isError === true) call.isError = true;
  const summary = data.result_summary;
  if (summary && typeof summary === "object") {
    const parsed: NonNullable<LobuToolCall["result_summary"]> = {};
    const ids = (summary as { event_ids?: unknown }).event_ids;
    if (Array.isArray(ids)) {
      const numeric = ids.filter((id): id is number => typeof id === "number");
      if (numeric.length > 0) parsed.event_ids = numeric;
    }
    const snippetsRaw = (summary as { snippets?: unknown }).snippets;
    if (Array.isArray(snippetsRaw)) {
      const snippets: Array<{ id: number; text: string }> = [];
      for (const item of snippetsRaw) {
        if (!item || typeof item !== "object") continue;
        const id = (item as { id?: unknown }).id;
        const text = (item as { text?: unknown }).text;
        if (typeof id === "number" && typeof text === "string") {
          snippets.push({ id, text });
        }
      }
      if (snippets.length > 0) parsed.snippets = snippets;
    }
    const errorMsg = (summary as { error?: unknown }).error;
    if (typeof errorMsg === "string") parsed.error = errorMsg;
    if (Object.keys(parsed).length > 0) call.result_summary = parsed;
  }
  return call;
}
