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
  private recentEvents = new Map<string, number>(); // eventKey -> timestamp

  constructor(
    private app: App,
    private jobManager: KubernetesJobManager,
    private repoManager: GitHubRepositoryManager,
    private config: DispatcherConfig
  ) {
    this.setupEventHandlers();
  }

  /**
   * Check if this is a duplicate event
   */
  private isDuplicateEvent(userId: string, messageTs: string, text: string): boolean {
    const eventKey = `${userId}-${messageTs}-${text.substring(0, 50)}`;
    const now = Date.now();
    const lastSeen = this.recentEvents.get(eventKey);
    
    // If we've seen this event in the last 5 seconds, it's a duplicate
    if (lastSeen && now - lastSeen < 5000) {
      console.log(`Duplicate event detected: ${eventKey}`);
      return true;
    }
    
    // Store this event
    this.recentEvents.set(eventKey, now);
    
    // Clean up old events (older than 10 seconds)
    for (const [key, timestamp] of this.recentEvents.entries()) {
      if (now - timestamp > 10000) {
        this.recentEvents.delete(key);
      }
    }
    
    return false;
  }

  /**
   * Setup Slack event handlers
   */
  private setupEventHandlers(): void {
    console.log("Setting up Slack event handlers...");
    
    // Handle app mentions
    this.app.event("app_mention", async ({ event, client, say }) => {
      console.log("=== APP_MENTION HANDLER TRIGGERED ===");
      console.log("Raw event object keys:", Object.keys(event));
      console.log("Event user field:", event.user);
      
      try {
        const context = this.extractSlackContext(event);
        console.log("Extracted context:", context);
        
        // Check if we have a valid user ID
        if (!context.userId) {
          console.error("No user ID found in app_mention event. Context:", context);
          console.error("Full event object:", JSON.stringify(event, null, 2));
          await say({
            thread_ts: context.threadTs,
            text: "❌ Error: Unable to identify user. Please try again.",
          });
          return;
        }
        
        // Check for duplicate events
        if (this.isDuplicateEvent(context.userId, context.messageTs, context.text)) {
          console.log("Skipping duplicate app_mention event");
          return;
        }
        
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
      console.log("=== MESSAGE HANDLER TRIGGERED ===");
      console.log("Message channel_type:", message.channel_type);
      console.log("Message subtype:", message.subtype);
      console.log("Message object keys:", Object.keys(message));
      console.log("Message user field:", (message as any).user);
      
      // Handle both DMs and channel messages where the bot is mentioned
      // For channel messages, we rely on the app_mention handler above
      // This handler will process DMs and bot_message subtypes (for bot-to-bot communication)
      
      // Ignore message subtypes that are not actual user messages
      const ignoredSubtypes = [
        'message_changed',
        'message_deleted',
        'thread_broadcast',
        'channel_join',
        'channel_leave',
        'assistant_app_thread'
      ];
      
      if (message.subtype && ignoredSubtypes.includes(message.subtype)) {
        console.log(`Ignoring message with subtype: ${message.subtype}`);
        return;
      }
      
      // Allow bot messages - removed bot filtering to enable bot-to-bot communication
      
      try {
        const context = this.extractSlackContext(message);
        console.log("Extracted context from message:", context);
        
        // Check if we have a valid user ID
        if (!context.userId) {
          console.error("No user ID found in message event. Context:", context);
          console.error("Full message object:", JSON.stringify(message, null, 2));
          await say("❌ Error: Unable to identify user. Please try again.");
          return;
        }
        
        // Check for duplicate events
        if (this.isDuplicateEvent(context.userId, context.messageTs, context.text)) {
          console.log("Skipping duplicate message event");
          return;
        }
        
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
      
      // Fetch conversation history from Slack if this is a thread
      const conversationHistory = await this.fetchConversationHistory(
        context.channelId,
        context.threadTs,
        client
      );
      
      console.log(`Session ${sessionKey} - fetched ${conversationHistory.length} messages from thread`);
      
      // Ensure user repository exists
      const repository = await this.repoManager.ensureUserRepository(username);
      
      // If this is not already a thread, use the current message timestamp as thread_ts
      const threadTs = context.threadTs || context.messageTs;
      
      // Post initial response - ALWAYS in thread
      const initialResponse = await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: threadTs,
        text: this.formatInitialResponse(sessionKey, username, repository.repositoryUrl),
      });

      // Create thread session - ensure we always have a threadTs
      const threadSession: ThreadSession = {
        sessionKey,
        threadTs: threadTs,
        channelId: context.channelId,
        userId: context.userId,
        username,
        repositoryUrl: repository.repositoryUrl,
        lastActivity: Date.now(),
        status: "pending",
        createdAt: Date.now(),
      };

      this.activeSessions.set(sessionKey, threadSession);

      // Prepare worker job request with conversation history
      const jobRequest: WorkerJobRequest = {
        sessionKey,
        userId: context.userId,
        username,
        channelId: context.channelId,
        threadTs: threadTs, // Always pass the thread timestamp
        userPrompt: userRequest,
        repositoryUrl: repository.repositoryUrl,
        slackResponseChannel: context.channelId,
        slackResponseTs: initialResponse.ts!,
        claudeOptions: {
          ...this.config.claude,
          timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
        },
        conversationHistory, // Pass the fetched conversation history
      };

      // Start worker job
      const jobName = await this.jobManager.createWorkerJob(jobRequest);
      
      // Update session with job info
      threadSession.jobName = jobName;
      threadSession.status = "starting";
      
      console.log(`Created worker job ${jobName} for session ${sessionKey}`);
      
      // Update the initial message with job details
      const updatedMessage = this.formatInitialResponse(sessionKey, username, repository.repositoryUrl, jobName);
      await client.chat.update({
        channel: context.channelId,
        ts: initialResponse.ts!,
        text: updatedMessage,
      });

    } catch (error) {
      console.error(`Failed to handle request for session ${sessionKey}:`, error);
      
      // Format error message with debugging info
      let errorMessage = `❌ **Error:** ${error instanceof Error ? error.message : "Unknown error occurred"}`;
      
      // If we have a job name, add debugging commands
      const session = this.activeSessions.get(sessionKey);
      if (session?.jobName) {
        errorMessage += `\n\n${this.formatKubectlCommands(session.jobName, this.config.kubernetes.namespace)}`;
      }
      
      // Add generic debugging tips
      errorMessage += `\n\n**💡 Troubleshooting Tips:**
• Check dispatcher logs: \`kubectl logs -n ${this.config.kubernetes.namespace} -l app.kubernetes.io/component=dispatcher --tail=100\`
• Check events: \`kubectl get events -n ${this.config.kubernetes.namespace} --sort-by='.lastTimestamp'\`
• Check job quota: \`kubectl describe resourcequota -n ${this.config.kubernetes.namespace}\``;
      
      // Post error message - ALWAYS in thread
      const threadTs = context.threadTs || context.messageTs;
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: threadTs,
        text: errorMessage,
      });
      
      // Clean up session
      this.activeSessions.delete(sessionKey);
    }
  }

  /**
   * Extract Slack context from event
   */
  private extractSlackContext(event: any): SlackContext {
    // Comprehensive debug logging
    console.log("=== FULL SLACK EVENT DEBUG ===");
    console.log("Event type:", event.type);
    console.log("Event subtype:", event.subtype);
    console.log("Event user:", event.user);
    console.log("Event bot_id:", (event as any).bot_id);
    console.log("Event channel:", event.channel);
    console.log("Event channel_type:", event.channel_type);
    console.log("Event team:", event.team);
    console.log("Event ts:", event.ts);
    console.log("Event thread_ts:", event.thread_ts);
    console.log("Full event JSON:", JSON.stringify(event, null, 2));
    console.log("=== END EVENT DEBUG ===");
    
    // Log if this is a bot message (but don't ignore it)
    if ((event as any).bot_id || event.subtype === 'bot_message') {
      console.log("Processing bot message from bot_id:", (event as any).bot_id);
    }
    
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
    // Only remove Slack's formatted mentions like <@U123456>
    let cleaned = text.replace(/<@[^>]+>/g, "").trim();
    
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
   * Fetch conversation history from Slack thread
   */
  private async fetchConversationHistory(
    channelId: string, 
    threadTs: string | undefined,
    client: any
  ): Promise<Array<{ role: string; content: string; timestamp: number }>> {
    if (!threadTs) {
      return [];
    }

    try {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 100, // Get up to 100 messages in the thread
      });

      if (!result.messages || result.messages.length === 0) {
        return [];
      }

      // Convert Slack messages to conversation format
      const conversation = result.messages
        .filter((msg: any) => msg.text && msg.user) // Filter out system messages
        .map((msg: any) => ({
          role: msg.user === this.config.slack.botUserId ? 'assistant' : 'user',
          content: msg.text,
          timestamp: parseFloat(msg.ts) * 1000, // Convert Slack timestamp to milliseconds
        }));

      console.log(`Fetched ${conversation.length} messages from thread ${threadTs}`);
      return conversation;
    } catch (error) {
      console.error(`Failed to fetch conversation history: ${error}`);
      return [];
    }
  }

  /**
   * Get or create GitHub username mapping for Slack user
   */
  private async getOrCreateUserMapping(slackUserId: string | undefined, client: any): Promise<string> {
    // Handle undefined user ID
    if (!slackUserId) {
      console.error("Slack user ID is undefined");
      return "user-unknown";
    }
    
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
      const fallbackUsername = slackUserId ? `user-${slackUserId.substring(0, 8)}` : "user-unknown";
      if (slackUserId) {
        this.userMappings.set(slackUserId, fallbackUsername);
      }
      return fallbackUsername;
    }
  }

  /**
   * Format initial response message
   */
  private formatInitialResponse(sessionKey: string, username: string, repositoryUrl: string, jobName?: string): string {
    const workerId = jobName || `claude-worker-${sessionKey.substring(0, 8)}`;
    const namespace = this.config.kubernetes.namespace;
    
    // Get commit ID from environment or use a default
    const commitId = process.env.GITHUB_SHA?.substring(0, 7) || process.env.GIT_COMMIT?.substring(0, 7) || 'unknown';
    
    let message = `🤖 **Claude is working on your request...**

**Worker Environment:**
• Pod: \`${workerId}\`
• Namespace: \`${namespace}\`
• CPU: \`${this.config.kubernetes.cpu}\` Memory: \`${this.config.kubernetes.memory}\`
• Timeout: \`${this.config.sessionTimeoutMinutes} minutes\`
• Repository: \`${username}\`
• Commit: \`${commitId}\`

**GitHub Workspace:**
• Repository: [${username}](${repositoryUrl})
• 📝 [Edit on GitHub.dev](${repositoryUrl.replace('github.com', 'github.dev')})
• 🔄 [Compare & PR](${repositoryUrl}/compare)`;

    if (jobName) {
      message += `

**📊 Monitor Progress:**
• \`kubectl logs -n ${namespace} job/${jobName} -f\`
• \`kubectl describe job/${jobName} -n ${namespace}\`
• \`kubectl get pods -n ${namespace} -l job-name=${jobName}\``;
      
      // Add Google Cloud Console link if on GKE
      const projectId = process.env.GOOGLE_CLOUD_PROJECT;
      if (projectId) {
      message += `

**🔗 Quick Links:**
• [GKE Workloads](https://console.cloud.google.com/kubernetes/workload/overview?project=${projectId}&pageState=(%22savedViews%22:(%22i%22:%225d96be3b8e484ad689354ab3fe0f7b4f%22,%22c%22:%5B%5D,%22n%22:%5B%22${namespace}%22%5D)))
• [Cloud Logging](https://console.cloud.google.com/logs/query;query=resource.type%3D%22k8s_pod%22%0Aresource.labels.namespace_name%3D%22${namespace}%22%0Aresource.labels.pod_name%3D~%22${jobName}.*%22?project=${projectId})`;
      }
    }

    message += `

*Progress updates will appear below...*`;
    
    return message;
  }

  /**
   * Format kubectl commands for debugging
   */
  private formatKubectlCommands(jobName: string, namespace: string): string {
    return `
**🛠️ Debugging Commands:**
\`\`\`bash
# Watch job logs in real-time
kubectl logs -n ${namespace} job/${jobName} -f

# Get job status
kubectl get job/${jobName} -n ${namespace} -o wide

# Get pod details
kubectl get pods -n ${namespace} -l job-name=${jobName} -o wide

# Describe job for events
kubectl describe job/${jobName} -n ${namespace}

# Get pod logs if job failed
kubectl logs -n ${namespace} -l job-name=${jobName} --tail=100
\`\`\``;
  }

  /**
   * Handle job completion notification
   */
  async handleJobCompletion(sessionKey: string, success: boolean): Promise<void> {
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
  async cleanup(): Promise<void> {
    // Clear local maps
    this.activeSessions.clear();
    this.userMappings.clear();
  }
}