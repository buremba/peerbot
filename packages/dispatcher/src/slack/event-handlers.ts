#!/usr/bin/env bun

import type { App } from "@slack/bolt";
import type { KubernetesJobManager } from "../kubernetes/job-manager";
import type { GitHubRepositoryManager } from "../github/repository-manager";
import type { 
  DispatcherConfig, 
  SlackContext, 
  ThreadSession,
  WorkerJobRequest
} from "../types";
import { SessionManager } from "@claude-code-slack/core-runner";

export class SlackEventHandlers {
  private activeSessions = new Map<string, ThreadSession>();
  private userMappings = new Map<string, string>(); // slackUserId -> githubUsername

  constructor(
    private app: App,
    private jobManager: KubernetesJobManager,
    private repoManager: GitHubRepositoryManager,
    private config: DispatcherConfig
  ) {
    this.setupEventHandlers();
  }

  /**
   * Setup Slack event handlers
   */
  private setupEventHandlers(): void {
    // Handle app mentions
    this.app.event("app_mention", async ({ event, client, say }) => {
      try {
        const context = this.extractSlackContext(event);
        
        // Check permissions
        if (!this.isUserAllowed(context.userId)) {
          await say({
            thread_ts: context.threadTs,
            text: "Sorry, you don't have permission to use this bot.",
          });
          return;
        }

        // Extract user request (remove bot mention)
        const userRequest = this.extractUserRequest(context.text);
        
        await this.handleUserRequest(context, userRequest, client);
        
      } catch (error) {
        console.error("Error handling app mention:", error);
        await say({
          thread_ts: event.thread_ts,
          text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
        });
      }
    });

    // Handle direct messages
    this.app.message(async ({ message, client, say }) => {
      // Only handle direct messages, not channel messages
      if (message.channel_type !== "im") return;
      
      try {
        const context = this.extractSlackContext(message);
        
        // Check permissions
        if (!this.isUserAllowed(context.userId)) {
          await say("Sorry, you don't have permission to use this bot.");
          return;
        }

        const userRequest = context.text;
        await this.handleUserRequest(context, userRequest, client);
        
      } catch (error) {
        console.error("Error handling direct message:", error);
        await say(`❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`);
      }
    });
  }

  /**
   * Handle user request by routing to appropriate worker
   */
  private async handleUserRequest(
    context: SlackContext,
    userRequest: string,
    client: any
  ): Promise<void> {
    // Generate session key (thread-based or new)
    const sessionKey = SessionManager.generateSessionKey({
      platform: "slack",
      channelId: context.channelId,
      userId: context.userId,
      userDisplayName: context.userDisplayName,
      teamId: context.teamId,
      threadTs: context.threadTs,
      messageTs: context.messageTs,
    });

    console.log(`Handling request for session: ${sessionKey}`);

    // Check if session is already active
    const existingSession = this.activeSessions.get(sessionKey);
    if (existingSession && existingSession.status === "running") {
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: context.threadTs,
        text: "⏳ I'm already working on this thread. Please wait for the current task to complete.",
      });
      return;
    }

    try {
      // Get or create user's GitHub username mapping
      const username = await this.getOrCreateUserMapping(context.userId, client);
      
      // Ensure user repository exists
      const repository = await this.repoManager.ensureUserRepository(username);
      
      // Post initial response
      const initialResponse = await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: context.threadTs,
        text: this.formatInitialResponse(sessionKey, username, repository.repositoryUrl),
      });

      // Create thread session
      const threadSession: ThreadSession = {
        sessionKey,
        threadTs: context.threadTs,
        channelId: context.channelId,
        userId: context.userId,
        username,
        repositoryUrl: repository.repositoryUrl,
        lastActivity: Date.now(),
        status: "pending",
        createdAt: Date.now(),
      };

      this.activeSessions.set(sessionKey, threadSession);

      // Prepare worker job request
      const jobRequest: WorkerJobRequest = {
        sessionKey,
        userId: context.userId,
        username,
        channelId: context.channelId,
        threadTs: context.threadTs,
        userPrompt: userRequest,
        repositoryUrl: repository.repositoryUrl,
        slackResponseChannel: context.channelId,
        slackResponseTs: initialResponse.ts!,
        claudeOptions: {
          ...this.config.claude,
          timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
        },
        recoveryMode: !!context.threadTs, // Recover if this is a thread
      };

      // Start worker job
      const jobName = await this.jobManager.createWorkerJob(jobRequest);
      
      // Update session with job info
      threadSession.jobName = jobName;
      threadSession.status = "starting";
      
      console.log(`Created worker job ${jobName} for session ${sessionKey}`);

    } catch (error) {
      console.error(`Failed to handle request for session ${sessionKey}:`, error);
      
      // Post error message
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: context.threadTs,
        text: `❌ **Error:** ${error instanceof Error ? error.message : "Unknown error occurred"}`,
      });
      
      // Clean up session
      this.activeSessions.delete(sessionKey);
    }
  }

  /**
   * Extract Slack context from event
   */
  private extractSlackContext(event: any): SlackContext {
    return {
      channelId: event.channel,
      userId: event.user,
      teamId: event.team || "",
      threadTs: event.thread_ts,
      messageTs: event.ts,
      text: event.text || "",
    };
  }

  /**
   * Extract user request from mention text
   */
  private extractUserRequest(text: string): string {
    // Remove bot mention and clean up text
    const triggerPhrase = this.config.slack.triggerPhrase || "@peerbotai";
    
    // Remove the trigger phrase and clean up
    let cleaned = text.replace(new RegExp(`<@[^>]+>|${triggerPhrase}`, "gi"), "").trim();
    
    if (!cleaned) {
      return "Hello! How can I help you today?";
    }
    
    return cleaned;
  }

  /**
   * Check if user is allowed to use the bot
   */
  private isUserAllowed(userId: string): boolean {
    const { allowedUsers, blockedUsers } = this.config.slack;
    
    // Check blocked users first
    if (blockedUsers?.includes(userId)) {
      return false;
    }
    
    // If allowedUsers is specified, user must be in the list
    if (allowedUsers && allowedUsers.length > 0) {
      return allowedUsers.includes(userId);
    }
    
    // Default to allow if no restrictions specified
    return true;
  }

  /**
   * Get or create GitHub username mapping for Slack user
   */
  private async getOrCreateUserMapping(slackUserId: string, client: any): Promise<string> {
    // Check if mapping already exists
    const existingMapping = this.userMappings.get(slackUserId);
    if (existingMapping) {
      return existingMapping;
    }

    // Get user info from Slack
    try {
      const userInfo = await client.users.info({ user: slackUserId });
      const user = userInfo.user;
      
      // Try to use Slack display name or real name as GitHub username
      let username = user.profile?.display_name || user.profile?.real_name || user.name;
      
      // Clean up username for GitHub (remove spaces, special chars, etc.)
      username = username.toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      
      // Ensure username is valid and unique
      username = `user-${username}`;
      
      // Store mapping
      this.userMappings.set(slackUserId, username);
      
      console.log(`Created user mapping: ${slackUserId} -> ${username}`);
      return username;
      
    } catch (error) {
      console.error(`Failed to get user info for ${slackUserId}:`, error);
      
      // Fallback to generic username
      const fallbackUsername = `user-${slackUserId.substring(0, 8)}`;
      this.userMappings.set(slackUserId, fallbackUsername);
      return fallbackUsername;
    }
  }

  /**
   * Format initial response message
   */
  private formatInitialResponse(sessionKey: string, username: string, repositoryUrl: string): string {
    const workerId = `claude-worker-${sessionKey.substring(0, 8)}`;
    
    return `🤖 **Claude is working on your request...**

**Worker Environment:**
• Pod: \`${workerId}\`
• Namespace: \`${this.config.kubernetes.namespace}\`
• CPU: \`${this.config.kubernetes.cpu}\` Memory: \`${this.config.kubernetes.memory}\`
• Timeout: \`${this.config.sessionTimeoutMinutes} minutes\`
• Repository: \`${username}\`

**GitHub Workspace:**
• Repository: [${username}](${repositoryUrl})
• 📝 [Edit on GitHub.dev](https://github.dev/${this.config.github.organization}/${username})
• 🔄 [Compare & PR](${repositoryUrl}/compare)

*Progress updates will appear below...*`;
  }

  /**
   * Handle job completion notification
   */
  async handleJobCompletion(sessionKey: string, success: boolean, message?: string): Promise<void> {
    const session = this.activeSessions.get(sessionKey);
    if (!session) return;

    session.status = success ? "completed" : "error";
    session.lastActivity = Date.now();

    // Log completion
    console.log(`Job completed for session ${sessionKey}: ${success ? "success" : "failure"}`);
    
    // Clean up session after some time
    setTimeout(() => {
      this.activeSessions.delete(sessionKey);
    }, 60000); // Clean up after 1 minute
  }

  /**
   * Handle job timeout
   */
  async handleJobTimeout(sessionKey: string): Promise<void> {
    const session = this.activeSessions.get(sessionKey);
    if (!session) return;

    session.status = "timeout";
    session.lastActivity = Date.now();

    console.log(`Job timed out for session ${sessionKey}`);
    
    // Clean up immediately
    this.activeSessions.delete(sessionKey);
  }

  /**
   * Get active sessions for monitoring
   */
  getActiveSessions(): ThreadSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get session count
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Cleanup all sessions
   */
  cleanup(): void {
    this.activeSessions.clear();
    this.userMappings.clear();
  }
}