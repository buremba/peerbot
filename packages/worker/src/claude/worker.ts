#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { InstructionProvider } from "@peerbot/core";
import { createLogger } from "@peerbot/core";
import type { InteractionClient } from "../common/interaction-client";
import { BaseWorker } from "../core/base-worker";
import type {
  ProgressUpdate,
  SessionExecutionResult,
  WorkerConfig,
} from "../core/types";
import { ClaudeCoreInstructionProvider } from "./instructions";
import { ProgressProcessor } from "./processor";
import { type ClaudeExecutionOptions, runClaudeWithSDK } from "./sdk-adapter";
import { getSessionContext } from "./session-manager";

const logger = createLogger("claude-worker");

/**
 * Claude Code worker implementation
 * Extends BaseWorker with Claude SDK-specific execution logic
 */
export class ClaudeWorker extends BaseWorker {
  private progressProcessor: ProgressProcessor;
  private interactionClient?: InteractionClient;

  constructor(config: WorkerConfig, interactionClient?: InteractionClient) {
    super(config);
    this.progressProcessor = new ProgressProcessor();
    this.interactionClient = interactionClient;
  }

  protected getAgentName(): string {
    return "Claude Code";
  }

  protected getCoreInstructionProvider(): InstructionProvider {
    return new ClaudeCoreInstructionProvider();
  }

  protected async runAISession(
    userPrompt: string,
    customInstructions: string,
    onProgress: (update: ProgressUpdate) => Promise<void>
  ): Promise<SessionExecutionResult> {
    try {
      logger.info(`Creating Claude SDK session ${this.config.sessionKey}`);

      // Parse Claude options (includes historyConfig from agent settings)
      const rawOptions = JSON.parse(this.config.agentOptions) as Record<
        string,
        unknown
      >;
      const agentOptions = rawOptions as ClaudeExecutionOptions;
      const historyConfig = rawOptions.historyConfig as
        | { enabled?: boolean }
        | undefined;
      const historyEnabled = historyConfig?.enabled ?? false;

      // Check if Claude session exists in workspace
      const workspaceDir = this.getWorkingDirectory();
      const sessionExists = await this.checkClaudeSessionExists(workspaceDir);

      // Get session context with unanswered interactions
      const context = await getSessionContext();
      const unansweredInteractions = context.unansweredInteractions || [];

      logger.info(
        `Startup state: ${unansweredInteractions.length} unanswered interactions, ` +
          `session exists: ${sessionExists}, history: ${historyEnabled}`
      );

      // If there are unanswered interactions, add context note to system prompt
      if (unansweredInteractions.length > 0) {
        logger.info(
          `Found ${unansweredInteractions.length} unanswered interactions - adding context note for Claude`
        );
        const pendingNote = this.buildPendingInteractionNote(
          unansweredInteractions
        );
        customInstructions += `\n\n${pendingNote}`;
      }

      logger.info(
        sessionExists
          ? `Continuing existing Claude session for thread ${this.config.threadId}`
          : `Starting new Claude session for thread ${this.config.threadId}`
      );

      // Execute Claude with SDK
      const result = await runClaudeWithSDK(
        userPrompt,
        {
          ...agentOptions,
          appendSystemPrompt: customInstructions,
          ...(sessionExists ? { continue: true } : {}),
        },
        async (update) => {
          await onProgress(update);
        },
        this.getWorkingDirectory(),
        {
          channelId: this.config.channelId,
          threadId: this.config.threadId || "",
          platform: this.config.platform,
          historyEnabled,
        },
        this.interactionClient
      );

      return {
        ...result,
        sessionKey: this.config.sessionKey,
        persisted: false,
        storagePath: `${this.config.platform || "platform"}://thread`,
      };
    } catch (error) {
      logger.error(
        `Session ${this.config.sessionKey} execution failed:`,
        error
      );

      return {
        success: false,
        exitCode: 1,
        output: "",
        error: error instanceof Error ? error.message : "Unknown error",
        sessionKey: this.config.sessionKey,
      };
    }
  }

  protected async processProgressUpdate(
    update: ProgressUpdate
  ): Promise<string | null> {
    // Type guard to check if data is an SDKMessage
    const isSDKMessage = (data: unknown): data is SDKMessage => {
      return typeof data === "object" && data !== null && "type" in data;
    };

    // Skip system messages
    if (isSDKMessage(update.data) && update.data.type === "system") {
      logger.debug(
        `Skipping system message: ${"subtype" in update.data ? update.data.subtype : "unknown"}`
      );
      return null;
    }

    // Process the update to extract user-friendly content (only for SDKMessage types)
    if (!isSDKMessage(update.data)) {
      return null;
    }
    const processResult = this.progressProcessor.processUpdate(update.data);

    // Check if this is a final result message
    if (processResult?.isFinal) {
      this.progressProcessor.setFinalResult(processResult);
      logger.info(
        `📦 Stored final result (${processResult.text.length} chars) for deduplication`
      );
      return null;
    }

    // Get delta and return
    return this.progressProcessor.getDelta();
  }

  protected getFinalResult(): { text: string; isFinal: boolean } | null {
    return this.progressProcessor.getFinalResult();
  }

  protected resetProgressState(): void {
    this.progressProcessor.reset();
  }

  protected async cleanupSession(sessionKey: string): Promise<void> {
    logger.info(`Cleanup for ${sessionKey} (no-op in stateless mode)`);
  }

  /**
   * Check if Claude CLI session exists
   * With HOME=/workspace, Claude SDK stores sessions in /workspace/.claude/
   */
  private async checkClaudeSessionExists(
    _workspaceDir: string
  ): Promise<boolean> {
    try {
      // Claude SDK stores sessions in HOME directory
      // Since HOME=/workspace, sessions are in /workspace/.claude/
      const homeDir = process.env.HOME || "/workspace";
      const claudeDir = path.join(homeDir, ".claude");
      const stats = await fs.stat(claudeDir);

      if (!stats.isDirectory()) {
        return false;
      }

      // Check if there are any session files
      const files = await fs.readdir(claudeDir);
      return files.length > 0;
    } catch {
      // Directory doesn't exist or not accessible
      return false;
    }
  }

  /**
   * Build system note about pending unanswered interactions
   */
  private buildPendingInteractionNote(
    unanswered: Array<{ type: string; question: string }>
  ): string {
    const notes = unanswered.map((i) => {
      switch (i.type) {
        case "plan_approval":
          return "Note: You previously asked the user to approve executing your plan, but they haven't responded yet. They've now sent a new message instead. You can ask them again if needed, or proceed based on their new request.";
        case "tool_approval":
          return "Note: You previously asked the user to approve a tool execution, but they haven't responded yet. They've sent a new message instead.";
        case "question":
        case "form":
          return `Note: You asked the user: "${i.question.substring(0, 100)}${i.question.length > 100 ? "..." : ""}", but they sent a new message instead of answering.`;
        default:
          return `Note: You have an unanswered interaction with the user.`;
      }
    });

    return `## Pending Interactions\n\n${notes.join("\n\n")}`;
  }
}
