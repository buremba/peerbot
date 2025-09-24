#!/usr/bin/env bun

import { WebClient } from "@slack/web-api";
import PgBoss from "pg-boss";
import type { GitHubRepositoryManager } from "../github/repository-manager";
import { processMarkdownAndBlockkit } from "../converters/blockkit-processor";
import { generateGitHubActionButtons } from "../converters/github-actions";
import logger from "../logger";

interface ThreadResponsePayload {
  messageId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  content?: string;
  processedMessageIds?: string[];
  reaction?: string;
  error?: string;
  timestamp: number;
  originalMessageTs?: string; // User's original message timestamp for reactions
  gitBranch?: string; // Current git branch for Edit button URLs
  hasGitChanges?: boolean; // Whether there are uncommitted/unpushed changes
  pullRequestUrl?: string; // URL of existing PR if any
  botResponseTs?: string; // Bot's response message timestamp for updates
  claudeSessionId?: string; // Claude session ID for tracking bot messages per session
}

/**
 * Consumer that listens to thread_response queue and updates Slack messages
 * This handles all Slack communication that was previously done by the worker
 */
export class ThreadResponseConsumer {
  private pgBoss: PgBoss;
  private slackClient: WebClient;
  private isRunning = false;
  private repoManager: GitHubRepositoryManager;
  private userMappings: Map<string, string>; // slackUserId -> githubUsername
  private sessionBotMessages: Map<string, string> = new Map(); // sessionKey -> botMessageTs

  constructor(
    connectionString: string,
    slackToken: string,
    repoManager: GitHubRepositoryManager,
    userMappings: Map<string, string>
  ) {
    this.pgBoss = new PgBoss(connectionString);
    this.slackClient = new WebClient(slackToken);
    this.repoManager = repoManager;
    this.userMappings = userMappings;
  }

  /**
   * Start consuming thread_response messages
   */
  async start(): Promise<void> {
    try {
      await this.pgBoss.start();

      // Create the thread_response queue if it doesn't exist
      await this.pgBoss.createQueue("thread_response");

      // Register job handler for thread response messages
      await this.pgBoss.work(
        "thread_response",
        this.handleThreadResponse.bind(this)
      );

      this.isRunning = true;
      logger.info("✅ Thread response consumer started");
    } catch (error) {
      logger.error("Failed to start thread response consumer:", error);
      throw error;
    }
  }

  /**
   * Stop the consumer
   */
  async stop(): Promise<void> {
    try {
      this.isRunning = false;
      await this.pgBoss.stop();
      logger.info("✅ Thread response consumer stopped");
    } catch (error) {
      logger.error("Error stopping thread response consumer:", error);
      throw error;
    }
  }

  /**
   * Handle thread response message jobs
   */
  private async handleThreadResponse(job: any): Promise<void> {
    let data;

    try {
      // Handle PgBoss serialized format (similar to worker queue consumer)
      if (typeof job === "object" && job !== null) {
        const keys = Object.keys(job);
        const numericKeys = keys.filter((key) => !Number.isNaN(Number(key)));

        if (numericKeys.length > 0) {
          // PgBoss passes jobs as an array, get the first element
          const firstKey = numericKeys[0];
          const firstJob = firstKey ? job[firstKey] : null;

          if (
            typeof firstJob === "object" &&
            firstJob !== null &&
            firstJob.data
          ) {
            // This is the actual job object from PgBoss
            data = firstJob.data;
            console.log(
              `📤 AGENT RESPONSE: Processing agent response for user ${data.userId}, thread ${data.threadId || "unknown"}, jobId: ${firstJob.id}`
            );
          } else {
            throw new Error(
              "Invalid job format: expected job object with data field"
            );
          }
        } else {
          // Fallback - might be normal job format
          data = job.data || job;
        }
      } else {
        data = job;
      }

      if (!data || !data.messageId) {
        throw new Error(
          `Invalid thread response data: ${JSON.stringify(data)}`
        );
      }

      logger.info(
        `Processing thread response job for message ${data.messageId}, originalMessageTs: ${data.originalMessageTs}, claudeSessionId: ${data.claudeSessionId}, botResponseTs: ${data.botResponseTs}`
      );

      // Create a session key to track bot messages per conversation
      // Use the claudeSessionId as the primary key when available
      // This ensures all messages from the same worker session update the same bot message
      const sessionKey = data.claudeSessionId
        ? `session:${data.claudeSessionId}`
        : `${data.userId}:${data.originalMessageTs || data.messageId}`;

      logger.info(`Using session key: ${sessionKey}`);

      // Check if we have a bot message for this Claude session
      // First check if the worker provided a bot message timestamp
      const existingBotMessageTs =
        data.botResponseTs || this.sessionBotMessages.get(sessionKey);
      const isFirstResponse = !existingBotMessageTs;
      // Use originalMessageTs for reactions (the actual user message timestamp)
      const reactionTimestamp = data.originalMessageTs || data.messageId;

      // Handle reaction transitions without gear. Completion is signaled by processedMessageIds presence.
      const isDM = data.channelId?.startsWith("D");
      if (data.error && reactionTimestamp) {
        // Error: change eyes to x on the relevant message
        await this.updateReaction(
          data.channelId,
          reactionTimestamp,
          "eyes",
          "x"
        );
      }

      // On completion, processedMessageIds will be provided
      if (
        Array.isArray(data.processedMessageIds) &&
        data.processedMessageIds.length > 0
      ) {
        if (isDM) {
          // Remove eyes from each processed user message (no checkmarks in DMs)
          for (const ts of data.processedMessageIds) {
            try {
              await this.slackClient.reactions.remove({
                channel: data.channelId,
                timestamp: ts,
                name: "eyes",
              });
            } catch (_e) {
              // ignore if reaction not present
            }
          }
        } else {
          // Channel: only the root thread message should get the checkmark
          await this.updateReaction(
            data.channelId,
            data.threadTs,
            "eyes",
            "white_check_mark"
          );
        }
      }

      // Handle message content
      if (data.content) {
        // Pass the existing bot message timestamp if we have one
        const botMessageTs = existingBotMessageTs || data.botResponseTs;
        const newBotResponseTs = await this.handleMessageUpdate(
          data,
          isFirstResponse,
          botMessageTs
        );

        // Store the bot response timestamp for future updates
        if (isFirstResponse && newBotResponseTs) {
          logger.info(
            `Bot created first response with ts: ${newBotResponseTs}, storing for session ${sessionKey}`
          );
          this.sessionBotMessages.set(sessionKey, newBotResponseTs);

          // Also send the bot message timestamp back to the worker for future updates
          // This ensures the worker can include it in subsequent thread_response messages
          try {
            if (data.claudeSessionId) {
              await this.pgBoss.send("worker_metadata_update", {
                claudeSessionId: data.claudeSessionId,
                botResponseTs: newBotResponseTs,
                channelId: data.channelId,
                threadTs: data.threadTs,
              });
            }
          } catch (error) {
            logger.debug(
              `Failed to send bot message timestamp to worker: ${error}`
            );
          }
        }
      } else if (data.error) {
        // Pass the existing bot message timestamp for error updates
        const botMessageTs = existingBotMessageTs || data.botResponseTs;
        await this.handleError(data, isFirstResponse, botMessageTs);
      }

      // Log completion when processedMessageIds is present but DON'T clear session
      // Keep the session active so any late-arriving messages still update the same bot message
      if (
        Array.isArray(data.processedMessageIds) &&
        data.processedMessageIds.length > 0
      ) {
        logger.info(
          `Thread processing completed for message ${data.messageId}`
        );
        // Don't clear the session here - it will be cleared when a new user message arrives
        // This prevents duplicate bot messages if the worker sends more messages after completion
      }
    } catch (error: any) {
      // Check if it's a validation error that shouldn't be retried
      if (
        error?.data?.error === "invalid_blocks" ||
        error?.data?.error === "msg_too_long" ||
        error?.code === "slack_webapi_platform_error"
      ) {
        logger.error(
          `Slack validation error in job ${job.id}: ${error?.data?.error || error.message}`
        );

        // Try to inform the user about the validation error
        if (data?.channelId && data.messageId) {
          try {
            await this.slackClient.chat.update({
              channel: data.channelId,
              ts: data.messageId,
              text: `❌ **Message update failed**\n\n**Error:** ${error?.data?.error || error.message}\n\nThe response may contain invalid formatting or be too long for Slack.`,
            });
            logger.info(
              `Notified user about validation error in job ${job.id}`
            );
          } catch (notifyError) {
            logger.error(
              `Failed to notify user about validation error: ${notifyError}`
            );
          }
        }

        // Don't throw - mark job as complete to prevent retry loops
        return;
      }

      logger.error(`Failed to process thread response job ${job.id}:`, error);
      throw error; // Let pgboss handle retry logic for other errors
    }
  }

  /**
   * Update reactions atomically (remove old, add new)
   */
  private async updateReaction(
    channel: string,
    timestamp: string,
    oldReaction: string,
    newReaction: string
  ): Promise<void> {
    console.log(
      `🔄 REACTION UPDATE: Changing ${oldReaction} → ${newReaction} on message ${timestamp} in channel ${channel}`
    );

    try {
      // Remove old reaction
      console.log(
        `🗑️  REACTION CHANGE: Removing '${oldReaction}' from message ${timestamp}`
      );
      await this.slackClient.reactions.remove({
        channel,
        timestamp,
        name: oldReaction,
      });
      console.log(
        `✅ REACTION REMOVED: '${oldReaction}' successfully removed from message ${timestamp}`
      );
    } catch (error) {
      // Ignore - reaction might not exist
      console.log(
        `⚠️  REACTION REMOVE: '${oldReaction}' reaction might not exist on message ${timestamp}:`,
        error
      );
      logger.debug(
        `Failed to remove ${oldReaction} reaction (might not exist):`,
        error
      );
    }

    try {
      // Add new reaction
      console.log(
        `➕ REACTION CHANGE: Adding '${newReaction}' to message ${timestamp}`
      );
      await this.slackClient.reactions.add({
        channel,
        timestamp,
        name: newReaction,
      });
      console.log(
        `✅ REACTION ADDED: '${newReaction}' successfully added to message ${timestamp}`
      );
      logger.info(
        `Updated reaction: ${oldReaction} → ${newReaction} on message ${timestamp}`
      );
    } catch (error) {
      // Ignore - reaction might already exist
      logger.debug(
        `Failed to add ${newReaction} reaction (might already exist):`,
        error
      );
    }
  }

  /**
   * Handle message content updates
   */
  private async handleMessageUpdate(
    data: ThreadResponsePayload,
    isFirstResponse: boolean,
    botMessageTs?: string
  ): Promise<string | undefined> {
    const { content, channelId, threadTs, userId } = data;

    if (!content) return;

    try {
      let result: { text: string; blocks: any[] };

      // Check if content is JSON with blocks (from authentication prompt)
      try {
        const parsed = JSON.parse(content);
        if (parsed.blocks && Array.isArray(parsed.blocks)) {
          // Content is already formatted blocks from the worker
          console.log(
            `[DEBUG] Content is pre-formatted blocks - blocks count: ${parsed.blocks.length}`
          );
          result = {
            text: parsed.blocks[0]?.text?.text || "Authentication required",
            blocks: parsed.blocks,
          };
        } else {
          throw new Error("Not blocks format");
        }
      } catch {
        // Not JSON or not blocks format - process as markdown
        console.log(
          `[DEBUG] Processing content for Slack - content length: ${content?.length || 0}`
        );
        result = processMarkdownAndBlockkit(content);
        console.log(
          `[DEBUG] processMarkdownAndBlockkit result - blocks: ${result.blocks?.length || 0}, has actions: ${result.blocks?.some((b) => b.type === "actions")}`
        );
      }

      // Get GitHub action buttons for this session
      const githubActionButtons = await generateGitHubActionButtons(
        userId,
        data.gitBranch,
        data.hasGitChanges,
        data.pullRequestUrl,
        this.userMappings,
        this.repoManager,
        this.slackClient
      );

      // Add GitHub action buttons as a separate actions block
      if (githubActionButtons && githubActionButtons.length > 0) {
        // Add a divider before the GitHub actions if there are other blocks
        if (result.blocks.length > 0) {
          result.blocks.push({ type: "divider" });
        }

        // Add the GitHub action buttons as an actions block
        result.blocks.push({
          type: "actions",
          elements: githubActionButtons,
        });
      }

      // Truncate text to Slack's limit (3000 chars for text field)
      const MAX_TEXT_LENGTH = 3000;
      const truncatedText =
        (result.text || content).length > MAX_TEXT_LENGTH
          ? (result.text || content).substring(0, MAX_TEXT_LENGTH - 20) +
            "\n...[truncated]"
          : result.text || content;

      // Add blocks (always have at least one)
      const MAX_BLOCKS = 50;
      const blocks = result.blocks.slice(0, MAX_BLOCKS);
      console.log(
        `[DEBUG] Final blocks to send - count: ${blocks.length}, types: ${blocks.map((b) => b.type).join(", ")}`
      );
      if (blocks.some((b) => b.type === "actions")) {
        console.log(
          `[DEBUG] Actions block elements:`,
          blocks.find((b) => b.type === "actions")?.elements
        );
      }

      if (isFirstResponse) {
        // Create new message for first response
        logger.info(
          `Creating new bot message in channel ${channelId}, thread ${threadTs}`
        );
        const postResult = await this.slackClient.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: truncatedText,
          mrkdwn: true,
          blocks: blocks,
          unfurl_links: true,
          unfurl_media: true,
        });

        logger.info(
          `Bot message created: ${postResult.ok}, ts: ${postResult.ts}`
        );

        if (!postResult.ok) {
          logger.error(`Failed to create bot message: ${postResult.error}`);
          return;
        }

        // CRITICAL: Validate that Slack created the message in the correct thread
        const returnedTs = postResult.ts as string;
        const returnedThreadTs =
          (postResult.message as any)?.thread_ts || returnedTs;

        // Check if the message was created in the intended thread
        if (threadTs && returnedThreadTs !== threadTs) {
          // Delete the wrongly placed message
          try {
            await this.slackClient.chat.delete({
              channel: channelId,
              ts: returnedTs,
            });
            logger.info(`Deleted misplaced message ${returnedTs}`);
          } catch (deleteError) {
            logger.error(`Failed to delete misplaced message:`, deleteError);
          }

          // Retry with explicit thread creation
          await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second

          const retryResult = await this.slackClient.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: truncatedText,
            mrkdwn: true,
            blocks: blocks,
            unfurl_links: true,
            unfurl_media: true,
            reply_broadcast: false, // Ensure it stays in thread
          });

          if (!retryResult.ok) {
            throw new Error(
              `Failed to create bot message after retry: ${retryResult.error}`
            );
          }

          return retryResult.ts as string;
        }

        return returnedTs; // Return the new message timestamp
      } else {
        // Update existing message - use the passed botMessageTs or fallback
        const botTs = botMessageTs || data.botResponseTs || threadTs;
        logger.info(
          `Updating bot message in channel ${channelId}, ts ${botTs}`
        );

        const updateResult = await this.slackClient.chat.update({
          channel: channelId,
          ts: botTs,
          text: truncatedText,
          blocks: blocks,
        });

        logger.info(`Slack update result: ${updateResult.ok}`);

        if (!updateResult.ok) {
          logger.error(`Slack update failed with error: ${updateResult.error}`);
        }
      }
    } catch (error: any) {
      // Handle specific Slack errors
      if (error.code === "message_not_found") {
        logger.error("Slack message not found - it may have been deleted");
      } else if (error.code === "channel_not_found") {
        logger.error("Slack channel not found - bot may not have access");
      } else if (error.code === "not_in_channel") {
        logger.error("Bot is not in the channel");
      } else if (
        error.data?.error === "invalid_blocks" ||
        error.data?.error === "msg_too_long"
      ) {
        // These are Slack validation errors - retrying won't help
        logger.error(`Slack validation error: ${JSON.stringify(error)}`);

        // Try to send a simple error message with raw content for recovery
        try {
          // Truncate content to fit in code block (leave room for error message + code block formatting)
          const maxContentLength = 2500; // Conservative limit
          const truncatedContent =
            content.length > maxContentLength
              ? `${content.substring(0, maxContentLength)}\n...[truncated]`
              : content;

          const errorMessage = `❌ *Error occurred while updating message*\n\n*Error:* ${error.data?.error || ""}${error.message || ""}\n\nThe response may be too long or contain invalid formatting.\n\n*Raw Content:*\n\`\`\`\n${truncatedContent}\n\`\`\``;

          await this.slackClient.chat.update({
            channel: channelId,
            ts: threadTs,
            text: errorMessage,
          });
          logger.info(
            `Sent fallback error message with raw content for validation error: ${error.data?.error}`
          );
        } catch (fallbackError) {
          logger.error("Failed to send fallback error message:", fallbackError);
          // If even the fallback fails, try a minimal message
          try {
            await this.slackClient.chat.update({
              channel: channelId,
              ts: threadTs,
              text: `❌ *Error occurred while updating message*\n\n*Error:* ${error.data?.error || error.message}`,
            });
          } catch (minimalError) {
            logger.error("Failed to send minimal error message:", minimalError);
          }
        }
        // Don't throw - this prevents retry loops for validation errors
      } else {
        logger.error(`Failed to update Slack message: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Handle error messages
   */
  private async handleError(
    data: ThreadResponsePayload,
    isFirstResponse: boolean,
    botMessageTs?: string
  ): Promise<void> {
    const { error, channelId, threadTs, userId } = data;

    if (!error) return;

    try {
      logger.info(
        `Sending error message to channel ${channelId}, thread ${threadTs}`
      );

      const errorContent = `❌ **Error occurred**\n\n**Error:** \`${error}\``;

      // Simple error message
      const errorResult = {
        text: errorContent,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: errorContent,
            },
          },
        ],
      };

      // Get GitHub action buttons for this session
      const githubActionButtons = await generateGitHubActionButtons(
        userId,
        data.gitBranch,
        data.hasGitChanges,
        data.pullRequestUrl,
        this.userMappings,
        this.repoManager,
        this.slackClient
      );

      // Add GitHub action buttons if available
      if (githubActionButtons && githubActionButtons.length > 0) {
        // Add a divider before the GitHub actions
        errorResult.blocks.push({
          type: "divider",
        } as any);

        // Add the GitHub action buttons as an actions block
        errorResult.blocks.push({
          type: "actions",
          elements: githubActionButtons,
        } as any);
      }

      if (isFirstResponse) {
        // Create new error message
        const postResult = await this.slackClient.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: errorResult.text || errorContent,
          mrkdwn: true,
          blocks: errorResult.blocks,
          unfurl_links: true,
          unfurl_media: true,
        });
        logger.info(`Error message created: ${postResult.ok}`);
      } else {
        // Update existing message with error - use the passed botMessageTs or fallback
        const botTs = botMessageTs || data.botResponseTs || threadTs;
        const updateResult = await this.slackClient.chat.update({
          channel: channelId,
          ts: botTs,
          text: errorResult.text || errorContent,
          blocks: errorResult.blocks,
        });
        logger.info(`Error message update result: ${updateResult.ok}`);
      }
    } catch (updateError: any) {
      logger.error(
        `Failed to send error message to Slack: ${updateError.message}`
      );
      throw updateError;
    }
  }

  /**
   * Check if consumer is running and healthy
   */
  isHealthy(): boolean {
    return this.isRunning;
  }

  /**
   * Get current status
   */
  getStatus(): {
    isRunning: boolean;
  } {
    return {
      isRunning: this.isRunning,
    };
  }
}