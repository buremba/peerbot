import { LobuRestClient } from "./rest.js";
import { AgentSession } from "./session.js";
import type { CreateSessionRequest, LobuClientOptions } from "./types.js";

export class Lobu {
  readonly rest: LobuRestClient;
  readonly sessions: {
    create: (input: CreateSessionRequest) => Promise<AgentSession>;
  };

  constructor(options: LobuClientOptions) {
    this.rest = new LobuRestClient({
      baseUrl: options.baseUrl,
      token: options.token,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      headers: options.headers,
    });
    this.sessions = {
      create: (input) => this.createSession(input),
    };
  }

  createSession(input: CreateSessionRequest): Promise<AgentSession> {
    return this.rest
      .createSession(input)
      .then((response) => new AgentSession(this.rest, response, input));
  }
}
