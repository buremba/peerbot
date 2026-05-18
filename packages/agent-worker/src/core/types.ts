#!/usr/bin/env bun

import type { WorkerTransport } from "@lobu/core";

/**
 * Interface for worker executors. Allows different agent implementations.
 */
export interface WorkerExecutor {
  execute(): Promise<void>;
  cleanup(): Promise<void>;
  getWorkerTransport(): WorkerTransport | null;
}

export interface WorkerConfig {
  sessionKey: string;
  userId: string;
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
   * enqueued (codex P1#1 on PR #865). Optional for backward-compatibility
   * with legacy direct-enqueue paths that don't go through the runs queue.
   */
  runId?: number;
  /**
   * Per-run worker JWT bound to `runId`. Set by MessageConsumer at
   * dispatch time and used by cleanup()'s writeSnapshot call as the
   * Authorization bearer — replaces the deployment-lifetime WORKER_TOKEN
   * for the snapshot path so the gateway's route can require token-runId
   * equality with body.runId (codex round 2 finding A on PR #865).
   * When absent (legacy direct-enqueue), the snapshot write is skipped.
   */
  runJobToken?: string;
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
      type: "completion";
      data: {
        exitCode?: number;
        message?: string;
        success?: boolean;
        sessionId?: string;
      };
      timestamp: number;
    }
  | {
      type: "error";
      data: Error | { message?: string; stack?: string; error?: string };
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
  persisted?: boolean;
  storagePath?: string;
}
