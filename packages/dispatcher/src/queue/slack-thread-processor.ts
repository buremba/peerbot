#!/usr/bin/env bun

import PgBoss from "pg-boss";
import { WebClient } from "@slack/web-api";
import { createHash } from "crypto";
import type { GitHubRepositoryManager } from "../github/repository-manager";

// Generate deterministic action IDs based on content to prevent conflicts during rapid message updates - fixed
function generateDeterministicActionId(content: string, prefix: string = "action"): string {
  const hash = createHash('sha256').update(content).digest('hex').substring(0, 8);
  return `${prefix}_${hash}`;
}
// Simple blockkit detection and conversion for now
function processMarkdownAndBlockkit(content: string): { text: string; blocks: any[] } {
  // Process blockkit with metadata
  const codeBlockRegex = /```(\w+)\s*\{([^}]+)\}\s*\n?([\s\S]*?)\n?```/g;
  let processedContent = content;
  const actionButtons: any[] = [];
  let blockIndex = 0; // Track position to ensure unique action_ids

  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const [fullMatch, language, metadataStr, codeContent] = match;
    
    try {
      const metadata: any = {};
      metadataStr?.split(',').forEach(pair => {
        const [key, value] = pair.split(':').map(s => s.trim());
        if (key && value) {
          const cleanKey = key.replace(/"/g, '');
          let cleanValue: any = value.replace(/"/g, '');
          if (cleanValue === 'true') cleanValue = true;
          if (cleanValue === 'false') cleanValue = false;
          metadata[cleanKey] = cleanValue;
        }
      });

      if (metadata.action) {
        if (metadata.show === false) {
          console.log(`[DEBUG] Skipping blockkit with show:false - action: ${metadata.action}`);
          processedContent = processedContent.replace(fullMatch, '');
          continue;
        }
        
        if (language === 'blockkit') {
          const parsed = codeContent ? JSON.parse(codeContent.trim()) : { blocks: [] };
          const actionId = generateDeterministicActionId(codeContent + metadata.action + blockIndex, 'blockkit_form');
          actionButtons.push({
            type: "button",
            text: { type: "plain_text", text: metadata.action },
            action_id: actionId,
            value: JSON.stringify({ blocks: parsed.blocks || [parsed] })
          });
          processedContent = processedContent.replace(fullMatch, '');
        } else {
          if (codeContent && codeContent.length <= 2000) {
            const actionId = generateDeterministicActionId(codeContent + metadata.action + blockIndex, language);
            actionButtons.push({
              type: "button",
              text: { type: "plain_text", text: metadata.action },
              action_id: actionId,
              value: codeContent
            });
          }
          if (metadata.show === false) {
            processedContent = processedContent.replace(fullMatch, '');
          }
        }
      }
      
      blockIndex++; // Increment for each processed block to ensure unique action_ids
    } catch (error) {
      console.error('Failed to parse code block:', error);
    }
  }

  // Convert basic markdown
  const text = processedContent
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')
    .trim();

  // Always create at least one block
  const blocks: any[] = [];
  
  if (text) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: text
      }
    });
  }

  if (actionButtons.length > 0) {
    if (blocks.length > 0) blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      elements: actionButtons
    });
  }

  return { text, blocks };
}


/**
 * Generate GitHub action buttons for the session branch
 */
async function generateGitHubActionButtons(
  userId: string,
  gitBranch: string | undefined,
  userMappings: Map<string, string>,
  repoManager: GitHubRepositoryManager,
  slackClient?: any
): Promise<any[] | undefined> {
  try {
    logger.debug(`Generating GitHub action buttons for user ${userId}, gitBranch: ${gitBranch}`);
    
    // If no git branch provided, don't show Edit button
    if (!gitBranch) {
      logger.debug(`No git branch provided, skipping Edit button`);
      return undefined;
    }
    
    // Get GitHub username from Slack user ID
    let githubUsername = userMappings.get(userId);
    if (!githubUsername && slackClient) {
      // Create user mapping on-demand if not found
      logger.debug(`Creating on-demand user mapping for user ${userId}`);
      try {
        const userInfo = await slackClient.users.info({ user: userId });
        const user = userInfo.user;
        
        let username = user.profile?.display_name || user.profile?.real_name || user.name;
        if (!username) {
          username = userId;
        }
        
        // Sanitize username for GitHub
        username = username.toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/^-|-$/g, "");
        
        username = `user-${username}`;
        userMappings.set(userId, username);
        githubUsername = username;
        
        logger.info(`Created user mapping: ${userId} -> ${username}`);
      } catch (error) {
        logger.error(`Failed to create user mapping for ${userId}:`, error);
        const fallbackUsername = `user-${userId.substring(0, 8)}`;
        userMappings.set(userId, fallbackUsername);
        githubUsername = fallbackUsername;
      }
    }
    
    if (!githubUsername) {
      logger.debug(`No GitHub username mapping found for user ${userId}`);
      return undefined;
    }

    // Get repository information, create if needed
    const repository = await repoManager.ensureUserRepository(githubUsername);
    if (!repository) {
      logger.debug(`No repository found for GitHub user ${githubUsername}`);
      return undefined;
    }

    const repoUrl = repository.repositoryUrl;
    const repoPath = repoUrl.replace('https://github.com/', '');
    
    logger.info(`Showing Edit button for branch: ${gitBranch}`);
    return [
      `<https://github.com/${repoPath}/compare/main...${gitBranch}?quick_pull=1&labels=peerbot|🔀 Pull Request>`,
      `<https://github.dev/${repoPath}/tree/${gitBranch}|Code>`,
    ];
  } catch (error) {
    // Return undefined on error - this will result in no action buttons being added
    return undefined;
  }
}

import logger from "../logger";

interface ThreadResponsePayload {
  messageId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  content?: string;
  isDone: boolean;
  reaction?: string;
  error?: string;
  timestamp: number;
  originalMessageTs?: string; // User's original message timestamp for reactions
  gitBranch?: string; // Current git branch for Edit button URLs
  botResponseTs?: string; // Bot's response message timestamp for updates
  envChanges?: boolean; // Flag indicating environment was modified
  modifiedFiles?: string[]; // Files changed (e.g. [".devcontainer/devcontainer.json"])
  currentCommit?: string; // Current git HEAD after changes
  repositoryUrl?: string; // Repository URL for rebuild context
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
      await this.pgBoss.createQueue('thread_response');
      
      // Register job handler for thread response messages
      await this.pgBoss.work(
        'thread_response',
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
      if (typeof job === 'object' && job !== null) {
        const keys = Object.keys(job);
        const numericKeys = keys.filter(key => !isNaN(Number(key)));
        
        if (numericKeys.length > 0) {
          // PgBoss passes jobs as an array, get the first element
          const firstKey = numericKeys[0];
          const firstJob = firstKey ? job[firstKey] : null;
          
          if (typeof firstJob === 'object' && firstJob !== null && firstJob.data) {
            // This is the actual job object from PgBoss
            data = firstJob.data;
            console.log(`📤 AGENT RESPONSE: Processing agent response for user ${data.userId}, thread ${data.threadId || 'unknown'}, jobId: ${firstJob.id}`);
          } else {
            throw new Error('Invalid job format: expected job object with data field');
          }
        } else {
          // Fallback - might be normal job format
          data = job.data || job;
        }
      } else {
        data = job;
      }
      
      if (!data || !data.messageId) {
        throw new Error(`Invalid thread response data: ${JSON.stringify(data)}`);
      }
      
      logger.info(`Processing thread response job for message ${data.messageId}`);

      // Create a session key to track bot messages per thread
      const sessionKey = `${data.userId}:${data.threadTs}`;
      
      // Check if we have a bot message for this session
      const existingBotMessageTs = this.sessionBotMessages.get(sessionKey);
      const isFirstResponse = !existingBotMessageTs && !data.botResponseTs;
      const reactionTimestamp = data.originalMessageTs || data.messageId;
      
      // Handle reaction transitions
      if (reactionTimestamp) {
        if (isFirstResponse && !data.isDone && !data.error) {
          // First pickup by worker: Replace eyes with gear
          await this.updateReaction(data.channelId, reactionTimestamp, "eyes", "gear");
        } else if (data.isDone) {
          // Processing completed: Replace gear with checkmark
          await this.updateReaction(data.channelId, reactionTimestamp, "gear", "white_check_mark");
        } else if (data.error) {
          // Error occurred: Replace current reaction with error
          await this.updateReaction(data.channelId, reactionTimestamp, "gear", "x");
          await this.updateReaction(data.channelId, reactionTimestamp, "eyes", "x");
        }
      }
      
      // Handle message content
      if (data.content) {
        // Pass the existing bot message timestamp if we have one
        const botMessageTs = existingBotMessageTs || data.botResponseTs;
        const newBotResponseTs = await this.handleMessageUpdate(data, isFirstResponse, botMessageTs);
        
        // Store the bot response timestamp for future updates
        if (isFirstResponse && newBotResponseTs) {
          logger.info(`Bot created first response with ts: ${newBotResponseTs}, storing for session ${sessionKey}`);
          this.sessionBotMessages.set(sessionKey, newBotResponseTs);
        }
      } else if (data.error) {
        // Pass the existing bot message timestamp for error updates
        const botMessageTs = existingBotMessageTs || data.botResponseTs;
        await this.handleError(data, isFirstResponse, botMessageTs);
      }

      // Handle environment changes - forward rebuild request to orchestrator
      if (data.envChanges && data.currentCommit && data.repositoryUrl) {
        logger.info(`Environment change detected for thread ${data.threadTs}: ${data.modifiedFiles?.join(', ')}`);
        await this.handleEnvironmentChange(data);
      }

      // Log completion
      if (data.isDone) {
        logger.info(`Thread processing completed for message ${data.messageId}`);
      }

    } catch (error: any) {
      // Check if it's a validation error that shouldn't be retried
      if (error?.data?.error === "invalid_blocks" || 
          error?.data?.error === "msg_too_long" ||
          error?.code === "slack_webapi_platform_error") {
        logger.error(`Slack validation error in job ${job.id}: ${error?.data?.error || error.message}`);
        
        // Try to inform the user about the validation error
        if (data && data.channelId && data.messageId) {
          try {
            await this.slackClient.chat.update({
              channel: data.channelId,
              ts: data.messageId,
              text: `❌ **Message update failed**\n\n**Error:** ${error?.data?.error || error.message}\n\nThe response may contain invalid formatting or be too long for Slack.`
            });
            logger.info(`Notified user about validation error in job ${job.id}`);
          } catch (notifyError) {
            logger.error(`Failed to notify user about validation error: ${notifyError}`);
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
  private async updateReaction(channel: string, timestamp: string, oldReaction: string, newReaction: string): Promise<void> {
    console.log(`🔄 REACTION UPDATE: Changing ${oldReaction} → ${newReaction} on message ${timestamp} in channel ${channel}`);
    
    try {
      // Remove old reaction
      console.log(`🗑️  REACTION CHANGE: Removing '${oldReaction}' from message ${timestamp}`);
      await this.slackClient.reactions.remove({
        channel,
        timestamp,
        name: oldReaction
      });
      console.log(`✅ REACTION REMOVED: '${oldReaction}' successfully removed from message ${timestamp}`);
    } catch (error) {
      // Ignore - reaction might not exist
      console.log(`⚠️  REACTION REMOVE: '${oldReaction}' reaction might not exist on message ${timestamp}:`, error);
      logger.debug(`Failed to remove ${oldReaction} reaction (might not exist):`, error);
    }
    
    try {
      // Add new reaction
      console.log(`➕ REACTION CHANGE: Adding '${newReaction}' to message ${timestamp}`);
      await this.slackClient.reactions.add({
        channel,
        timestamp,
        name: newReaction
      });
      console.log(`✅ REACTION ADDED: '${newReaction}' successfully added to message ${timestamp}`);
      logger.info(`Updated reaction: ${oldReaction} → ${newReaction} on message ${timestamp}`);
    } catch (error) {
      // Ignore - reaction might already exist
      logger.debug(`Failed to add ${newReaction} reaction (might already exist):`, error);
    }
  }

  /**
   * Handle message content updates
   */
  private async handleMessageUpdate(data: ThreadResponsePayload, isFirstResponse: boolean, botMessageTs?: string): Promise<string | void> {
    const { content, channelId, threadTs, userId } = data;
    
    if (!content) return;

    try {
      // Process markdown and blockkit content
      const result = processMarkdownAndBlockkit(content);
      
      // Get GitHub action links for this session
      const githubActionLinks = await generateGitHubActionButtons(userId, data.gitBranch, this.userMappings, this.repoManager, this.slackClient);
      
      // Add GitHub action links to the content
      if (githubActionLinks && githubActionLinks.length > 0) {
        const linksText = `\n\n${githubActionLinks.join(' | ')}`;
        result.text = (result.text || content) + linksText;
        
        // Also add to the last section block if it exists
        const lastSectionBlock = result.blocks.slice().reverse().find(block => block.type === "section" && block.text?.type === "mrkdwn");
        if (lastSectionBlock) {
          lastSectionBlock.text.text += linksText;
        }
      }
      
      // Truncate text to Slack's limit (3000 chars for text field)
      const MAX_TEXT_LENGTH = 3000;
      const truncatedText = (result.text || content).length > MAX_TEXT_LENGTH 
        ? (result.text || content).substring(0, MAX_TEXT_LENGTH - 20) + '\n...[truncated]'
        : (result.text || content);
      
      // Add blocks (always have at least one)
      const MAX_BLOCKS = 50;
      const blocks = result.blocks.slice(0, MAX_BLOCKS);
      
      if (isFirstResponse) {
        // Create new message for first response
        logger.info(`Creating new bot message in channel ${channelId}, thread ${threadTs}`);
        const postResult = await this.slackClient.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: truncatedText,
          mrkdwn: true,
          blocks: blocks
        });
        
        logger.info(`Bot message created: ${postResult.ok}, ts: ${postResult.ts}`);
        
        if (!postResult.ok) {
          logger.error(`Failed to create bot message: ${postResult.error}`);
          return;
        }
        
        return postResult.ts as string; // Return the new message timestamp
      } else {
        // Update existing message - use the passed botMessageTs or fallback
        const botTs = botMessageTs || data.botResponseTs || threadTs;
        logger.info(`Updating bot message in channel ${channelId}, ts ${botTs}`);
        
        const updateResult = await this.slackClient.chat.update({
          channel: channelId,
          ts: botTs,
          text: truncatedText,
          blocks: blocks
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
      } else if (error.data?.error === "invalid_blocks" || error.data?.error === "msg_too_long") {
        // These are Slack validation errors - retrying won't help
        logger.error(`Slack validation error: ${JSON.stringify(error)}`);
        
        // Try to send a simple error message with raw content for recovery
        try {
          // Truncate content to fit in code block (leave room for error message + code block formatting)
          const maxContentLength = 2500; // Conservative limit
          const truncatedContent = content.length > maxContentLength 
            ? content.substring(0, maxContentLength) + '\n...[truncated]'
            : content;
          
          const errorMessage = `❌ *Error occurred while updating message*\n\n*Error:* ${error.data?.error||""}${error.message || ""}\n\nThe response may be too long or contain invalid formatting.\n\n*Raw Content:*\n\`\`\`\n${truncatedContent}\n\`\`\``;
          
          await this.slackClient.chat.update({
            channel: channelId,
            ts: threadTs,
            text: errorMessage
          });
          logger.info(`Sent fallback error message with raw content for validation error: ${error.data?.error}`);
        } catch (fallbackError) {
          logger.error("Failed to send fallback error message:", fallbackError);
          // If even the fallback fails, try a minimal message
          try {
            await this.slackClient.chat.update({
              channel: channelId,
              ts: threadTs,
              text: `❌ *Error occurred while updating message*\n\n*Error:* ${error.data?.error || error.message}`
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
  private async handleError(data: ThreadResponsePayload, isFirstResponse: boolean, botMessageTs?: string): Promise<void> {
    const { error, channelId, threadTs, userId } = data;
    
    if (!error) return;

    try {
      logger.info(`Sending error message to channel ${channelId}, thread ${threadTs}`);
      
      const errorContent = `❌ **Error occurred**\n\n**Error:** \`${error}\``;
      
      // Simple error message
      const errorResult = { 
        text: errorContent, 
        blocks: [{
          type: "section",
          text: {
            type: "mrkdwn",
            text: errorContent
          }
        }]
      };
      
      // Get GitHub action links for this session
      const githubActionLinks = await generateGitHubActionButtons(userId, data.gitBranch, this.userMappings, this.repoManager, this.slackClient);
      
      // Add GitHub action links if available
      if (githubActionLinks && githubActionLinks.length > 0) {
        const linksText = `\n\n${githubActionLinks.join(' | ')}`;
        errorResult.text = (errorResult.text || errorContent) + linksText;
        if (errorResult.blocks[0]?.text) {
          errorResult.blocks[0].text.text = errorContent + linksText;
        }
      }
      
      if (isFirstResponse) {
        // Create new error message
        const postResult = await this.slackClient.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: errorResult.text || errorContent,
          mrkdwn: true,
          blocks: errorResult.blocks
        });
        logger.info(`Error message created: ${postResult.ok}`);
      } else {
        // Update existing message with error - use the passed botMessageTs or fallback
        const botTs = botMessageTs || data.botResponseTs || threadTs;
        const updateResult = await this.slackClient.chat.update({
          channel: channelId,
          ts: botTs,
          text: errorResult.text || errorContent,
          blocks: errorResult.blocks
        });
        logger.info(`Error message update result: ${updateResult.ok}`);
      }

    } catch (updateError: any) {
      logger.error(`Failed to send error message to Slack: ${updateError.message}`);
      throw updateError;
    }
  }

  /**
   * Handle environment change by forwarding rebuild request to orchestrator
   */
  private async handleEnvironmentChange(data: ThreadResponsePayload): Promise<void> {
    try {
      // Create rebuild request message for orchestrator
      const rebuildRequest = {
        type: 'rebuild_request',
        threadId: data.threadTs,
        userId: data.userId,
        channelId: data.channelId,
        repositoryUrl: data.repositoryUrl,
        commitId: data.currentCommit,
        modifiedFiles: data.modifiedFiles,
        originalMessageTs: data.originalMessageTs,
        platformMetadata: {
          teamId: '',  // Will be filled in by dispatcher if needed
          repositoryUrl: data.repositoryUrl,
          botResponseTs: data.botResponseTs,
          originalMessageTs: data.originalMessageTs
        },
        timestamp: Date.now()
      };

      // Send rebuild request to orchestrator via messages queue
      const jobId = await this.pgBoss.send('messages', rebuildRequest, {
        retryLimit: 3,
        retryDelay: 5000,
        priority: 5  // High priority for rebuild requests
      });

      if (jobId) {
        logger.info(`Sent rebuild request to orchestrator: job ${jobId} for thread ${data.threadTs}`);
      } else {
        logger.error(`Failed to send rebuild request for thread ${data.threadTs}: pgBoss returned null`);
      }

    } catch (error) {
      logger.error(`Failed to handle environment change for thread ${data.threadTs}:`, error);
      // Don't throw - environment changes are not critical to message processing
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