/**
 * Gateway ↔ worker wire contract.
 *
 * `MessagePayload` is what `MessageConsumer` (gateway) enqueues on the runs
 * queue, what `EmbeddedDeploymentManager.dispatch*` writes to the worker SSE
 * stream, and what the worker's `GatewayClient.handleThreadMessage` /
 * `handleExecJob` consumes. Same shape on both sides — keep it here.
 *
 * Before this lived in core, the worker had its own `MessagePayload`
 * declaration that was a structural subset of the gateway's (missing
 * `organizationId`, `networkConfig`, `egressConfig`, `mcpConfig`, `nixConfig`,
 * `preApprovedTools`). At runtime the worker's zod schema was patched with
 * `.passthrough()` so the extra fields survived parsing, but the static type
 * silently lied. Hoisting closes the gap.
 */

import type {
  AgentEgressConfig,
  AgentMcpConfig,
  AgentOptions,
  NetworkConfig,
  NixConfig,
} from "../types";

/**
 * Job type for queue messages.
 * - `message`: standard agent message execution.
 * - `exec`: direct command execution in the sandbox.
 */
export type JobType = "message" | "exec";

/**
 * Universal message payload for every gateway → worker hop.
 * Used by: platform inbound → runs queue → MessageConsumer → worker.
 */
export interface MessagePayload {
  // ── Core identifiers (used by gateway for routing) ──────────────────
  userId: string;
  conversationId: string;
  messageId: string;
  channelId: string;
  /**
   * Team/workspace ID. Required in the gateway-produced payload (always
   * stamped by `buildMessagePayload`), but optional in the wire type
   * because Slack carries the workspace ID in `platformMetadata` and the
   * worker reads it defensively (`payload.teamId ?? platformMetadata.teamId`).
   * The worker SSE schema parses it with `z.string().optional()`.
   */
  teamId?: string;
  /** Agent / session ID for tenant isolation. */
  agentId: string;
  /**
   * Owning organization of the agent. Plumbed through so child queries
   * (grants, user-agents, channel-bindings, secrets) can scope by org —
   * agent IDs are per-org-unique, so `agent_id = ?` alone is ambiguous.
   */
  organizationId?: string;

  // ── Bot & platform info (passed through to worker) ─────────────────
  /** Bot identifier. */
  botId: string;
  /** Platform name (`slack`, `telegram`, ...). */
  platform: string;

  // ── Message content (used by worker) ───────────────────────────────
  messageText: string;

  // ── Platform-specific data (used by worker for context) ────────────
  platformMetadata: Record<string, unknown>;

  // ── Agent configuration (used by worker) ───────────────────────────
  agentOptions: AgentOptions;

  // ── Per-agent network configuration for sandbox isolation ──────────
  networkConfig?: NetworkConfig;

  /**
   * The runs.id of the row the runs-queue claimed when this message was
   * dispatched. Threaded all the way to the worker so the per-run
   * agent_transcript_snapshot POST can attribute the snapshot to the
   * correct run unambiguously — codex P1#1 on PR #865.
   */
  runId?: number;

  /**
   * Per-run worker JWT bound to `runId` above. Minted by the runs-queue
   * dispatcher (`MessageConsumer.handleMessage`) so the snapshot route can
   * require `tokenData.runId === body.runId` and reject any attempt by a
   * same-(org, agent, conv) deployment-lifetime token to write under a
   * different run's slot — codex round 2 finding A on PR #865.
   */
  runJobToken?: string;

  /** Per-agent egress judge configuration. */
  egressConfig?: AgentEgressConfig;

  /** Per-agent MCP configuration (additive to global MCPs). */
  mcpConfig?: AgentMcpConfig;

  /** Nix environment configuration for the agent workspace. */
  nixConfig?: NixConfig;

  /**
   * MCP tool grant patterns the operator has pre-approved.
   * Synced to the grant store at deployment time to bypass the approval card.
   */
  preApprovedTools?: string[];

  /**
   * Job ID from the gateway (set when the payload rode through the worker
   * SSE stream). Optional — direct-enqueue paths leave it unset.
   */
  jobId?: string;

  /** Job type (default: `message`). */
  jobType?: JobType;

  // ── Exec-specific fields (only used when jobType === "exec") ───────
  /** Unique ID for the exec job (for response routing). */
  execId?: string;
  /** Command to execute. */
  execCommand?: string;
  /** Working directory for the command. */
  execCwd?: string;
  /** Additional environment variables. */
  execEnv?: Record<string, string>;
  /** Timeout in milliseconds. */
  execTimeout?: number;
}

/** Queued message envelope used by the worker's in-process batcher. */
export interface QueuedMessage {
  payload: MessagePayload;
  timestamp: number;
}
