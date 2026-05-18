/**
 * Shared types for gateway communication
 */

import type { AgentOptions, ThreadResponsePayload } from "@lobu/core";

/**
 * Platform-specific metadata (e.g., Slack team_id, channel, thread_ts)
 */
interface PlatformMetadata {
  team_id?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  files?: unknown[];
  traceId?: string; // Trace ID for end-to-end observability
  [key: string]: unknown;
}

/**
 * Job type for queue messages
 * - message: Standard agent message execution
 * - exec: Direct command execution in sandbox
 */
export type JobType = "message" | "exec";

/**
 * Message payload for agent execution
 */
export interface MessagePayload {
  botId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  platform: string;
  channelId: string;
  messageId: string;
  messageText: string;
  platformMetadata: PlatformMetadata;
  agentOptions: AgentOptions;
  jobId?: string; // Optional job ID from gateway
  teamId?: string; // Optional team ID (WhatsApp uses top-level, Slack uses platformMetadata)

  // The runs.id of the row that dispatched this job. Set by the gateway
  // MessageConsumer (stamped from the runs-queue claim's job.id) and
  // threaded into WorkerConfig.runId. The worker's cleanup() uses it to
  // attribute the agent_transcript_snapshot row to the correct run —
  // see codex P1#1 on PR #865.
  runId?: number;

  // Per-run worker JWT bound to `runId` above. Minted by MessageConsumer
  // and threaded into WorkerConfig.runJobToken. The worker uses THIS
  // token (not the deployment-lifetime WORKER_TOKEN) when calling the
  // snapshot endpoint, so the route's `tokenData.runId === body.runId`
  // equality check can reject any cross-run impersonation — codex round
  // 2 finding A on PR #865.
  runJobToken?: string;

  // Job type (default: "message")
  jobType?: JobType;

  // Exec-specific fields (only used when jobType === "exec")
  execId?: string; // Unique ID for exec job (for response routing)
  execCommand?: string; // Command to execute
  execCwd?: string; // Working directory for command
  execEnv?: Record<string, string>; // Additional environment variables
  execTimeout?: number; // Timeout in milliseconds
}

/**
 * Queued message with timestamp
 */
export interface QueuedMessage {
  payload: MessagePayload;
  timestamp: number;
}

/**
 * Response data sent back to gateway
 */
export type ResponseData = ThreadResponsePayload & {
  originalMessageId: string;
};
