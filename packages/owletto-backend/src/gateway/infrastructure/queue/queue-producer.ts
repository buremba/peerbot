#!/usr/bin/env bun

import {
  type AgentEgressConfig,
  type AgentMcpConfig,
  createLogger,
  type NetworkConfig,
  type NixConfig,
} from "@lobu/core";
import type { IMessageQueue } from "./types.js";

const logger = createLogger("queue-producer");

/**
 * Job type for queue messages
 * - message: Standard agent message execution
 * - exec: Direct command execution in sandbox
 */
export type JobType = "message" | "exec";

/**
 * Universal message payload for all queue stages
 * Used by: Slack events → Queue → Message Consumer → Job Router → Worker
 */
export interface MessagePayload {
  // Core identifiers (used by gateway for routing)
  userId: string; // Platform user ID
  conversationId: string; // Conversation ID (must be root conversation ID)
  messageId: string; // Individual message ID
  channelId: string; // Platform channel ID
  teamId: string; // Team/workspace ID (required for all platforms)
  agentId: string; // Agent/session ID for isolation (universal identifier)

  // Bot & platform info (passed through to worker)
  botId: string; // Bot identifier
  platform: string; // Platform name

  // Message content (used by worker)
  messageText: string; // The actual message text

  // Platform-specific data (used by worker for context)
  platformMetadata: Record<string, any>;

  // Agent configuration (used by worker)
  agentOptions: Record<string, any>;

  // Per-agent network configuration for sandbox isolation
  networkConfig?: NetworkConfig;

  // Per-agent egress judge configuration (operator-level overrides for the LLM egress judge).
  egressConfig?: AgentEgressConfig;

  // Per-agent MCP configuration (additive to global MCPs)
  mcpConfig?: AgentMcpConfig;

  // Nix environment configuration for agent workspace
  nixConfig?: NixConfig;

  // MCP tool grant patterns the operator has pre-approved.
  // Synced to the grant store at deployment time to bypass the approval card.
  preApprovedTools?: string[];

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
 * Queue producer for dispatching messages to the runs queue.
 * Handles both direct_message and thread_message queues with bot isolation.
 */
export class QueueProducer {
  private queue: IMessageQueue;
  private isInitialized = false;

  constructor(queue: IMessageQueue) {
    this.queue = queue;
  }

  /**
   * Initialize the queue producer
   * Creates required queues
   */
  async start(): Promise<void> {
    try {
      // Create the messages queue if it doesn't exist
      await this.queue.createQueue("messages");
      this.isInitialized = true;
      logger.debug("Queue producer initialized");
    } catch (error) {
      logger.error("Failed to initialize queue producer:", error);
      throw error;
    }
  }

  /**
   * Stop the queue producer (no-op since queue lifecycle is managed externally)
   */
  async stop(): Promise<void> {
    this.isInitialized = false;
    logger.debug("Queue producer stopped");
  }

  /**
   * Enqueue any message (direct or thread) to the single 'messages' queue
   * Orchestrator will determine if it needs to create a deployment or route to existing thread
   */
  async enqueueMessage(
    payload: MessagePayload,
    options?: {
      priority?: number;
      retryLimit?: number;
      retryDelay?: number;
      expireInSeconds?: number;
    }
  ): Promise<string> {
    if (!this.isInitialized) {
      throw new Error("Queue producer is not initialized");
    }

    try {
      // All messages go to the single 'messages' queue.
      //
      // BullMQ interprets ':' in custom jobIds as an internal repeatable-job
      // separator and rejects anything with more/fewer than 3 colon segments.
      // Platform identifiers from the Chat SDK (e.g. Slack's
      // `slack:C09EH3ASNQ1`, message timestamps like `1776219228.000100`
      // that can embed colons in some paths) would all blow up enqueue.
      // Sanitize the *entire* singletonKey — not just the messageId — so any
      // platform's channelId/conversationId/messageId scheme is safe.
      const rawSingletonKey = `message-${payload.platform}-${payload.channelId}-${payload.conversationId}-${payload.messageId || Date.now()}`;
      const jobId = await this.queue.send("messages", payload, {
        priority: options?.priority || 0,
        retryLimit: options?.retryLimit || 3,
        retryDelay: options?.retryDelay || 30,
        expireInSeconds: options?.expireInSeconds || 300, // 5 minutes = 300 seconds
        singletonKey: rawSingletonKey.replace(/:/g, "-"), // Prevent duplicates within canonical conversation identity
      });

      logger.info(
        `Enqueued message job ${jobId} for user ${payload.userId}, conversation ${payload.conversationId}`
      );
      return jobId || "job-sent";
    } catch (error) {
      logger.error(
        `Failed to enqueue message for user ${payload.userId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Check if producer is initialized
   */
  isHealthy(): boolean {
    return this.isInitialized && this.queue.isHealthy();
  }
}
