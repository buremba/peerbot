#!/usr/bin/env bun

/**
 * Consolidated types for worker package
 * Merged from: base/types.ts, types.ts, interfaces.ts
 */

import type { WorkerTransport } from "@lobu/core";

// ============================================================================
// WORKER INTERFACES
// ============================================================================

/**
 * Interface for worker executors
 * Allows different agent implementations
 */
export interface WorkerExecutor {
  /**
   * Execute the worker job
   */
  execute(): Promise<void>;

  /**
   * Cleanup worker resources
   */
  cleanup(): Promise<void>;

  /**
   * Get the worker transport for sending updates to gateway
   */
  getWorkerTransport(): WorkerTransport | null;
}

// ============================================================================
// WORKER CONFIG & WORKSPACE
// ============================================================================

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
}

export interface WorkspaceSetupConfig {
  baseDirectory: string;
}

export interface WorkspaceInfo {
  baseDirectory: string;
  userDirectory: string;
}

// ============================================================================
// PROGRESS & EXECUTION TYPES
// ============================================================================

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
 * Session context for AI execution
 * Contains information about the current session (platform, user, workspace)
 */

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
