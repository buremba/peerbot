#!/usr/bin/env bun

import type { WorkerTransport } from "@lobu/core";

/**
 * Interface for worker executors. Allows different agent implementations.
 */
export interface WorkerExecutor {
  execute(): Promise<void>;
  steer(prompt: string, messageId: string): Promise<boolean>;
  cancel(messageId: string): Promise<boolean>;
  cleanup(): Promise<void>;
  getWorkerTransport(): WorkerTransport | null;
}

export interface WorkerConfig {
  sessionKey: string;
  userId: string;
  organizationId: string;
  messageId: string;
  agentId: string; // Space identifier for multi-tenant isolation
  channelId: string;
  conversationId: string;
  userPrompt: string; // Base64 encoded
  responseChannel: string; // Platform-agnostic response channel
  responseId: string; // Platform-agnostic response message ID
  botResponseId?: string; // Bot's response message ID for updates
  agentOptions: string; // JSON string
  teamId?: string; // Platform team/workspace ID (e.g., Slack team ID)
  platform: string; // Platform identifier (e.g., "slack", "discord")
  platformMetadata?: any; // Platform-specific metadata (e.g., files, user info)
  workspace: {
    baseDirectory: string;
  };
  /**
   * The runs.id of the row that dispatched this job. Set by the gateway
   * (MessageConsumer stamps it from the runs-queue claim's job.id) so the
   * worker's cleanup() snapshot can attribute itself to the correct run
   * even when a follow-up run for the same conversation has already been
   * enqueued.
   */
  runId: number;
  /**
   * Per-run worker JWT bound to `runId`. Set by MessageConsumer at
   * dispatch time and used by cleanup()'s writeSnapshot call as the
   * Authorization bearer — replaces the deployment-lifetime WORKER_TOKEN
   * for the snapshot path so the gateway's route can require token-runId
   * equality with body.runId (codex round 2 finding A on PR #865).
   */
  runJobToken: string;
  /**
   * Pinned bash-backend provider for this conversation, resolved per-turn by the
   * gateway from the immutable sandbox pin. Selects the worker's bash backend so
   * a warm deployment routes on the pin:
   *  - a provider id (e.g. `"vercel"`) → that remote runtime;
   *  - undefined → local just-bash.
   */
  runtimeProviderId?: string;
}

export interface WorkspaceSetupConfig {
  baseDirectory: string;
}

export interface WorkspaceInfo {
  baseDirectory: string;
  userDirectory: string;
}

/**
 * Progress update from AI agent execution
 */
export type ProgressUpdate =
  | {
      type: "output";
      data: unknown; // Agent-specific message format
      timestamp: number;
    }
  | {
      type: "status_update";
      data: {
        elapsedSeconds: number;
        state: string;
      };
      timestamp: number;
    }
  | {
      type: "custom_event";
      data: {
        name: string;
        payload: Record<string, unknown>;
      };
      timestamp: number;
    };

/**
 * Result from session execution (includes session metadata)
 */
export interface SessionExecutionResult {
  success: boolean;
  exitCode: number;
  output: string;
  error?: string;
  sessionKey: string;
}
