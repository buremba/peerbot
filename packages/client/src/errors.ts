export class LobuApiError extends Error {
  /** HTTP status, or 0 when the failure occurred before any response (network
   *  error / request-build error — `response` is then undefined). */
  readonly status: number;
  readonly body: unknown;
  readonly response: Response | undefined;

  constructor(response: Response | undefined, body: unknown) {
    const status = response?.status ?? 0;
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : response
          ? `Lobu API request failed with ${status}`
          : "Lobu API request failed before a response was received";
    super(message);
    this.name = "LobuApiError";
    this.status = status;
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
