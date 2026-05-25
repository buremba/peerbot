export class LobuApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly response: Response;

  constructor(response: Response, body: unknown) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Lobu API request failed with ${response.status}`;
    super(message);
    this.name = "LobuApiError";
    this.status = response.status;
    this.body = body;
    this.response = response;
  }
}

/**
 * Thrown by {@link AgentSession.ask} when the agent reports an error for the
 * message being awaited (an `error`/`agent-error` SSE event). Distinct from
 * {@link LobuApiError}, which signals an HTTP-transport failure.
 */
export class LobuAgentError extends Error {
  readonly messageId: string | undefined;

  constructor(message: string, messageId?: string) {
    super(message);
    this.name = "LobuAgentError";
    this.messageId = messageId;
  }
}
