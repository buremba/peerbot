import { createLogger, type DatabaseAdapter } from "@peerbot/shared";

const logger = createLogger("dispatcher");
import type { SlackContext } from "../../types";
import type { MessageHandler } from "./message-handler";
// Dynamic module imports to avoid hardcoded dependencies
import { handleTryDemo } from "./demo-handler";
import { openRepositoryModal } from "./repository-modal-utils";
import {
  handleBlockkitForm,
  handleExecutableCodeBlock,
  handleStopWorker,
} from "../event-handlers/block-actions";

export class ActionHandler {
  constructor(
    private messageHandler: MessageHandler,
    private database: DatabaseAdapter
  ) {}

  /**
   * Handle block action events
   */
  async handleBlockAction(
    actionId: string,
    userId: string,
    channelId: string,
    messageTs: string,
    body: any,
    client: any
  ): Promise<void> {
    logger.info(`Handling block action: ${actionId}`);

    // Try to handle action through modules first
    let handled = false;
    let dispatcherModules: any[] = [];
    try {
      const { moduleRegistry } = await import("../../../../../modules");
      dispatcherModules = moduleRegistry.getDispatcherModules();
    } catch (error) {
      logger.warn("Module registry not available, skipping module actions");
    }
    for (const module of dispatcherModules) {
      if (module.handleAction) {
        const moduleHandled = await module.handleAction(actionId, userId, {
          channelId,
          client,
          body,
          updateAppHome: this.updateAppHome.bind(this),
        });
        if (moduleHandled) {
          handled = true;
          break;
        }
      }
    }

    if (!handled) {
      switch (actionId) {
        case "open_repository_modal": {
          // Get GitHub functions from module
          try {
            const { moduleRegistry } = await import("../../../../../modules");
            const gitHubModule = moduleRegistry.getModule("github");
            if (gitHubModule) {
              const { getUserGitHubInfo } = await import(
                "../../../../../modules/github/handlers"
              );
              await openRepositoryModal({
                userId,
                body,
                client,
                checkAdminStatus: false,
                getGitHubUserInfo: getUserGitHubInfo,
              });
            }
          } catch (error) {
            logger.warn("GitHub module not available for repository modal");
          }
          break;
        }

        case "try_demo": {
          // Check if this is from the home tab (view type will be 'home')
          const fromHomeTab = body.view?.type === "home";

          // Get the message timestamp to keep demo response in same thread (if not from home)
          const demoMessageTs = body.message?.ts;

          // Pass the fromHomeTab flag to ensure DM is sent when clicked from home
          await handleTryDemo(
            this.database,
            userId,
            channelId,
            client,
            demoMessageTs,
            fromHomeTab
          );

          // Update home tab after demo setup
          await this.updateAppHome(userId, client);
          break;
        }

        default:
          // Handle blockkit form button clicks
          if (actionId.startsWith("blockkit_form_")) {
            await handleBlockkitForm(
              actionId,
              userId,
              channelId,
              messageTs,
              body,
              client
            );
          }
          // Handle executable code block buttons
          else if (
            actionId.match(/^(bash|python|javascript|js|typescript|ts|sql|sh)_/)
          ) {
            await handleExecutableCodeBlock(
              actionId,
              userId,
              channelId,
              messageTs,
              body,
              client,
              (context: SlackContext, userRequest: string, client: any) =>
                this.messageHandler.handleUserRequest(
                  context,
                  userRequest,
                  client
                )
            );
          }
          // Handle stop worker button clicks
          else if (actionId.startsWith("stop_worker_")) {
            const deploymentName = actionId.replace("stop_worker_", "");
            await handleStopWorker(
              deploymentName,
              userId,
              channelId,
              messageTs,
              client
            );
          }
          // Handle GitHub Pull Request button clicks
          else if (actionId.startsWith("github_pr_")) {
            await this.handleGitHubPullRequestAction(
              actionId,
              userId,
              channelId,
              messageTs,
              body,
              client
            );
          } else {
            logger.info(
              `Unsupported action: ${actionId} from user ${userId} in channel ${channelId}`
            );
          }

          break;
      }
    }
  }

  /**
   * Handle GitHub Pull Request action
   */
  async handleGitHubPullRequestAction(
    actionId: string,
    userId: string,
    channelId: string,
    messageTs: string,
    body: any,
    client: any
  ): Promise<void> {
    const action = body.actions?.[0];
    const value = action?.value;

    if (!value) {
      logger.warn(`No value in GitHub PR action: ${actionId}`);
      return;
    }

    let metadata;
    try {
      metadata = JSON.parse(value);
    } catch (error) {
      logger.error(`Failed to parse GitHub PR metadata: ${error}`);
      return;
    }

    const { action: prAction, repo, branch, prompt } = metadata;

    logger.info(
      `GitHub PR action: ${prAction} for repo: ${repo}, branch: ${branch}`
    );

    try {
      if (prAction === "create_pr") {
        const pullRequestPrompt =
          prompt ||
          "Review your code, cleanup temporary files, commit changes to GIT and create a pull request";

        // Get the actual thread_ts from the message
        const actualThreadTs = body.message?.thread_ts || body.message?.ts;

        // Post confirmation message with the prompt (which is already markdown formatted)
        const inputMessage = await client.chat.postMessage({
          channel: channelId,
          thread_ts: actualThreadTs,
          text: `Pull Request requested`,
          blocks: [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `<@${userId}> requested a pull request`,
                },
              ],
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: pullRequestPrompt,
              },
            },
          ],
        });

        const context: SlackContext = {
          channelId,
          userId,
          teamId: body.team?.id || "",
          threadTs: actualThreadTs,
          messageTs: inputMessage.ts as string,
          text: `Pull Request requested for ${branch}`,
          userDisplayName: body.user?.username || "User",
        };

        // Send the raw prompt to Claude, not the display version
        await this.messageHandler.handleUserRequest(
          context,
          pullRequestPrompt,
          client
        );
      }
    } catch (error) {
      logger.error(`Failed to handle GitHub PR action: ${error}`);
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: body.message?.thread_ts || messageTs,
        text: `❌ Failed to create pull request: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  /**
   * Update App Home tab with repository information and README
   */
  async updateAppHome(userId: string, client: any): Promise<void> {
    logger.info(
      `Updating app home for user: ${userId} with README from active repository`
    );

    try {
      // Get GitHub connection status for demo purposes
      let githubUser = { token: null, username: null };
      try {
        const { moduleRegistry } = await import("../../../../../modules");
        const gitHubModule = moduleRegistry.getModule("github");
        if (gitHubModule && "getUserInfo" in gitHubModule) {
          githubUser = await (gitHubModule as any).getUserInfo(userId);
        }
      } catch (error) {
        logger.warn("GitHub module not available for home tab");
      }
      const isGitHubConnected = !!githubUser.token;

      const blocks: any[] = [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Welcome to Peerbot!* 👋" },
        },
        {
          type: "divider",
        },
      ];

      // Add module-rendered home tab sections
      let homeTabModules: any[] = [];
      try {
        const { moduleRegistry } = await import("../../../../../modules");
        homeTabModules = moduleRegistry.getHomeTabModules();
      } catch (error) {
        logger.warn("Module registry not available for home tab rendering");
      }
      for (const module of homeTabModules) {
        try {
          const moduleBlocks = await module.renderHomeTab!(userId);
          blocks.push(...moduleBlocks);
          if (moduleBlocks.length > 0) {
            blocks.push({ type: "divider" });
          }
        } catch (error) {
          logger.error(
            `Failed to render home tab for module ${module.name}:`,
            error
          );
        }
      }

      // Demo functionality (non-module specific)
      if (process.env.DEMO_REPOSITORY && !isGitHubConnected) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*🎮 Demo Mode*\nTry Peerbot with a demo repository",
          },
        });

        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "🎮 Try Demo" },
              action_id: "try_demo",
              style: "primary",
            },
          ],
        });

        blocks.push({ type: "divider" });
      }

      // Add quick tips
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*💡 Quick Tips:*\n" +
            "• Mention me in any channel or DM me directly\n" +
            "• Ask questions about code, create features, or fix bugs\n" +
            "• Use `/peerbot help` for all commands",
        },
      });

      // Update the app home view
      await client.views.publish({
        user_id: userId,
        view: {
          type: "home",
          blocks,
        },
      });

      logger.info(`App home updated for user ${userId}`);
    } catch (error) {
      logger.error(`Failed to update app home for user ${userId}:`, error);
    }
  }
}
