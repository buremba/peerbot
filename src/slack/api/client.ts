#!/usr/bin/env bun

import { WebClient, ChatPostMessageResponse, ChatUpdateResponse } from "@slack/web-api";
import type { SlackContext, SlackMessageUpdate } from "../types";

export interface SlackApiClientConfig {
  token: string;
  retryConfig?: {
    retries?: number;
    factor?: number;
  };
}

export interface MessageResponse {
  ok: boolean;
  channel: string;
  ts: string;
  message?: any;
  error?: string;
}

export interface ReactionResponse {
  ok: boolean;
  error?: string;
}

export class SlackApiClient {
  private client: WebClient;

  constructor(config: SlackApiClientConfig) {
    this.client = new WebClient(config.token, {
      retryConfig: config.retryConfig || {
        retries: 3,
        factor: 2,
      },
    });
  }

  /**
   * Post a new message to a channel or thread
   */
  async postMessage(
    channel: string,
    text: string,
    options?: {
      threadTs?: string;
      blocks?: any[];
      parse?: string;
      linkNames?: boolean;
    },
  ): Promise<MessageResponse> {
    try {
      const response = await this.client.chat.postMessage({
        channel,
        text,
        thread_ts: options?.threadTs,
        blocks: options?.blocks,
        parse: options?.parse || "none",
        link_names: options?.linkNames || false,
      }) as ChatPostMessageResponse;

      if (!response.ok) {
        return {
          ok: false,
          channel,
          ts: "",
          error: response.error || "Unknown error",
        };
      }

      return {
        ok: true,
        channel: response.channel || channel,
        ts: response.ts || "",
        message: response.message,
      };
    } catch (error) {
      console.error("Error posting message:", error);
      return {
        ok: false,
        channel,
        ts: "",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update an existing message
   */
  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    options?: {
      blocks?: any[];
      parse?: string;
      linkNames?: boolean;
    },
  ): Promise<MessageResponse> {
    try {
      const response = await this.client.chat.update({
        channel,
        ts,
        text,
        blocks: options?.blocks,
        parse: options?.parse || "none",
        link_names: options?.linkNames || false,
      }) as ChatUpdateResponse;

      if (!response.ok) {
        return {
          ok: false,
          channel,
          ts,
          error: response.error || "Unknown error",
        };
      }

      return {
        ok: true,
        channel: response.channel || channel,
        ts: response.ts || ts,
        message: response.message,
      };
    } catch (error) {
      console.error("Error updating message:", error);
      return {
        ok: false,
        channel,
        ts,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Add a reaction to a message
   */
  async addReaction(
    channel: string,
    timestamp: string,
    emoji: string,
  ): Promise<ReactionResponse> {
    try {
      const response = await this.client.reactions.add({
        channel,
        timestamp,
        name: emoji,
      });

      if (!response.ok) {
        return {
          ok: false,
          error: response.error || "Unknown error",
        };
      }

      return { ok: true };
    } catch (error) {
      console.error("Error adding reaction:", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Remove a reaction from a message
   */
  async removeReaction(
    channel: string,
    timestamp: string,
    emoji: string,
  ): Promise<ReactionResponse> {
    try {
      const response = await this.client.reactions.remove({
        channel,
        timestamp,
        name: emoji,
      });

      if (!response.ok) {
        return {
          ok: false,
          error: response.error || "Unknown error",
        };
      }

      return { ok: true };
    } catch (error) {
      console.error("Error removing reaction:", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get the permalink for a message
   */
  async getPermalink(channel: string, messageTs: string): Promise<string | null> {
    try {
      const response = await this.client.chat.getPermalink({
        channel,
        message_ts: messageTs,
      });

      if (!response.ok || !response.permalink) {
        return null;
      }

      return response.permalink;
    } catch (error) {
      console.error("Error getting permalink:", error);
      return null;
    }
  }

  /**
   * Get user information
   */
  async getUserInfo(userId: string): Promise<{ displayName?: string; realName?: string } | null> {
    try {
      const response = await this.client.users.info({
        user: userId,
      });

      if (!response.ok || !response.user) {
        return null;
      }

      return {
        displayName: response.user.display_name || response.user.name,
        realName: response.user.real_name,
      };
    } catch (error) {
      console.error("Error getting user info:", error);
      return null;
    }
  }

  /**
   * Get conversation history (for context)
   */
  async getConversationHistory(
    channel: string,
    options?: {
      oldest?: string;
      latest?: string;
      limit?: number;
      inclusive?: boolean;
    },
  ): Promise<any[]> {
    try {
      const response = await this.client.conversations.history({
        channel,
        oldest: options?.oldest,
        latest: options?.latest,
        limit: options?.limit || 10,
        inclusive: options?.inclusive || true,
      });

      if (!response.ok || !response.messages) {
        return [];
      }

      return response.messages;
    } catch (error) {
      console.error("Error getting conversation history:", error);
      return [];
    }
  }

  /**
   * Get thread replies (for threaded conversations)
   */
  async getThreadReplies(
    channel: string,
    threadTs: string,
    options?: {
      limit?: number;
      oldest?: string;
      latest?: string;
    },
  ): Promise<any[]> {
    try {
      const response = await this.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: options?.limit || 10,
        oldest: options?.oldest,
        latest: options?.latest,
      });

      if (!response.ok || !response.messages) {
        return [];
      }

      return response.messages;
    } catch (error) {
      console.error("Error getting thread replies:", error);
      return [];
    }
  }

  /**
   * Batch operations with retry logic
   */
  async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt === maxRetries) {
          throw lastError;
        }

        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt - 1)));
      }
    }

    throw lastError!;
  }
}