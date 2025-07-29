#!/usr/bin/env bun

import { WebClient } from "@slack/web-api";
import type { SlackConfig } from "./types";
import { SlackError } from "./types";
import type { SlackTokenManager } from "./slack/token-manager";

export class SlackIntegration {
  private client: WebClient;
  private config: SlackConfig;
  private responseChannel: string;
  private responseTs: string;
  private lastUpdateTime = 0;
  private updateQueue: string[] = [];
  private isProcessingQueue = false;
  private tokenManager?: SlackTokenManager;

  constructor(config: SlackConfig) {
    this.config = config;
    this.tokenManager = config.tokenManager;
    
    if (this.tokenManager) {
      // Use authorize function to get dynamic token
      this.client = new WebClient(undefined, {
        authorize: async () => {
          const token = await this.tokenManager!.getValidToken();
          return { botToken: token };
        },
      });
    } else {
      // Fall back to static token
      this.client = new WebClient(config.token);
    }
    
    // Get response location from environment
    this.responseChannel = process.env.SLACK_RESPONSE_CHANNEL!;
    this.responseTs = process.env.SLACK_RESPONSE_TS!;
  }

  /**
   * Update progress message in Slack
   */
  async updateProgress(content: string): Promise<void> {
    try {
      // Rate limiting: don't update more than once every 2 seconds
      const now = Date.now();
      if (now - this.lastUpdateTime < 2000) {
        // Queue the update
        this.updateQueue.push(content);
        this.processQueue();
        return;
      }

      await this.performUpdate(content);
      this.lastUpdateTime = now;

    } catch (error) {
      console.error("Failed to update Slack progress:", error);
      // Don't throw - worker should continue even if Slack updates fail
    }
  }

  /**
   * Stream progress updates (for real-time Claude output)
   */
  async streamProgress(data: any): Promise<void> {
    try {
      // Only stream certain types of updates to avoid spam
      if (this.shouldStreamUpdate(data)) {
        const content = this.formatProgressData(data);
        if (content) {
          await this.updateProgress(`🔄 **Working...**\n\n\`\`\`\n${content}\n\`\`\``);
        }
      }
    } catch (error) {
      console.error("Failed to stream progress:", error);
    }
  }

  /**
   * Process queued updates
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.updateQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      // Wait for rate limit, then send the latest update
      const delay = Math.max(0, 2000 - (Date.now() - this.lastUpdateTime));
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Get the latest update from queue
      const latestUpdate = this.updateQueue.pop();
      this.updateQueue = []; // Clear queue

      if (latestUpdate) {
        await this.performUpdate(latestUpdate);
        this.lastUpdateTime = Date.now();
      }

    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Perform the actual Slack update
   */
  private async performUpdate(content: string): Promise<void> {
    try {
      await this.client.chat.update({
        channel: this.responseChannel,
        ts: this.responseTs,
        text: content,
        parse: "none", // Disable parsing to preserve formatting
      });

    } catch (error: any) {
      // Handle specific Slack errors
      if (error.code === "message_not_found") {
        console.error("Slack message not found - it may have been deleted");
      } else if (error.code === "channel_not_found") {
        console.error("Slack channel not found - bot may not have access");
      } else if (error.code === "not_in_channel") {
        console.error("Bot is not in the channel");
      } else {
        throw new SlackError(
          "updateMessage",
          `Failed to update Slack message: ${error.message}`,
          error
        );
      }
    }
  }

  /**
   * Determine if we should stream this update
   */
  private shouldStreamUpdate(data: any): boolean {
    // Stream significant updates but not every tiny piece of output
    if (typeof data === "object" && data.type) {
      return ["tool_use", "completion", "error"].includes(data.type);
    }
    
    if (typeof data === "string") {
      // Stream text that looks like significant output
      return data.length > 10 && data.length < 500;
    }
    
    return false;
  }

  /**
   * Format progress data for display
   */
  private formatProgressData(data: any): string | null {
    try {
      if (typeof data === "string") {
        return data.substring(0, 200); // Limit length
      }
      
      if (typeof data === "object") {
        if (data.content) {
          return data.content.substring(0, 200);
        }
        
        if (data.type && data.message) {
          return `${data.type}: ${data.message}`;
        }
        
        // Fallback to JSON representation
        return JSON.stringify(data, null, 2).substring(0, 200);
      }
      
      return String(data).substring(0, 200);
      
    } catch (error) {
      console.error("Failed to format progress data:", error);
      return null;
    }
  }

  /**
   * Post a new message (for errors or additional info)
   */
  async postMessage(content: string, threadTs?: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: this.responseChannel,
        thread_ts: threadTs || this.responseTs,
        text: content,
        parse: "none",
      });

    } catch (error) {
      throw new SlackError(
        "postMessage",
        `Failed to post Slack message`,
        error as Error
      );
    }
  }

  /**
   * Add reaction to original message
   */
  async addReaction(emoji: string, timestamp?: string): Promise<void> {
    try {
      await this.client.reactions.add({
        channel: this.responseChannel,
        timestamp: timestamp || this.responseTs,
        name: emoji,
      });

    } catch (error) {
      console.error(`Failed to add reaction ${emoji}:`, error);
      // Don't throw - reactions are not critical
    }
  }

  /**
   * Remove reaction from original message
   */
  async removeReaction(emoji: string, timestamp?: string): Promise<void> {
    try {
      await this.client.reactions.remove({
        channel: this.responseChannel,
        timestamp: timestamp || this.responseTs,
        name: emoji,
      });

    } catch (error) {
      console.error(`Failed to remove reaction ${emoji}:`, error);
      // Don't throw - reactions are not critical
    }
  }

  /**
   * Get channel information
   */
  async getChannelInfo(): Promise<any> {
    try {
      const response = await this.client.conversations.info({
        channel: this.responseChannel,
      });
      return response.channel;

    } catch (error) {
      throw new SlackError(
        "getChannelInfo",
        "Failed to get channel information",
        error as Error
      );
    }
  }

  /**
   * Get user information
   */
  async getUserInfo(userId: string): Promise<any> {
    try {
      const response = await this.client.users.info({
        user: userId,
      });
      return response.user;

    } catch (error) {
      throw new SlackError(
        "getUserInfo",
        `Failed to get user information for ${userId}`,
        error as Error
      );
    }
  }

  /**
   * Send typing indicator
   */
  async sendTyping(): Promise<void> {
    try {
      // Post a temporary "typing" message that we'll update
      await this.updateProgress("⌨️ **Claude is thinking...**");

    } catch (error) {
      console.error("Failed to send typing indicator:", error);
    }
  }

  /**
   * Format error message for Slack
   */
  formatError(error: Error, context?: string): string {
    const parts = ["❌ **Error occurred**"];
    
    if (context) {
      parts.push(`**Context:** ${context}`);
    }
    
    parts.push(`**Error:** \`${error.message}\``);
    
    if (error.stack) {
      parts.push(`**Stack trace:**\n\`\`\`\n${error.stack.substring(0, 500)}\n\`\`\``);
    }
    
    return parts.join("\n\n");
  }

  /**
   * Format success message for Slack
   */
  formatSuccess(message: string, details?: Record<string, any>): string {
    const parts = [`✅ **${message}**`];
    
    if (details) {
      for (const [key, value] of Object.entries(details)) {
        parts.push(`**${key}:** \`${value}\``);
      }
    }
    
    return parts.join("\n");
  }

  /**
   * Cleanup Slack integration
   */
  cleanup(): void {
    // Clear any pending updates
    this.updateQueue = [];
    this.isProcessingQueue = false;
  }
}