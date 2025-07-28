#!/usr/bin/env bun

import type { SlackApiClient, ReactionResponse } from "../api/client";
import type { SlackContext } from "../types";
import { EmojiStatus } from "../types";

export interface ReactionManager {
  setWorkingStatus(context: SlackContext): Promise<{ success: boolean; error?: string }>;
  setCompletedStatus(context: SlackContext): Promise<{ success: boolean; error?: string }>;
  setErrorStatus(context: SlackContext): Promise<{ success: boolean; error?: string }>;
  setInfoStatus(context: SlackContext): Promise<{ success: boolean; error?: string }>;
  clearStatus(context: SlackContext): Promise<{ success: boolean; error?: string }>;
}

export interface ReactionConfig {
  workingEmoji?: string;
  completedEmoji?: string;
  errorEmoji?: string;
  infoEmoji?: string;
  enableStatusReactions?: boolean;
}

export class SlackReactionManager implements ReactionManager {
  private client: SlackApiClient;
  private config: ReactionConfig;
  private activeReactions = new Map<string, string>(); // messageTs -> current emoji

  constructor(client: SlackApiClient, config: ReactionConfig = {}) {
    this.client = client;
    this.config = {
      workingEmoji: config.workingEmoji || EmojiStatus.Working,
      completedEmoji: config.completedEmoji || EmojiStatus.Completed,
      errorEmoji: config.errorEmoji || EmojiStatus.Error,
      infoEmoji: config.infoEmoji || EmojiStatus.Info,
      enableStatusReactions: config.enableStatusReactions !== false, // Default to true
    };
  }

  /**
   * Add working status emoji to user's message
   */
  async setWorkingStatus(context: SlackContext): Promise<{ success: boolean; error?: string }> {
    if (!this.config.enableStatusReactions) {
      return { success: true };
    }

    return await this.setReaction(
      context.channelId,
      context.messageTs,
      this.config.workingEmoji!,
    );
  }

  /**
   * Replace working emoji with completed emoji
   */
  async setCompletedStatus(context: SlackContext): Promise<{ success: boolean; error?: string }> {
    if (!this.config.enableStatusReactions) {
      return { success: true };
    }

    // Remove working status first
    await this.removeCurrentReaction(context.channelId, context.messageTs);

    // Add completed status
    return await this.setReaction(
      context.channelId,
      context.messageTs,
      this.config.completedEmoji!,
    );
  }

  /**
   * Replace working emoji with error emoji
   */
  async setErrorStatus(context: SlackContext): Promise<{ success: boolean; error?: string }> {
    if (!this.config.enableStatusReactions) {
      return { success: true };
    }

    // Remove working status first
    await this.removeCurrentReaction(context.channelId, context.messageTs);

    // Add error status
    return await this.setReaction(
      context.channelId,
      context.messageTs,
      this.config.errorEmoji!,
    );
  }

  /**
   * Add info status emoji
   */
  async setInfoStatus(context: SlackContext): Promise<{ success: boolean; error?: string }> {
    if (!this.config.enableStatusReactions) {
      return { success: true };
    }

    return await this.setReaction(
      context.channelId,
      context.messageTs,
      this.config.infoEmoji!,
    );
  }

  /**
   * Clear all status reactions
   */
  async clearStatus(context: SlackContext): Promise<{ success: boolean; error?: string }> {
    if (!this.config.enableStatusReactions) {
      return { success: true };
    }

    return await this.removeCurrentReaction(context.channelId, context.messageTs);
  }

  /**
   * Set a specific reaction on a message
   */
  private async setReaction(
    channel: string,
    messageTs: string,
    emoji: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.client.addReaction(channel, messageTs, emoji);

      if (response.ok) {
        // Track the current reaction
        this.activeReactions.set(messageTs, emoji);
        return { success: true };
      } else {
        console.warn(`Failed to add reaction ${emoji}:`, response.error);
        return {
          success: false,
          error: response.error || "Failed to add reaction",
        };
      }
    } catch (error) {
      console.error("Error setting reaction:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Remove the current tracked reaction from a message
   */
  private async removeCurrentReaction(
    channel: string,
    messageTs: string,
  ): Promise<{ success: boolean; error?: string }> {
    const currentEmoji = this.activeReactions.get(messageTs);
    if (!currentEmoji) {
      return { success: true }; // Nothing to remove
    }

    try {
      const response = await this.client.removeReaction(channel, messageTs, currentEmoji);

      if (response.ok) {
        // Remove from tracking
        this.activeReactions.delete(messageTs);
        return { success: true };
      } else {
        console.warn(`Failed to remove reaction ${currentEmoji}:`, response.error);
        return {
          success: false,
          error: response.error || "Failed to remove reaction",
        };
      }
    } catch (error) {
      console.error("Error removing reaction:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Batch update status with error handling
   */
  async updateStatus(
    context: SlackContext,
    status: "working" | "completed" | "error" | "info" | "clear",
  ): Promise<{ success: boolean; error?: string }> {
    switch (status) {
      case "working":
        return await this.setWorkingStatus(context);
      case "completed":
        return await this.setCompletedStatus(context);
      case "error":
        return await this.setErrorStatus(context);
      case "info":
        return await this.setInfoStatus(context);
      case "clear":
        return await this.clearStatus(context);
      default:
        return { success: false, error: `Unknown status: ${status}` };
    }
  }

  /**
   * Get current status for a message
   */
  getCurrentStatus(messageTs: string): string | null {
    return this.activeReactions.get(messageTs) || null;
  }

  /**
   * Handle emoji update failures gracefully
   */
  async safeUpdateStatus(
    context: SlackContext,
    status: "working" | "completed" | "error" | "info" | "clear",
    fallbackAction?: () => Promise<void>,
  ): Promise<void> {
    const result = await this.updateStatus(context, status);
    
    if (!result.success) {
      console.warn(`Failed to update status to ${status}:`, result.error);
      
      // Execute fallback action if provided
      if (fallbackAction) {
        try {
          await fallbackAction();
        } catch (error) {
          console.error("Fallback action failed:", error);
        }
      }
    }
  }

  /**
   * Cleanup reactions for completed conversations
   */
  cleanup(messageTs: string): void {
    this.activeReactions.delete(messageTs);
  }

  /**
   * Get configuration
   */
  getConfig(): ReactionConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ReactionConfig>): void {
    this.config = { ...this.config, ...config };
  }
}