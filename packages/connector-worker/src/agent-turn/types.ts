/**
 * The agent-turn wire shapes, shared by the host executor, the guest bundle and
 * the daemon lane. Kept in one module with no imports so the guest entry can
 * pull the types without dragging any host code into the isolate bundle.
 */

/** Which provider the turn talks to, and how it authenticates. */
export interface AgentTurnProvider {
  /** pi-ai's api id. Only the two fetch-native families run on this lane. */
  api: 'anthropic-messages' | 'openai-completions';
  /** Provider slug pi-ai reports on the model (`anthropic`, `openai`, ...). */
  provider: string;
  modelId: string;
  /**
   * The gateway's agent-scoped secret-proxy URL. The guest never learns a real
   * provider key: the proxy swaps the placeholder it sends for the real key.
   */
  baseUrl: string;
  /**
   * HOST-INJECTED, never set by the producer. The provider key travels on
   * `job.credentials.accessToken` so it goes through the lane's one credential
   * path: the host mints a per-run vault placeholder over the gateway's own
   * placeholder, the guest only ever sees the vault's, and the host swaps it
   * back into the outbound header. A producer that set this itself would hand
   * the guest a credential the vault never minted, and the vault refuses those.
   */
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
}

/**
 * One transcript entry, in pi's own `AgentMessage` shape. The host does not
 * interpret it; it round-trips whatever the guest returns back into the run row
 * so the next turn resumes from it.
 */
export type AgentTurnMessage = Record<string, unknown>;

/** Everything a single turn needs. */
export interface AgentTurnInput {
  provider: AgentTurnProvider;
  systemPrompt: string;
  /** The transcript this turn continues, oldest first. */
  messages: AgentTurnMessage[];
  /** What the human just said. */
  userMessage: string;
}

/** What the guest streams out while the turn runs. */
export type AgentTurnEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'message_end' };

/** What the turn produced. */
export interface AgentTurnOutput {
  text: string;
  stopReason: string | null;
  usage: { input: number; output: number } | null;
  /** The transcript after the turn, to persist and resume from. */
  messages: AgentTurnMessage[];
}
