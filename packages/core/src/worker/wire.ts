/**
 * Gateway ↔ worker wire contract.
 *
 * `MessagePayload` is what `MessageConsumer` (gateway) enqueues on the runs
 * queue, what `DeploymentManager.dispatch*` writes to the worker SSE
 * stream, and what the worker's `GatewayClient.handleThreadMessage` /
 * `handleExecJob` consumes. Same shape on both sides — keep it here.
 *
 * Before this lived in core, the worker had its own `MessagePayload`
 * declaration that was a structural subset of the gateway's (missing
 * `organizationId`, `networkConfig`, `nixConfig`, `preApprovedTools`). At
 * runtime the worker's zod schema was patched with
 * `.passthrough()` so the extra fields survived parsing, but the static type
 * silently lied. Hoisting closes the gap.
 */

import type {
  AgentInlineGuardrail,
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
 * Trusted authorization origin of a turn, derived at each gateway ingress from
 * what that ingress ACTUALLY knows — never inferred from the free-form
 * `platformMetadata.source` string (which is optional, unstructured, and shared
 * across unrelated subsystems). This is the authoritative signal for deciding
 * whether a turn may do things only a real person should authorize (e.g. run a
 * `!`-shell command in the sandbox).
 *
 *  - `interactive_human` — a real inbound message a human typed/sent in a live
 *    chat (a platform DM/mention, or the web panel composer). ONLY this may
 *    authorize human-gated actions.
 *  - `headless` — a programmatic turn with no human at a socket: a scheduled
 *    wake, a `conversations.send` SDK call, an internal thread. Legitimate, but
 *    not a human gesture.
 *  - `agent` — an agent/tool/watcher-authored turn (autonomous). Most
 *    restrictive; also the FAIL-CLOSED default when the origin is absent or
 *    unrecognized, so a missing claim can never be read as a human.
 *
 * Carried as a first-class {@link MessagePayload.origin} field AND signed into
 * the worker token (`WorkerTokenData.origin`), so the worker authorizes on the
 * verified claim rather than a body field it could be tricked about.
 */
export type MessageOrigin = "interactive_human" | "headless" | "agent";

/**
 * Read a {@link MessageOrigin} fail-closed. Any value that is not one of the
 * three known origins — including `undefined`, a legacy payload/token minted
 * before this field existed, or a non-string — resolves to `"agent"` (the
 * most-restrictive origin). A missing origin must NEVER be treated as a human.
 */
export function resolveMessageOrigin(value: unknown): MessageOrigin {
  return value === "interactive_human" || value === "headless"
    ? value
    : "agent";
}

/** True only for a verified interactive-human origin (fail-closed). */
export function isInteractiveHumanOrigin(value: unknown): boolean {
  return resolveMessageOrigin(value) === "interactive_human";
}

/** True for any non-interactive (headless or agent/automation) origin. */
export function isAutomationOrigin(value: unknown): boolean {
  return resolveMessageOrigin(value) !== "interactive_human";
}

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
  organizationId: string;

  // ── Bot & platform info (passed through to worker) ─────────────────
  /** Bot identifier. */
  botId: string;
  /** Platform name (`slack`, `telegram`, ...). */
  platform: string;

  /**
   * Trusted authorization origin of this turn (see {@link MessageOrigin}),
   * stamped by the ingress that built this payload from what it actually knows
   * — NOT copied from `platformMetadata.source`. `buildWorkerTokenClaims` signs
   * it into the worker token so the worker authorizes on the verified claim.
   * Absent on legacy payloads → read fail-closed via {@link resolveMessageOrigin}
   * (defaults to `agent`, never `interactive_human`).
   */
  origin?: MessageOrigin;

  // ── Message content (used by worker) ───────────────────────────────
  messageText: string;

  /**
   * Ephemeral context prepended to the user prompt for this turn only.
   * Not stored in the transcript snapshot — use for watcher preprompts, etc.
   */
  ephemeralContext?: string;

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

  /**
   * This conversation's PINNED runtime provider for the bash backend, resolved
   * per-turn by the gateway from the immutable sandbox pin (`resolvePinnedSelection`).
   * Frozen on the conversation's first turn so an agent repoint never moves an
   * existing conversation's sandbox realm.
   *
   *  - a provider id (e.g. `"vercel"`) → route bash to that remote runtime;
   *  - absent → local just-bash.
   *
   * The pinned provider is ALSO a signed claim in `runJobToken` (the remote
   * runtime route reads it from the token, never this body field) — this field
   * exists only so the worker's backend selection is per-turn-accurate on a warm
   * deployment reused across conversations pinned to different realms.
   */
  runtimeProviderId?: string;

  /**
   * Per-agent operator-authored inline guardrails. Threaded alongside
   * `networkConfig` so the deployment manager can sync the `egress`-stage
   * entries into the egress policy store (the proxy-plane LLM judge). The
   * input/output/pre-tool entries are resolved separately by the message
   * pipeline from agent settings; they ride here only for the egress sync.
   */
  guardrailsInline?: AgentInlineGuardrail[];

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
