#!/usr/bin/env bun

import { ClaudeSessionRunner } from "@claude-code-slack/core-runner";
import { WorkspaceManager } from "./workspace-setup";
import { SlackIntegration } from "./slack-integration";
import { SlackTokenManager } from "./slack/token-manager";
import type { WorkerConfig } from "./types";

export class ClaudeWorker {
  private sessionRunner: ClaudeSessionRunner;
  private workspaceManager: WorkspaceManager;
  private slackIntegration: SlackIntegration;
  private config: WorkerConfig;
  private tokenManager?: SlackTokenManager;

  constructor(config: WorkerConfig) {
    this.config = config;

    // Initialize components
    this.sessionRunner = new ClaudeSessionRunner();

    this.workspaceManager = new WorkspaceManager(config.workspace);
    
    // Initialize token manager if refresh token is available
    if (config.slack.refreshToken && config.slack.clientId && config.slack.clientSecret) {
      this.tokenManager = new SlackTokenManager(
        config.slack.clientId,
        config.slack.clientSecret,
        config.slack.refreshToken,
        config.slack.token
      );
      
      // Initialize Slack integration with token manager
      this.slackIntegration = new SlackIntegration({
        ...config.slack,
        tokenManager: this.tokenManager
      });
    } else {
      this.slackIntegration = new SlackIntegration(config.slack);
    }
  }

  /**
   * Execute the worker job
   */
  async execute(): Promise<void> {
    const startTime = Date.now();
    
    try {
      console.log(`🚀 Starting Claude worker for session: ${this.config.sessionKey}`);
      
      // Update initial Slack message with worker details
      await this.slackIntegration.updateProgress(
        `🔧 **Worker starting...**

**Container Details:**
• Session: \`${this.config.sessionKey}\`
• User: \`${this.config.username}\`
• Repository: \`${this.config.repositoryUrl}\`

Setting up workspace...`
      );

      // Setup workspace
      console.log("Setting up workspace...");
      await this.workspaceManager.setupWorkspace(
        this.config.repositoryUrl,
        this.config.username
      );

      // Update progress
      await this.slackIntegration.updateProgress(
        `📁 **Workspace ready**

Repository cloned to \`/workspace/${this.config.username}\`

**GitHub Links:**
• 📝 [Edit on GitHub.dev](https://github.dev/${this.getRepoPath()})
• 🔄 [Compare & PR](${this.config.repositoryUrl}/compare)

Starting Claude session...`
      );

      // Decode user prompt
      const userPrompt = Buffer.from(this.config.userPrompt, "base64").toString("utf-8");
      console.log(`User prompt: ${userPrompt.substring(0, 100)}...`);

      // Parse conversation history if provided
      const conversationHistory = this.config.conversationHistory 
        ? JSON.parse(this.config.conversationHistory)
        : [];
      console.log(`Loaded ${conversationHistory.length} messages from conversation history`);

      // Prepare session context with conversation history
      const sessionContext = {
        platform: "slack" as const,
        channelId: this.config.channelId,
        userId: this.config.userId,
        userDisplayName: this.config.username,
        threadTs: this.config.threadTs,
        messageTs: this.config.slackResponseTs,
        repositoryUrl: this.config.repositoryUrl,
        workingDirectory: `/workspace/${this.config.username}`,
        customInstructions: this.generateCustomInstructions(),
        conversationHistory, // Include the parsed conversation history
      };

      // Execute Claude session with conversation history
      const result = await this.sessionRunner.executeSession({
        sessionKey: this.config.sessionKey,
        userPrompt,
        context: sessionContext,
        options: JSON.parse(this.config.claudeOptions),
        // No recovery options needed - conversation history is already in context
        onProgress: async (update) => {
          // Stream progress to Slack
          if (update.type === "output" && update.data) {
            await this.slackIntegration.streamProgress(update.data);
          }
        },
      });

      // Handle final result
      const duration = Math.round((Date.now() - startTime) / 1000);
      
      if (result.success) {
        await this.slackIntegration.updateProgress(
          `✅ **Session completed successfully!**

**Results:**
• Duration: \`${duration}s\`
• Session persisted successfully
• Changes committed to repository

**GitHub Links:**
• 📝 [View changes on GitHub.dev](https://github.dev/${this.getRepoPath()})
• 🔄 [Create Pull Request](${this.config.repositoryUrl}/compare)
• 📊 [Repository](${this.config.repositoryUrl})

${result.output ? `**Claude's Response:**\n${result.output}` : ""}`
        );
      } else {
        await this.slackIntegration.updateProgress(
          `❌ **Session failed**

**Error Details:**
• Duration: \`${duration}s\`
• Error: \`${result.error || "Unknown error"}\`
• Exit Code: \`${result.exitCode}\`

The session state has been preserved for debugging.`
        );
      }

      console.log(`Worker completed in ${duration}s with ${result.success ? "success" : "failure"}`);

    } catch (error) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.error("Worker execution failed:", error);
      
      // Update Slack with error
      await this.slackIntegration.updateProgress(
        `💥 **Worker crashed**

**Error Details:**
• Duration: \`${duration}s\`  
• Error: \`${error instanceof Error ? error.message : "Unknown error"}\`

The session state has been preserved for debugging.`
      ).catch(slackError => {
        console.error("Failed to update Slack with error:", slackError);
      });

      // Re-throw to ensure container exits with error code
      throw error;
    }
  }

  /**
   * Generate custom instructions for Claude
   */
  private generateCustomInstructions(): string {
    return `You are Claude Code running in a Kubernetes worker container for user ${this.config.username}.

**Environment:**
- Working in: /workspace/${this.config.username}  
- Repository: ${this.config.repositoryUrl}
- Session: ${this.config.sessionKey}
- Thread: ${this.config.threadTs || "New conversation"}

**Your capabilities:**
- Read, write, and execute files in the workspace
- Commit changes to the user's GitHub repository
- Use any available development tools
- Access the internet for research

**Important guidelines:**
- Work efficiently within the 5-minute timeout
- All file changes will be automatically committed
- Progress updates are streamed to Slack in real-time
- Be concise but thorough in your responses
- Focus on solving the user's specific request

**Session context:**
This is ${this.config.threadTs ? "a continued conversation in a thread" : "a new conversation"}.`;
  }

  /**
   * Get repository path for GitHub links
   */
  private getRepoPath(): string {
    const url = new URL(this.config.repositoryUrl);
    return url.pathname.substring(1); // Remove leading slash
  }

  /**
   * Cleanup worker resources
   */
  async cleanup(): Promise<void> {
    try {
      console.log("Cleaning up worker resources...");
      
      // Cleanup session runner
      await this.sessionRunner.cleanupSession(this.config.sessionKey);
      
      // Cleanup workspace
      await this.workspaceManager.cleanup();
      
      console.log("Worker cleanup completed");
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  let worker: ClaudeWorker | null = null;
  
  try {
    console.log("🚀 Starting Claude Code Worker");

    // Load configuration from environment
    const config: WorkerConfig = {
      sessionKey: process.env.SESSION_KEY!,
      userId: process.env.USER_ID!,
      username: process.env.USERNAME!,
      channelId: process.env.CHANNEL_ID!,
      threadTs: process.env.THREAD_TS || undefined,
      repositoryUrl: process.env.REPOSITORY_URL!,
      userPrompt: process.env.USER_PROMPT!, // Base64 encoded
      slackResponseChannel: process.env.SLACK_RESPONSE_CHANNEL!,
      slackResponseTs: process.env.SLACK_RESPONSE_TS!,
      claudeOptions: process.env.CLAUDE_OPTIONS!,
      conversationHistory: process.env.CONVERSATION_HISTORY,
      slack: {
        token: process.env.SLACK_BOT_TOKEN!,
        refreshToken: process.env.SLACK_REFRESH_TOKEN,
        clientId: process.env.SLACK_CLIENT_ID,
        clientSecret: process.env.SLACK_CLIENT_SECRET,
      },
      workspace: {
        baseDirectory: "/workspace",
        githubToken: process.env.GITHUB_TOKEN!,
      },
    };

    // Validate required configuration
    const required = [
      "SESSION_KEY", "USER_ID", "USERNAME", "CHANNEL_ID", 
      "REPOSITORY_URL", "USER_PROMPT", "SLACK_RESPONSE_CHANNEL", 
      "SLACK_RESPONSE_TS", "CLAUDE_OPTIONS", "SLACK_BOT_TOKEN",
      "GITHUB_TOKEN"
    ];

    const missingVars: string[] = [];
    for (const key of required) {
      if (!process.env[key]) {
        missingVars.push(key);
      }
    }

    if (missingVars.length > 0) {
      const errorMessage = `Missing required environment variables: ${missingVars.join(", ")}`;
      console.error(`❌ ${errorMessage}`);
      
      // Try to update Slack if we have enough config
      if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_RESPONSE_CHANNEL && process.env.SLACK_RESPONSE_TS) {
        try {
          const slackIntegration = new SlackIntegration({
            token: process.env.SLACK_BOT_TOKEN,
            refreshToken: process.env.SLACK_REFRESH_TOKEN,
            clientId: process.env.SLACK_CLIENT_ID,
            clientSecret: process.env.SLACK_CLIENT_SECRET,
          });
          
          await slackIntegration.updateProgress(
            `💥 **Worker failed to start**
            
**Kubernetes Configuration Error:**
• ${errorMessage}
• This usually means the Kubernetes secrets are not properly configured

**Troubleshooting:**
1. Check if \`peerbot-secrets\` exists in the namespace
2. Verify all required keys are present in the secret
3. Check RBAC permissions for the service account

Contact your administrator to resolve this issue.`
          );
        } catch (slackError) {
          console.error("Failed to send error to Slack:", slackError);
        }
      }
      
      throw new Error(errorMessage);
    }

    console.log("Configuration loaded:");
    console.log(`- Session: ${config.sessionKey}`);
    console.log(`- User: ${config.username}`);
    console.log(`- Repository: ${config.repositoryUrl}`);

    // Create and execute worker
    worker = new ClaudeWorker(config);
    await worker.execute();

    console.log("✅ Worker execution completed successfully");
    process.exit(0);

  } catch (error) {
    console.error("❌ Worker execution failed:", error);
    
    // Try to report error to Slack if possible
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_RESPONSE_CHANNEL && process.env.SLACK_RESPONSE_TS) {
      try {
        const slackIntegration = new SlackIntegration({
          token: process.env.SLACK_BOT_TOKEN,
          refreshToken: process.env.SLACK_REFRESH_TOKEN,
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
        });
        
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const isKubernetesError = errorMessage.includes("environment variable") || 
                                 errorMessage.includes("secret") ||
                                 errorMessage.includes("permission");
        
        await slackIntegration.updateProgress(
          `💥 **Worker failed**
          
**Error:** ${errorMessage}
${isKubernetesError ? `
**This appears to be a Kubernetes configuration issue:**
• Check if \`peerbot-secrets\` exists and contains all required keys
• Verify RBAC permissions for the service account
• Check pod events: \`kubectl describe pod <pod-name>\`
` : ""}
**Debug Info:**
• Session: \`${process.env.SESSION_KEY || "unknown"}\`
• User: \`${process.env.USERNAME || "unknown"}\`
• Pod: \`${process.env.HOSTNAME || "unknown"}\``
        );
      } catch (slackError) {
        console.error("Failed to send error to Slack:", slackError);
      }
    }
    
    // Cleanup if worker was created
    if (worker) {
      try {
        await worker.cleanup();
      } catch (cleanupError) {
        console.error("Error during cleanup:", cleanupError);
      }
    }
    
    process.exit(1);
  }
}

// Handle process signals
process.on("SIGTERM", async () => {
  console.log("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

// Start the worker
main();

export type { WorkerConfig } from "./types";