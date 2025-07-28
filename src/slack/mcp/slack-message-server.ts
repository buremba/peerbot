#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { SlackApiClient } from "../api/client";
import type { SlackMessageOperations } from "../operations/message";
import { SlackMessageManager } from "../operations/message";

export interface SlackMessageServerConfig {
  slackToken: string;
  trackingMessageTs?: string;
  trackingChannelId?: string;
}

/**
 * MCP server for Slack message operations
 * Allows Claude to update its own Slack messages during execution
 */
export class SlackMessageServer {
  private server: Server;
  private client: SlackApiClient;
  private messageManager: SlackMessageManager;
  private config: SlackMessageServerConfig;

  constructor(config: SlackMessageServerConfig) {
    this.config = config;
    this.server = new Server(
      {
        name: "slack-message-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.client = new SlackApiClient({ token: config.slackToken });
    this.messageManager = new SlackMessageManager(this.client);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "mcp__slack_message__update_message",
            description: "Update the current Slack message with new content. Use this to provide real-time progress updates and final results.",
            inputSchema: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                  description: "The updated message text (supports Slack markdown formatting)",
                },
                channel: {
                  type: "string",
                  description: "Channel ID (optional, will use current channel if not provided)",
                },
                ts: {
                  type: "string", 
                  description: "Message timestamp (optional, will use current message if not provided)",
                },
                parse: {
                  type: "string",
                  description: "How to parse the message text. Options: 'none', 'full'. Defaults to 'none'.",
                  enum: ["none", "full"],
                },
              },
              required: ["text"],
            },
          },
          {
            name: "mcp__slack_message__post_message",
            description: "Post a new message to a Slack channel or thread",
            inputSchema: {
              type: "object",
              properties: {
                channel: {
                  type: "string",
                  description: "Channel ID where to post the message",
                },
                text: {
                  type: "string",
                  description: "Message text (supports Slack markdown formatting)",
                },
                thread_ts: {
                  type: "string",
                  description: "Timestamp of parent message to reply in thread (optional)",
                },
                parse: {
                  type: "string",
                  description: "How to parse the message text. Options: 'none', 'full'. Defaults to 'none'.",
                  enum: ["none", "full"],
                },
              },
              required: ["channel", "text"],
            },
          },
          {
            name: "mcp__slack_message__get_conversation_history",
            description: "Get recent messages from a Slack channel for context",
            inputSchema: {
              type: "object",
              properties: {
                channel: {
                  type: "string",
                  description: "Channel ID to get history from",
                },
                limit: {
                  type: "number",
                  description: "Number of messages to retrieve (default: 10, max: 100)",
                  minimum: 1,
                  maximum: 100,
                },
                oldest: {
                  type: "string",
                  description: "Only messages after this timestamp",
                },
                latest: {
                  type: "string", 
                  description: "Only messages before this timestamp",
                },
              },
              required: ["channel"],
            },
          },
          {
            name: "mcp__slack_message__get_thread_replies",
            description: "Get replies in a Slack thread",
            inputSchema: {
              type: "object",
              properties: {
                channel: {
                  type: "string",
                  description: "Channel ID containing the thread",
                },
                ts: {
                  type: "string",
                  description: "Timestamp of the parent message",
                },
                limit: {
                  type: "number",
                  description: "Number of replies to retrieve (default: 10, max: 100)",
                  minimum: 1,
                  maximum: 100,
                },
              },
              required: ["channel", "ts"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "mcp__slack_message__update_message":
            return await this.handleUpdateMessage(args);
          case "mcp__slack_message__post_message":
            return await this.handlePostMessage(args);
          case "mcp__slack_message__get_conversation_history":
            return await this.handleGetConversationHistory(args);
          case "mcp__slack_message__get_thread_replies":
            return await this.handleGetThreadReplies(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`,
            );
        }
      } catch (error) {
        console.error(`Error in tool ${name}:`, error);
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    });
  }

  private async handleUpdateMessage(args: any) {
    const { text, channel, ts, parse } = args;

    // Use provided values or fall back to tracking values
    const targetChannel = channel || this.config.trackingChannelId;
    const targetTs = ts || this.config.trackingMessageTs;

    if (!targetChannel || !targetTs) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "No channel or message timestamp available for update",
      );
    }

    const result = await this.messageManager.updateResponse(
      targetChannel,
      targetTs,
      text,
    );

    if (!result.success) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to update message: ${result.error}`,
      );
    }

    return {
      content: [
        {
          type: "text",
          text: `Message updated successfully in channel ${targetChannel}`,
        },
      ],
    };
  }

  private async handlePostMessage(args: any) {
    const { channel, text, thread_ts, parse } = args;

    const response = await this.client.postMessage(channel, text, {
      threadTs: thread_ts,
      parse,
    });

    if (!response.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to post message: ${response.error}`,
      );
    }

    return {
      content: [
        {
          type: "text",
          text: `Message posted successfully. Channel: ${response.channel}, Timestamp: ${response.ts}`,
        },
      ],
    };
  }

  private async handleGetConversationHistory(args: any) {
    const { channel, limit = 10, oldest, latest } = args;

    const messages = await this.client.getConversationHistory(channel, {
      limit: Math.min(limit, 100),
      oldest,
      latest,
    });

    const formattedMessages = messages.map((msg) => ({
      user: msg.user || "unknown",
      text: msg.text || "",
      ts: msg.ts,
      type: msg.type || "message",
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(formattedMessages, null, 2),
        },
      ],
    };
  }

  private async handleGetThreadReplies(args: any) {
    const { channel, ts, limit = 10 } = args;

    const messages = await this.client.getThreadReplies(channel, ts, {
      limit: Math.min(limit, 100),
    });

    const formattedMessages = messages.map((msg) => ({
      user: msg.user || "unknown",
      text: msg.text || "",
      ts: msg.ts,
      type: msg.type || "message",
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(formattedMessages, null, 2),
        },
      ],
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log("Slack Message MCP server running on stdio");
  }

  updateTrackingInfo(channelId: string, messageTs: string): void {
    this.config.trackingChannelId = channelId;
    this.config.trackingMessageTs = messageTs;
  }
}

// CLI runner for the MCP server
async function main() {
  const slackToken = process.env.SLACK_BOT_TOKEN || process.env.SLACK_TOKEN;
  if (!slackToken) {
    console.error("SLACK_BOT_TOKEN or SLACK_TOKEN environment variable is required");
    process.exit(1);
  }

  const server = new SlackMessageServer({
    slackToken,
    trackingChannelId: process.env.SLACK_TRACKING_CHANNEL_ID,
    trackingMessageTs: process.env.SLACK_TRACKING_MESSAGE_TS,
  });

  await server.run();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Failed to start Slack Message MCP server:", error);
    process.exit(1);
  });
}