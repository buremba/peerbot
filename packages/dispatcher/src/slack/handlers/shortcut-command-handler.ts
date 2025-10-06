import type { App } from "@slack/bolt";
import { createLogger, type DatabaseAdapter } from "@peerbot/shared";

const logger = createLogger("dispatcher");
import type { DispatcherConfig } from "../../types";
import type { MessageHandler } from "./message-handler";
import type { ActionHandler } from "./action-handler";
import { openRepositoryModal } from "./repository-modal-utils";
// GitHub imports are loaded dynamically when needed

export class ShortcutCommandHandler {
  constructor(
    private app: App,
    private config: DispatcherConfig,
    private messageHandler: MessageHandler,
    private actionHandler: ActionHandler,
    private database: DatabaseAdapter
  ) {}

  /**
   * Setup all shortcut and slash command handlers
   */
  setupHandlers(): void {
    this.setupShortcuts();
    this.setupSlashCommands();
    this.setupViewSubmissions();
  }

  /**
   * Handle text commands that mimic slash commands (for DMs)
   */
  async handleTextCommand(
    command: string,
    userId: string,
    channelId: string,
    client: any,
    threadTs?: string
  ): Promise<void> {
    logger.info(`Handling text command '${command}' from user ${userId}`);

    // All text commands now use the unified context-aware welcome
    if (command === "welcome" || command === "login") {
      await this.sendContextAwareWelcome(userId, channelId, client, threadTs);
    } else {
      logger.warn(`Unknown text command: ${command}`);
    }
  }

  /**
   * Setup shortcut handlers for global shortcuts
   */
  private setupShortcuts(): void {
    logger.info("Setting up shortcut handlers...");

    // Handle "Create a project" shortcut
    this.app.shortcut("create_project", async ({ ack, body, client }) => {
      await ack();
      const userId = body.user.id;
      logger.info(`Create project shortcut triggered by ${userId}`);

      const { getUserGitHubInfo } = await import(
        "../../../../../modules/github/handlers"
      );
      await openRepositoryModal({
        userId,
        body,
        client,
        checkAdminStatus: true,
        getGitHubUserInfo: getUserGitHubInfo,
      });
    });

    // Handle "Experiment feature" shortcut
    this.app.shortcut("develop_feature", async ({ ack, body, client }) => {
      await ack();
      const userId = body.user.id;
      logger.info(`Develop feature shortcut triggered by ${userId}`);

      const im = await client.conversations.open({ users: userId });
      if (im.channel?.id) {
        await client.chat.postMessage({
          channel: im.channel.id,
          text: "🚀 Ready to experiment with a new feature! Start by describing what you want to build.",
        });
      }
    });

    // Handle "Fix bug" shortcut
    this.app.shortcut("fix_bug", async ({ ack, body, client }) => {
      await ack();
      const userId = body.user.id;
      logger.info(`Fix bug shortcut triggered by ${userId}`);

      const im = await client.conversations.open({ users: userId });
      if (im.channel?.id) {
        await client.chat.postMessage({
          channel: im.channel.id,
          text: "🐛 Let's fix that bug! Describe the issue you're experiencing.",
        });
      }
    });

    // Handle "Ask question" shortcut
    this.app.shortcut("ask_question", async ({ ack, body, client }) => {
      await ack();
      const userId = body.user.id;
      logger.info(`Ask question shortcut triggered by ${userId}`);

      const im = await client.conversations.open({ users: userId });
      if (im.channel?.id) {
        await client.chat.postMessage({
          channel: im.channel.id,
          text: "❓ What would you like to know about your codebase?",
        });
      }
    });
  }

  /**
   * Setup slash command handlers
   */
  private setupSlashCommands(): void {
    logger.info("Setting up slash command handlers...");

    // Handle /peerbot command - always show context-aware welcome
    this.app.command("/peerbot", async ({ ack, body, client }) => {
      await ack();

      const { user_id, channel_id } = body;
      logger.info(
        `/peerbot command received from user=${user_id}, channel=${channel_id}`
      );

      // Send context-aware welcome message (no thread for slash commands)
      await this.sendContextAwareWelcome(user_id, channel_id, client);
    });
  }

  /**
   * Send a context-aware welcome message based on user's login state
   */
  public async sendContextAwareWelcome(
    userId: string,
    channelId: string,
    client: any,
    threadTs?: string
  ): Promise<void> {
    // Check if user has GitHub connected
    const { getUserGitHubInfo } = await import(
      "../../../../../modules/github/handlers"
    );
    const githubUser = await getUserGitHubInfo(userId);
    const isGitHubConnected = !!githubUser.token;

    // Check if user has a repository selected
    const userEnv = await this.messageHandler.getUserEnvironment(
      userId,
      channelId
    );
    const hasRepository = !!userEnv.GITHUB_REPOSITORY;

    // Build blocks based on user state
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Welcome to Peerbot! 👋",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "I'm your AI coding assistant powered by Claude. I can help you with:\n\n" +
            "• 💻 Writing and reviewing code\n" +
            "• 🔧 Building features and fixing bugs\n" +
            "• 📚 Understanding codebases\n" +
            "• 🚀 Creating new projects",
        },
      },
      {
        type: "divider",
      },
    ];

    if (!isGitHubConnected) {
      // Not logged in - show login and demo options
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Get Started:*\nConnect your GitHub account or try a demo to explore my capabilities.",
          },
        },
        {
          type: "actions",
          elements: (() => {
            const elements = [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "🔗 Login with GitHub",
                  emoji: true,
                },
                style: "primary",
                action_id: "open_github_login_modal",
              } as any,
            ];

            // Only show Try Demo button if DEMO_REPOSITORY is configured
            if (process.env.DEMO_REPOSITORY) {
              elements.push({
                type: "button",
                text: {
                  type: "plain_text",
                  text: "🎮 Try Demo",
                  emoji: true,
                },
                action_id: "try_demo",
                value: "slash_command_demo",
              } as any);
            }

            return elements;
          })(),
        }
      );
    } else if (!hasRepository) {
      // Logged in but no repository selected
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*GitHub Connected:* ${githubUser.username || "✓"}\n\nSelect a repository to start working:`,
          },
        },
        {
          type: "actions",
          elements: (() => {
            const elements = [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "📂 Select Repository",
                  emoji: true,
                },
                style: "primary",
                action_id: "open_repository_modal",
              },
            ];

            // Only show Try Demo button if DEMO_REPOSITORY is configured
            if (process.env.DEMO_REPOSITORY) {
              elements.push({
                type: "button",
                text: {
                  type: "plain_text",
                  text: "🎮 Try Demo",
                  emoji: true,
                },
                action_id: "try_demo",
                value: "slash_command_demo",
              } as any);
            }

            return elements;
          })(),
        }
      );
    } else {
      // Logged in with repository selected - show current setup
      const repoUrl = userEnv.GITHUB_REPOSITORY as string;
      const repoName = repoUrl.split("/").pop()?.replace(".git", "");

      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Ready to code!*\n\nActive Repository: *${repoName}*\n${repoUrl}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🔄 Change Repository",
                emoji: true,
              },
              action_id: "open_repository_modal",
            },
          ],
        }
      );
    }

    blocks.push(
      {
        type: "divider",
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 *Quick Start:* Just @mention me or send me a direct message to start coding!",
          },
        ],
      }
    );

    // Send as ephemeral message if in channel, regular if in DM
    const isDM = channelId.startsWith("D");

    if (isDM) {
      const messagePayload: any = {
        channel: channelId,
        text: "Welcome to Peerbot! 👋",
        blocks,
      };

      // Add thread_ts if provided to respond in the same thread
      if (threadTs) {
        messagePayload.thread_ts = threadTs;
      }

      await client.chat.postMessage(messagePayload);
    } else {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "Welcome to Peerbot! 👋",
        blocks,
      });
    }
  }

  /**
   * Setup view submission handlers for modals
   */
  private setupViewSubmissions(): void {
    logger.info("Setting up view submission handlers...");

    // Handle repository selection modal submission
    this.app.view(
      "repository_selection",
      async ({ ack, body, view, client }) => {
        const userId = body.user.id;
        logger.info(`Repository selection submitted by user ${userId}`);

        try {
          await this.handleRepositoryModalSubmission(userId, view, client);
          await ack();
        } catch (error) {
          logger.error("Error in repository selection:", error);
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to process repository selection";
          const errors: Record<string, string> = {};
          if (errorMessage.includes("choose only one")) {
            errors.existing_repo_input = errorMessage;
            errors.new_repo_input = errorMessage;
          } else if (errorMessage.includes("existing repository")) {
            errors.existing_repo_input = errorMessage;
          } else if (errorMessage.includes("new repository")) {
            errors.new_repo_input = errorMessage;
          } else {
            errors.existing_repo_input = errorMessage;
          }

          await ack({
            response_action: "errors",
            errors,
          });
        }
      }
    );

    // Handle environment variable modal submission
    this.app.view("set_environment", async ({ ack, body, view, client }) => {
      const userId = body.user.id;

      try {
        await this.handleSetEnvironment(userId, view, client);
        await ack();
      } catch (error) {
        logger.error("Error setting environment:", error);
        await ack({
          response_action: "errors",
          errors: { env_input: "Failed to save environment variables" },
        });
      }
    });
  }

  /**
   * Handle repository modal submission
   */
  private async handleRepositoryModalSubmission(
    userId: string,
    view: any,
    client: any
  ): Promise<void> {
    logger.info(`Processing repository selection for user ${userId}`);

    try {
      // Check which option was filled
      const existingRepoUrl =
        view.state.values.existing_repo_input?.existing_repo_select
          ?.selected_option?.value;
      const newRepoName =
        view.state.values.new_repo_input?.new_repo_name?.value;

      if (!existingRepoUrl && !newRepoName) {
        throw new Error(
          "Please either enter an existing repository URL or a name for a new repository"
        );
      }

      if (existingRepoUrl && newRepoName) {
        throw new Error(
          "Please choose only one option: either an existing repository or create a new one"
        );
      }

      let repositoryUrl: string;

      if (newRepoName) {
        // Create new repository
        // Get GitHub user info
        // const username = await this.messageHandler.getOrCreateUserMapping(userId, client); // Currently unused
        const { getUserGitHubInfo } = await import(
          "../../../../../modules/github/handlers"
        );
        const githubUser = await getUserGitHubInfo(userId);

        if (!githubUser.token) {
          throw new Error(
            "GitHub authentication required to create repositories"
          );
        }

        // Create repository in user's space
        const newRepo = await this.createGitHubRepository(
          newRepoName,
          githubUser.token
        );
        repositoryUrl = newRepo.html_url;

        logger.info(`Created new repository: ${repositoryUrl}`);
      } else {
        repositoryUrl = existingRepoUrl!;
      }

      // Parse metadata to get channel context
      let metadata: any = {};
      try {
        metadata = JSON.parse(view.private_metadata || "{}");
      } catch (error) {
        logger.warn("Failed to parse modal metadata");
      }

      const channelId = metadata.channel_id;

      // Save the selected repository
      await this.saveSelectedRepository(userId, repositoryUrl, channelId);

      // Send confirmation
      const repoName =
        repositoryUrl.split("/").pop()?.replace(".git", "") || "repository";

      // Send confirmation message
      if (channelId) {
        await client.chat.postMessage({
          channel: channelId,
          text: `✅ Repository selected: *${repoName}*\n${repositoryUrl}`,
        });
      } else {
        // Send to DM
        const im = await client.conversations.open({ users: userId });
        if (im.channel?.id) {
          await client.chat.postMessage({
            channel: im.channel.id,
            text: `✅ Repository selected: *${repoName}*\n${repositoryUrl}`,
          });
        }
      }

      // Update app home
      await this.actionHandler.updateAppHome(userId, client);
    } catch (error) {
      logger.error(`Failed to save repository selection:`, error);
      throw error;
    }
  }

  /**
   * Save selected repository to database
   */
  private async saveSelectedRepository(
    userId: string,
    repositoryUrl: string,
    channelId?: string
  ): Promise<void> {
    try {
      const isChannel = channelId && !channelId.startsWith("D");

      // Check if user is admin for channel-level save
      let saveToChannel = false;
      if (isChannel) {
        saveToChannel = await this.isUserChannelAdmin(userId, channelId);
      }

      const result = await this.database.saveEnvironmentVariables({
        platformUserId: userId,
        variables: [
          {
            name: "GITHUB_REPOSITORY",
            value: repositoryUrl,
            repository: repositoryUrl,
            channelId: saveToChannel ? channelId : null,
            type: saveToChannel ? "channel" : "user",
          },
        ],
      });

      if (result.failed.length > 0) {
        throw new Error(
          `Failed to store repository selection: ${result.failed.join(", ")}`
        );
      }

      const context = saveToChannel ? `channel ${channelId}` : `user ${userId}`;
      logger.info(`Saved repository for ${context}: ${repositoryUrl}`);
    } catch (error) {
      logger.error(`Failed to save repository selection:`, error);
      throw error;
    }
  }

  /**
   * Handle environment variable setting
   */
  private async handleSetEnvironment(
    userId: string,
    view: any,
    client: any
  ): Promise<void> {
    try {
      // Extract input values
      const inputs = this.extractViewInputs(view.state.values);
      const envVars = this.parseEnvironmentVariables(inputs);

      const result = await this.database.saveEnvironmentVariables({
        platformUserId: userId,
        defaultType: "user",
        variables: Object.entries(envVars).map(([key, value]) => ({
          name: key,
          value,
          type: "user",
        })),
      });

      if (result.failed.length > 0) {
        throw new Error(
          `Failed to store environment variables: ${result.failed.join(", ")}`
        );
      }

      logger.info(
        `Saved ${Object.keys(envVars).length} environment variables for user ${userId}`
      );

      // Send confirmation
      const im = await client.conversations.open({ users: userId });
      if (im.channel?.id) {
        await client.chat.postMessage({
          channel: im.channel.id,
          text: `✅ Environment variables saved successfully:\n${Object.keys(envVars).join(", ")}`,
        });
      }
    } catch (error) {
      logger.error(`Failed to save environment variables:`, error);
      throw error;
    }
  }

  /**
   * Check if user is channel admin
   */
  private async isUserChannelAdmin(
    _userId: string,
    _channelId: string
  ): Promise<boolean> {
    // This would need to be implemented based on your Slack workspace setup
    // For now, return false as a safe default
    return false;
  }

  /**
   * Create a new GitHub repository
   */
  private async createGitHubRepository(
    repoName: string,
    token: string
  ): Promise<any> {
    // Create repository in user's space instead of organization
    const response = await fetch(`https://api.github.com/user/repos`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: repoName,
        private: false,
        auto_init: true,
        description: `Created via Peerbot`,
      }),
    });

    if (!response.ok) {
      const errorData: any = await response
        .json()
        .catch(() => ({ message: "Unknown error" }));
      const errorMsg =
        errorData.message || errorData.errors?.[0]?.message || "Unknown error";
      throw new Error(`Failed to create repository: ${errorMsg}`);
    }

    return response.json();
  }

  /**
   * Extract view inputs from Slack modal state
   */
  private extractViewInputs(stateValues: any): string {
    const inputs: string[] = [];

    for (const blockId of Object.keys(stateValues)) {
      const block = stateValues[blockId];
      for (const actionId of Object.keys(block)) {
        const action = block[actionId];
        if (action.value) {
          inputs.push(action.value);
        }
      }
    }

    return inputs.join("\n");
  }

  /**
   * Parse environment variables from input text
   */
  private parseEnvironmentVariables(input: string): Record<string, string> {
    const envVars: Record<string, string> = {};
    const lines = input.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed?.includes("=")) {
        const [key, ...valueParts] = trimmed.split("=");
        const value = valueParts.join("=");
        if (key && value) {
          envVars[key.trim()] = value.trim();
        }
      }
    }

    return envVars;
  }
}
