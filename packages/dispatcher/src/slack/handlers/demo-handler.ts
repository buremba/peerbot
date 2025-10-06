import { createLogger, type DatabaseAdapter } from "@peerbot/shared";

const logger = createLogger("dispatcher");

/**
 * Handle Try Demo action - sets up demo repository for user
 */
export async function handleTryDemo(
  database: DatabaseAdapter,
  userId: string,
  channelId: string,
  client: any,
  threadTs?: string,
  fromHomeTab: boolean = false
): Promise<void> {
  try {
    // Get demo repository from environment or use default
    const demoRepo = process.env.DEMO_REPOSITORY;

    if (!demoRepo) {
      throw new Error("DEMO_REPOSITORY environment variable is not set");
    }

    // Parse repository info for display
    const repoPath = demoRepo
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
    const [owner, repo] = repoPath.split("/");

    // Store repository selection for the demo user
    await database.saveEnvironmentVariables({
      platformUserId: userId,
      variables: [
        {
          name: "GITHUB_REPOSITORY",
          value: demoRepo,
          repository: demoRepo,
          type: "user",
          encrypt: false,
        },
      ],
    });

    // If from home tab, open a DM conversation first
    let targetChannel = channelId;
    if (fromHomeTab) {
      try {
        const result = await client.conversations.open({
          users: userId,
        });
        targetChannel = result.channel.id;
      } catch (error) {
        logger.error("Failed to open DM conversation:", error);
        targetChannel = userId; // Fallback to user ID
      }
    }

    // Send confirmation and instructions (in thread if available and not from home tab)
    const messagePayload: any = {
      channel: targetChannel,
      text: "🎮 Demo mode activated!",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "🎮 *Demo mode activated!*\n\n" +
              `You're connected to the *${owner}/${repo}* - Peerbot landing page on https://peerbot.ai.`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Try these quick examples:*",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📄 Show landing page structure",
              },
              action_id: "blockkit_form_demo_1",
              value: JSON.stringify({
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: "Show me the structure of the landing page and what technologies it uses",
                    },
                  },
                ],
              }),
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🎨 Improve hero section",
              },
              action_id: "blockkit_form_demo_2",
              value: JSON.stringify({
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: "Analyze the hero section and suggest improvements for better conversion",
                    },
                  },
                ],
              }),
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✨ Add new feature",
              },
              action_id: "blockkit_form_demo_3",
              value: JSON.stringify({
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: "Add a testimonials section to the landing page with animated cards",
                    },
                  },
                ],
              }),
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🔍 SEO analysis",
              },
              action_id: "blockkit_form_demo_4",
              value: JSON.stringify({
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: "Analyze the SEO of this landing page and suggest improvements",
                    },
                  },
                ],
              }),
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*Or type your own request:*\n" +
              "Just message me what you'd like to explore or build!",
          },
        },
        {
          type: "divider",
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "💡 When you're ready to work with your own repos, use `/peerbot login` to connect your GitHub account.",
            },
          ],
        },
      ],
    };

    // Add thread_ts if provided and not from home tab (to keep in same thread as welcome message)
    if (threadTs && !fromHomeTab) {
      messagePayload.thread_ts = threadTs;
    }

    await client.chat.postMessage(messagePayload);

    logger.info(`Demo mode activated for user ${userId} with repo ${demoRepo}`);
  } catch (error) {
    logger.error(`Failed to set demo mode for user ${userId}:`, error);
    const messagePayload: any = {
      channel: channelId,
      text: "❌ Failed to activate demo mode. Please try again.",
    };
    if (threadTs) {
      messagePayload.thread_ts = threadTs;
    }
    await client.chat.postMessage(messagePayload);
  }
}

// No need for clearDemoMode - user can just select a different repository
