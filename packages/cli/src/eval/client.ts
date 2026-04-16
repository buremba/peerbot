/**
 * Lobu API client for eval runner.
 * Extracted from chat.ts patterns — collects responses into buffers instead of streaming to stdout.
 */

interface Session {
  agentId: string;
  token: string;
  base: string;
}

export interface CollectedResponse {
  text: string;
  latencyMs: number;
  error?: string;
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  traceId?: string;
}

export async function createSession(
  gatewayUrl: string,
  authToken: string,
  opts?: {
    agentId?: string;
    thread?: string;
    forceNew?: boolean;
    dryRun?: boolean;
    provider?: string;
    model?: string;
  }
): Promise<Session> {
  const body: Record<string, unknown> = {
    forceNew: opts?.forceNew ?? true,
    dryRun: opts?.dryRun ?? true,
  };
  if (opts?.agentId) body.agentId = opts.agentId;
  if (opts?.thread) body.thread = opts.thread;
  if (opts?.provider) body.provider = opts.provider;
  if (opts?.model) body.model = opts.model;

  const res = await fetch(`${gatewayUrl}/api/v1/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create session (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { agentId: string; token: string };
  return {
    agentId: data.agentId,
    token: data.token,
    base: `${gatewayUrl}/api/v1/agents/${data.agentId}`,
  };
}

export async function sendMessage(
  session: Session,
  content: string
): Promise<{ traceId?: string; messageId?: string }> {
  const res = await fetch(`${session.base}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
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
  // Extract trace ID from W3C traceparent: "00-{traceId}-{spanId}-01"
  const traceId = data.traceparent?.split("-")[1];
  return { traceId, messageId: data.messageId };
}

/**
 * Connect to SSE stream and collect the full response text.
 * Accumulates 'output' deltas until 'complete' event for the target messageId.
 *
 * When `messageId` is provided, events for other messageIds are ignored. This
 * prevents SSE backlog replay from prior turns in the same session from being
 * misread as the current turn's response.
 */
export async function collectResponse(
  session: Session,
  timeoutMs: number,
  messageId?: string
): Promise<CollectedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await fetch(`${session.base}/events`, {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE connection failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let text = "";

    const matchesTarget = (eventMessageId: unknown): boolean => {
      if (!messageId) return true;
      return typeof eventMessageId === "string" && eventMessageId === messageId;
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
            case "complete": {
              if (!matchesTarget(data.messageId)) break;
              const usage = data.usage as Record<string, number> | undefined;
              return {
                text,
                latencyMs: Date.now() - start,
                tokens: usage
                  ? {
                      inputTokens: usage.input_tokens ?? usage.inputTokens,
                      outputTokens: usage.output_tokens ?? usage.outputTokens,
                      totalTokens:
                        (usage.input_tokens ?? usage.inputTokens ?? 0) +
                        (usage.output_tokens ?? usage.outputTokens ?? 0),
                    }
                  : undefined,
              };
            }
            case "error":
              if (!matchesTarget(data.messageId)) break;
              return {
                text,
                latencyMs: Date.now() - start,
                error: String(data.error ?? "Unknown error"),
              };
          }
          currentEvent = "";
        } else if (line === "") {
          currentEvent = "";
        }
      }
    }

    return { text, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { text: "", latencyMs: Date.now() - start, error: "Timeout" };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteSession(session: Session): Promise<void> {
  await fetch(`${session.base}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${session.token}` },
  }).catch(() => {
    // Best-effort cleanup — ignore failures
  });
}

/**
 * Send a message and collect the full response in one call.
 *
 * Sends first to capture the gateway-issued messageId, then opens the SSE
 * stream filtered to that messageId. The gateway's SSE endpoint replays a
 * recent event backlog on connect, so no output deltas are lost between the
 * POST and the SSE subscribe.
 */
export async function sendAndCollect(
  session: Session,
  content: string,
  timeoutMs: number
): Promise<CollectedResponse> {
  const { traceId, messageId } = await sendMessage(session, content);
  const response = await collectResponse(session, timeoutMs, messageId);
  response.traceId = traceId;
  return response;
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
