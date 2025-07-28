#!/usr/bin/env bun

import type { Mode, ModeContext } from "../types";
import type { SlackContext } from "../../slack/types";
import { convertSlackToGenericContext } from "../../slack/context";
import { setupSlackMcpConfiguration } from "../../slack/mcp/config";

export interface SlackModeConfig {
  slackToken: string;
  triggerPhrase?: string;
  customInstructions?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  includeGitHubFileOps?: boolean;
  enableStatusReactions?: boolean;
  enableProgressUpdates?: boolean;
}

export class SlackMode implements Mode {
  name = "slack" as const;
  private config: SlackModeConfig;

  constructor(config: SlackModeConfig) {
    this.config = config;
  }

  /**
   * Check if trigger should activate for Slack events
   */
  async shouldTrigger(context: any): Promise<boolean> {
    // For Slack mode, trigger detection is handled by the event handlers
    // This method is called after the Slack event handlers have already
    // determined that we should respond
    return true;
  }

  /**
   * Process Slack context and prepare for Claude execution
   */
  async processContext(slackContext: SlackContext, options: {
    extractedText?: string;
    userDisplayName?: string;
    botUserId?: string;
    messages?: any[];
  } = {}): Promise<ModeContext> {
    // Convert Slack context to generic context
    const genericContext = convertSlackToGenericContext(slackContext, {
      triggerPhrase: this.config.triggerPhrase,
      customInstructions: this.config.customInstructions,
      directPrompt: options.extractedText,
      messages: options.messages,
      userDisplayName: options.userDisplayName,
      botUserId: options.botUserId,
      allowedTools: this.config.allowedTools?.join(","),
      disallowedTools: this.config.disallowedTools?.join(","),
    });

    // Setup MCP configuration for this execution
    const { configPath } = await setupSlackMcpConfiguration({
      slackToken: this.config.slackToken,
      trackingChannelId: slackContext.channelId,
      trackingMessageTs: slackContext.messageTs,
      includeGitHubFileOps: this.config.includeGitHubFileOps,
    });

    return {
      commentId: slackContext.messageTs,
      baseBranch: undefined, // Not applicable for Slack
      claudeBranch: undefined, // Not applicable for Slack
      mcpConfigPath: configPath,
      genericContext,
      platform: "slack",
      trackingInfo: {
        channelId: slackContext.channelId,
        messageTs: slackContext.messageTs,
        threadTs: slackContext.threadTs,
      },
    };
  }

  /**
   * Get mode-specific allowed tools
   */
  getAllowedTools(): string[] {
    const baseTools = [
      "mcp__slack_message__update_message",
      "mcp__slack_message__post_message",
      "mcp__slack_message__get_conversation_history",
      "mcp__slack_message__get_thread_replies",
    ];

    // Add GitHub file operations if enabled
    if (this.config.includeGitHubFileOps) {
      baseTools.push(
        "mcp__github_file_ops__read_file",
        "mcp__github_file_ops__write_file",
        "mcp__github_file_ops__list_directory",
        "mcp__github_file_ops__commit_files",
        "mcp__github_file_ops__delete_files",
      );
    }

    // Add user-configured tools
    if (this.config.allowedTools) {
      baseTools.push(...this.config.allowedTools);
    }

    return baseTools;
  }

  /**
   * Get mode-specific disallowed tools
   */
  getDisallowedTools(): string[] {
    const baseDisallowed = [
      // Remove GitHub-specific tools that don't make sense in Slack
      "mcp__github_comment__update_claude_comment",
      "mcp__github_ci__get_ci_status",
      "mcp__github_ci__get_workflow_run_details",
      "mcp__github_ci__download_job_log",
    ];

    // Add user-configured disallowed tools
    if (this.config.disallowedTools) {
      baseDisallowed.push(...this.config.disallowedTools);
    }

    return baseDisallowed;
  }

  /**
   * Get mode configuration
   */
  getConfig(): SlackModeConfig {
    return { ...this.config };
  }

  /**
   * Update mode configuration
   */
  updateConfig(newConfig: Partial<SlackModeConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Validate mode configuration
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.config.slackToken) {
      errors.push("Slack token is required");
    }

    // Validate tool configurations
    if (this.config.allowedTools) {
      const invalidTools = this.config.allowedTools.filter(tool => 
        typeof tool !== "string" || tool.trim() === ""
      );
      if (invalidTools.length > 0) {
        errors.push(`Invalid allowed tools: ${invalidTools.join(", ")}`);
      }
    }

    if (this.config.disallowedTools) {
      const invalidTools = this.config.disallowedTools.filter(tool => 
        typeof tool !== "string" || tool.trim() === ""
      );
      if (invalidTools.length > 0) {
        errors.push(`Invalid disallowed tools: ${invalidTools.join(", ")}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Handle mode-specific cleanup
   */
  async cleanup(context: ModeContext): Promise<void> {
    // Clean up any temporary files or resources
    if (context.mcpConfigPath) {
      try {
        await Bun.file(context.mcpConfigPath).text(); // Check if file exists
        // Could delete temp config file here if needed
        console.log(`Slack mode cleanup completed for ${context.mcpConfigPath}`);
      } catch (error) {
        // File doesn't exist or already cleaned up
      }
    }
  }

  /**
   * Get mode-specific prompt additions
   */
  getPromptAdditions(): string {
    return `
This is a Slack integration. You are responding to messages in Slack channels and threads.

Key Slack-specific behaviors:
- Your responses will be posted as Slack messages with markdown formatting
- You can update your messages in real-time as you work
- Status is indicated via emoji reactions on the user's message
- Messages have a 4000 character limit and will be truncated if needed
- Use threads for longer conversations
- Slack markdown has some limitations compared to GitHub markdown

Available Slack-specific tools:
- mcp__slack_message__update_message: Update your current response
- mcp__slack_message__post_message: Post a new message to a channel
- mcp__slack_message__get_conversation_history: Get recent channel messages for context
- mcp__slack_message__get_thread_replies: Get messages in a thread

${this.config.includeGitHubFileOps ? `
GitHub file operations are available for code-related tasks:
- You can read, write, and manage files in repositories
- Use git commands for version control operations
` : ""}

${this.config.customInstructions ? `
Custom Instructions:
${this.config.customInstructions}
` : ""}`;
  }
}

/**
 * Create Slack mode from environment variables
 */
export function createSlackModeFromEnv(): SlackMode {
  const slackToken = process.env.SLACK_BOT_TOKEN || process.env.SLACK_TOKEN;
  if (!slackToken) {
    throw new Error("SLACK_BOT_TOKEN or SLACK_TOKEN environment variable is required");
  }

  return new SlackMode({
    slackToken,
    triggerPhrase: process.env.SLACK_TRIGGER_PHRASE || "@bot",
    customInstructions: process.env.SLACK_CUSTOM_INSTRUCTIONS,
    allowedTools: process.env.SLACK_ALLOWED_TOOLS?.split(",").map(t => t.trim()),
    disallowedTools: process.env.SLACK_DISALLOWED_TOOLS?.split(",").map(t => t.trim()),
    includeGitHubFileOps: process.env.INCLUDE_GITHUB_FILE_OPS === "true",
    enableStatusReactions: process.env.ENABLE_STATUS_REACTIONS !== "false",
    enableProgressUpdates: process.env.ENABLE_PROGRESS_UPDATES !== "false",
  });
}