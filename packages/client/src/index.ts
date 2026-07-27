export * as generated from "./generated/index.js";

/**
 * Shared fetch client backing the operations below. Defaults to
 * `http://localhost:8787` — call `client.setConfig({ baseUrl, headers })` once
 * at startup to point at your instance and attach a token.
 */
export { client } from "./generated/client.gen.js";

/**
 * Curated data-layer operations at the package root. Their implementations and
 * types are generated from the server tool registry; camelCase names correspond
 * to MCP names such as `search_memory` and `save_memory`.
 *
 * The full generated surface (agents, auth, webhooks, …) stays under
 * `generated.*`.
 */
export {
  getBehavior,
  manageBehaviors,
  manageConversations,
  manageEntity,
  manageEntitySchema,
  manageFeeds,
  querySdk,
  querySql,
  readKnowledge,
  runSdk,
  saveMemory,
  searchMemory,
  searchSdk,
} from "./generated/index.js";
export { Lobu } from "./client.js";
export { LobuAgentError, LobuApiError } from "./errors.js";
export { AgentSession } from "./session.js";
export type {
  AskOptions,
  AskResult,
  CreateSessionRequest,
  CreateSessionResponse,
  LobuAgentEvent,
  LobuClientOptions,
  LobuCompleteData,
  LobuConnectedData,
  LobuErrorData,
  LobuFetch,
  LobuHeaders,
  LobuOutputData,
  LobuPingData,
  LobuSseEvent,
  SendMessageOptions,
  SendMessageResponse,
  StreamEventsOptions,
  TokenProvider,
} from "./types.js";
