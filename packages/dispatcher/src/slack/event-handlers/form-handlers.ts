#!/usr/bin/env bun

import { createLogger, type DatabaseAdapter } from "@peerbot/shared";
import {
  extractEnvVariables,
  hasEnvVariables,
  storeEnvVariables,
} from "../utils/env-storage";

const logger = createLogger("dispatcher");

/**
 * Form submission handlers and utilities
 */

/**
 * Handle blockkit form submissions
 */
export async function handleBlockkitFormSubmission(
  database: DatabaseAdapter,
  userId: string,
  view: any,
  client: any,
  handleUserRequestFn: (
    context: any,
    userInput: string,
    client: any
  ) => Promise<void>
): Promise<void> {
  logger.info(`Handling blockkit form submission for user: ${userId}`);

  const metadata = view.private_metadata
    ? JSON.parse(view.private_metadata)
    : {};
  const channelId = metadata.channel_id;
  const threadTs = metadata.thread_ts;
  const buttonText = metadata.button_text || "Form";

  if (!channelId || !threadTs) {
    logger.error(
      "Missing channel or thread information in blockkit form submission"
    );
    return;
  }

  // Check if this form contains environment variables (action_ids with "env:" prefix)
  if (hasEnvVariables(view.state.values)) {
    logger.info("Form contains environment variables, storing directly");

    const envVars = extractEnvVariables(view.state.values);
    if (envVars.length > 0) {
      const repository = metadata.repository || null;
      const result = await storeEnvVariables(
        database,
        userId,
        envVars,
        channelId,
        repository
      );

      if (result.stored.length > 0) {
        logger.info(
          `Stored ${result.stored.length} env variables: ${result.stored.join(", ")}`
        );

        // Send confirmation message
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `✅ Successfully stored ${result.stored.length} environment variable(s):\n${result.stored.map((v) => `• ${v}`).join("\n")}\n\nThese are now available in your Claude sessions.`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ *Environment Variables Stored*`,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Successfully stored ${result.stored.length} environment variable(s):\n${result.stored.map((v) => `• \`${v}\``).join("\n")}`,
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "🔒 Values are encrypted and will be available in your next Claude session",
                },
              ],
            },
          ],
        });
      }

      if (result.failed.length > 0) {
        logger.error(
          `Failed to store ${result.failed.length} env variables: ${result.failed.join(", ")}`
        );
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `⚠️ Failed to store some environment variables: ${result.failed.join(", ")}`,
        });
      }

      // Return early - don't post the form content to thread
      return;
    }
  }

  // Normal form processing (non-env variables)
  // Extract input fields from state values
  const inputFieldsData = extractViewInputs(view.state.values);

  // Extract action selections from view blocks (for button-based forms)
  const actionSelections = extractActionSelections(view);

  // Combine both input fields and action selections
  const userInput = [inputFieldsData, actionSelections]
    .filter((data) => data.trim())
    .join("\n");

  // If no form inputs were found, extract the content from the modal blocks
  // This handles cases where the blockkit is just informational content with action buttons
  if (!userInput.trim()) {
    logger.info(
      `No form inputs found, extracting modal content for button: ${buttonText}`
    );

    // Extract text content from the modal blocks
    const modalContent = extractModalContent(view.blocks);
    const userInput = modalContent || `Selected "${buttonText}"`;

    const formattedInput = `> 📝 *Form submitted from "${buttonText}" button*\n\n${userInput}`;

    const inputMessage = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: formattedInput,
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `<@${userId}> submitted form from "${buttonText}" button`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: userInput,
          },
        },
      ],
    });

    const context = {
      channelId,
      userId,
      userDisplayName: metadata.user_display_name || "Unknown User",
      teamId: metadata.team_id || "",
      messageTs: inputMessage.ts as string,
      threadTs: threadTs,
      text: userInput,
    };

    await handleUserRequestFn(context, userInput, client);
    return;
  }

  try {
    const formattedInput = `> 📝 *Form submitted from "${buttonText}" button*\n\n${userInput}`;

    const inputMessage = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: formattedInput,
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `<@${userId}> submitted form from "${buttonText}" button`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: userInput,
          },
        },
      ],
    });

    const context = {
      channelId,
      userId,
      userDisplayName: metadata.user_display_name || "Unknown User",
      teamId: metadata.team_id || "",
      messageTs: inputMessage.ts as string,
      threadTs: threadTs,
      text: userInput,
    };

    await handleUserRequestFn(context, userInput, client);
  } catch (error) {
    logger.error(`Failed to handle blockkit form submission:`, error);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `❌ Failed to process form submission: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}

/**
 * Handle repository override submissions
 */
export async function handleRepositoryOverrideSubmission(
  userId: string,
  view: any,
  client: any,
  getOrCreateUserMappingFn: (userId: string, client: any) => Promise<string>,
  updateAppHomeFn: (userId: string, client: any) => Promise<void>,
  repositoryCache: Map<string, { repository: any; timestamp: number }>
): Promise<void> {
  logger.info(`Handling repository override submission for user: ${userId}`);

  const repoUrl = view.state.values?.repo_input?.repo_url?.value?.trim();
  const metadata = view.private_metadata
    ? JSON.parse(view.private_metadata)
    : {};
  const channelId = metadata.channel_id;
  const threadTs = metadata.thread_ts;

  if (!repoUrl) {
    if (channelId && threadTs) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "Please provide a repository URL.",
      });
    } else {
      const im = await client.conversations.open({ users: userId });
      if (im.channel?.id) {
        await client.chat.postMessage({
          channel: im.channel.id,
          text: "Please provide a repository URL.",
        });
      }
    }
    return;
  }

  const username = await getOrCreateUserMappingFn(userId, client);

  // Update memory cache
  try {
    // Also update memory cache for immediate use
    repositoryCache.set(username, {
      repository: { repositoryUrl: repoUrl },
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error(`Failed to save repository URL for ${username}:`, error);
    if (channelId && threadTs) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "❌ Failed to save repository URL. Please try again.",
      });
    } else {
      const im = await client.conversations.open({ users: userId });
      if (im.channel?.id) {
        await client.chat.postMessage({
          channel: im.channel.id,
          text: "❌ Failed to save repository URL. Please try again.",
        });
      }
    }
    return;
  }

  // Send confirmation message if triggered from a thread
  if (channelId && threadTs) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `✅ Repository set to ${repoUrl}`,
    });
  } else {
    // If triggered from home tab, send a DM confirmation and refresh home tab
    const im = await client.conversations.open({ users: userId });
    if (im.channel?.id) {
      await client.chat.postMessage({
        channel: im.channel.id,
        text: `✅ Repository set to ${repoUrl}`,
      });
    }

    // Refresh the home tab to show updated repository
    await updateAppHomeFn(userId, client);
  }
}

function extractViewInputs(stateValues: any): string {
  const inputs: string[] = [];
  for (const [blockId, block] of Object.entries(stateValues || {})) {
    for (const [actionId, action] of Object.entries(block as any)) {
      let value = "";

      // Handle different types of Slack form inputs
      if ((action as any).value) {
        value = (action as any).value;
      } else if ((action as any).selected_option?.value) {
        value = (action as any).selected_option.value;
      } else if ((action as any).selected_options) {
        // Multi-select
        const options = (action as any).selected_options;
        value = options.map((opt: any) => opt.value).join(", ");
      } else if ((action as any).selected_date) {
        value = (action as any).selected_date;
      } else if ((action as any).selected_time) {
        value = (action as any).selected_time;
      } else if ((action as any).selected_button) {
        // Handle button selections (radio buttons, etc.)
        value = (action as any).selected_button.value;
      } else if ((action as any).selected_user) {
        // Handle user picker
        value = (action as any).selected_user;
      } else if ((action as any).selected_channel) {
        // Handle channel picker
        value = (action as any).selected_channel;
      } else if ((action as any).selected_conversation) {
        // Handle conversation picker
        value = (action as any).selected_conversation;
      } else if (
        (action as any).actions &&
        Array.isArray((action as any).actions)
      ) {
        // Handle action blocks with button selections
        const selectedActions = (action as any).actions.filter(
          (act: any) => act.selected || act.value
        );
        if (selectedActions.length > 0) {
          value = selectedActions
            .map((act: any) => act.value || act.text?.text || act.action_id)
            .join(", ");
        }
      }

      if (value?.toString().trim()) {
        // Use actionId as label if available, otherwise use blockId
        const label = actionId || blockId;
        // Convert snake_case or camelCase to readable format
        const readableLabel = label
          .replace(/[_-]/g, " ")
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .split(" ")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");

        inputs.push(`*${readableLabel}:* ${value}`);
      }
    }
  }

  // Debug logging to help troubleshoot form submission issues
  logger.info(
    `Form submission debug - stateValues: ${JSON.stringify(stateValues, null, 2)}`
  );
  logger.info(`Extracted inputs: ${inputs.join(", ")}`);

  return inputs.join("\n");
}

/**
 * Extract text content from modal blocks (for display-only forms)
 */
function extractModalContent(blocks: any[]): string {
  const content: string[] = [];

  if (!blocks || !Array.isArray(blocks)) {
    return "";
  }

  for (const block of blocks) {
    if (block.type === "section" && block.text?.text) {
      // Extract section text content
      let text = block.text.text;
      // Clean up markdown formatting for plain text
      text = text.replace(/\*\*(.+?)\*\*/g, "$1"); // Bold
      text = text.replace(/\*(.+?)\*/g, "$1"); // Italic
      text = text.replace(/`(.+?)`/g, "$1"); // Code
      content.push(text);
    } else if (block.type === "context" && block.elements) {
      // Extract context elements
      for (const element of block.elements) {
        if (element.type === "mrkdwn" && element.text) {
          const text = element.text
            .replace(/\*\*(.+?)\*\*/g, "$1")
            .replace(/\*(.+?)\*/g, "$1");
          content.push(text);
        }
      }
    }
  }

  return content.join("\n").trim();
}

/**
 * Extract action selections from view blocks (for button-based forms)
 */
function extractActionSelections(view: any): string {
  const selections: string[] = [];

  if (!view.blocks || !Array.isArray(view.blocks)) {
    return "";
  }

  for (const block of view.blocks) {
    if (block.type === "actions" && block.elements) {
      // This is an action block with buttons/elements
      for (const element of block.elements) {
        if (element.type === "button" && element.text?.text) {
          // For now, we'll capture the button text as the user's selection
          // In a real scenario, we'd need to track which button was actually clicked
          // But since this is a modal submission, we know the user made a selection
          selections.push(`Selected: ${element.text.text}`);
        } else if (
          element.type === "static_select" &&
          element.placeholder?.text
        ) {
          selections.push(`Option available: ${element.placeholder.text}`);
        }
      }
    } else if (block.type === "section" && block.text?.text) {
      // Capture section text as context
      const text = block.text.text;
      if (text && !text.includes("Would you like to")) {
        selections.push(text);
      }
    }
  }

  return selections.join("\n");
}
