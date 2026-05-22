import type { LobuRestClient } from "./rest.js";
import type {
  CreateSessionResponse,
  LobuSseEvent,
  SendMessageOptions,
  SendMessageResponse,
  StreamEventsOptions,
} from "./types.js";

export class AgentSession {
  readonly agentId: string;
  readonly token: string;
  readonly expiresAt: number;
  /**
   * The send/stream endpoints the server advertised for this session. `send`
   * and `events` below route through the configured `baseUrl` + this session's
   * `agentId` (the generated REST client is path-templated), which matches the
   * server's same-origin URLs. These fields are surfaced for callers that need
   * the exact server-advertised endpoints (e.g. a different public origin); a
   * future server that advertised a divergent origin/path would require routing
   * through them directly — tracked as a follow-up.
   */
  readonly sseUrl: string;
  readonly messagesUrl: string;

  constructor(
    private readonly rest: LobuRestClient,
    response: CreateSessionResponse
  ) {
    this.agentId = response.agentId;
    this.token = response.token;
    this.expiresAt = response.expiresAt;
    this.sseUrl = response.sseUrl;
    this.messagesUrl = response.messagesUrl;
  }

  send(
    content: string,
    options?: SendMessageOptions
  ): Promise<SendMessageResponse> {
    return this.rest.sendMessage(this.agentId, this.token, content, options);
  }

  events<TData = unknown>(
    options: StreamEventsOptions = {}
  ): AsyncIterable<LobuSseEvent<TData>> {
    return this.rest.streamEvents<TData>(this.agentId, this.token, options);
  }
}
