#!/usr/bin/env bun

import type { SlackApiClient, MessageResponse } from "../api/client";
import type { SlackContext } from "../types";
import { formatForSlack } from "../../core/formatter";

export interface SlackMessageOperations {
  createInitialResponse(
    context: SlackContext,
    initialText?: string,
  ): Promise<{ messageTs: string; success: boolean; error?: string }>;
  
  updateResponse(
    channel: string,
    messageTs: string,
    content: string,
  ): Promise<{ success: boolean; error?: string }>;
  
  finalizeResponse(
    channel: string,
    messageTs: string,
    finalContent: string,
    metadata?: {
      cost?: number;
      duration?: number;
      success?: boolean;
    },
  ): Promise<{ success: boolean; error?: string }>;
}

export class SlackMessageManager implements SlackMessageOperations {
  private client: SlackApiClient;

  constructor(client: SlackApiClient) {
    this.client = client;
  }

  /**
   * Create initial "working on it" response message
   */
  async createInitialResponse(
    context: SlackContext,
    initialText: string = "I'm working on your request...",
  ): Promise<{ messageTs: string; success: boolean; error?: string }> {
    try {
      const spinner = " <img src=\"https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f\" width=\"14px\" height=\"14px\" style=\"vertical-align: middle; margin-left: 4px;\" />";
      const messageText = `${initialText}${spinner}`;

      const response = await this.client.postMessage(
        context.channelId,
        messageText,
        {
          threadTs: context.threadTs, // Reply in thread if this is a thread message
          parse: "none", // Don't parse links/mentions in our message
        },
      );

      if (!response.ok) {
        return {
          messageTs: "",
          success: false,
          error: response.error || "Failed to post initial message",
        };
      }

      return {
        messageTs: response.ts,
        success: true,
      };
    } catch (error) {
      console.error("Error creating initial response:", error);
      return {
        messageTs: "",
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update the bot's response message with new content
   */
  async updateResponse(
    channel: string,
    messageTs: string,
    content: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Format content for Slack
      const formattedContent = this.formatContentForSlack(content);

      const response = await this.client.updateMessage(
        channel,
        messageTs,
        formattedContent,
        {
          parse: "none",
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: response.error || "Failed to update message",
        };
      }

      return { success: true };
    } catch (error) {
      console.error("Error updating response:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Finalize the response with final status, cost, and duration info
   */
  async finalizeResponse(
    channel: string,
    messageTs: string,
    finalContent: string,
    metadata?: {
      cost?: number;
      duration?: number;
      success?: boolean;
    },
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Format final content
      let formattedContent = this.formatContentForSlack(finalContent);

      // Add metadata footer if provided
      if (metadata) {
        const statusEmoji = metadata.success !== false ? "✅" : "❌";
        const status = metadata.success !== false ? "Completed" : "Failed";
        
        let footer = `\n\n---\n\n${statusEmoji} **${status}**`;
        
        if (metadata.cost !== undefined) {
          footer += ` | **Cost:** $${metadata.cost.toFixed(4)}`;
        }
        
        if (metadata.duration !== undefined) {
          footer += ` | **Duration:** ${(metadata.duration / 1000).toFixed(1)}s`;
        }

        formattedContent += footer;
      }

      const response = await this.client.updateMessage(
        channel,
        messageTs,
        formattedContent,
        {
          parse: "none",
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: response.error || "Failed to finalize message",
        };
      }

      return { success: true };
    } catch (error) {
      console.error("Error finalizing response:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Format content specifically for Slack's markdown limitations
   */
  private formatContentForSlack(content: string): string {
    // Handle Slack-specific formatting requirements
    let formatted = content;

    // Slack has a 4000 character limit per message
    if (formatted.length > 3800) {
      formatted = formatted.substring(0, 3700) + "\n\n*(Output truncated for Slack)*";
    }

    // Slack only supports up to h3 headings
    formatted = formatted.replace(/^#{4,}/gm, "###");

    // Convert GitHub-style code blocks to Slack format if needed
    // Slack supports fewer syntax highlighting options
    formatted = formatted.replace(/```(\w+)/g, (match, lang) => {
      const slackSupportedLangs = ["javascript", "python", "json", "bash", "typescript", "java", "go"];
      const slackLang = slackSupportedLangs.includes(lang) ? lang : "";
      return "```" + slackLang;
    });

    // Handle GitHub-style task lists (Slack doesn't support them natively)
    formatted = formatted.replace(/^- \[ \]/gm, "☐");
    formatted = formatted.replace(/^- \[x\]/gm, "☑");

    // Convert some emojis that might not work in Slack
    formatted = formatted.replace(/🔧/g, ":wrench:");
    formatted = formatted.replace(/🚀/g, ":rocket:");
    formatted = formatted.replace(/⚙️/g, ":gear:");
    formatted = formatted.replace(/👤/g, ":bust_in_silhouette:");

    return formatted;
  }

  /**
   * Handle message formatting for different types of content
   */
  formatMessage(content: any, type: "initial" | "progress" | "final" = "progress"): string {
    if (typeof content === "string") {
      return this.formatContentForSlack(content);
    }

    // Handle structured content (e.g., Claude execution output)
    if (Array.isArray(content)) {
      const formatted = formatForSlack(content);
      return this.formatContentForSlack(formatted);
    }

    // Handle object content
    if (typeof content === "object") {
      // Try to extract meaningful content
      if (content.text) {
        return this.formatContentForSlack(content.text);
      }
      
      if (content.message) {
        return this.formatContentForSlack(content.message);
      }

      // Fallback to JSON representation
      return this.formatContentForSlack("```json\n" + JSON.stringify(content, null, 2) + "\n```");
    }

    // Fallback
    return this.formatContentForSlack(String(content));
  }

  /**
   * Retry message operations with exponential backoff
   */
  async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
  ): Promise<T> {
    return await this.client.withRetry(operation, maxRetries);
  }
}