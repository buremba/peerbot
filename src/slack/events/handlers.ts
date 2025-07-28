#!/usr/bin/env bun

import type { App, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { 
  SlackAppMentionEvent, 
  SlackMessageEvent, 
  SlackContext 
} from "../types";
import { 
  parseSlackEvent, 
  extractTriggerText, 
  validateSlackContext,
  isDirectMessage,
  isPrivateChannel 
} from "../context";

export interface TriggerDetectionConfig {
  triggerPhrase?: string;
  botUserId?: string;
  allowDirectMessages?: boolean;
  allowPrivateChannels?: boolean;
  allowedUsers?: string[];
  blockedUsers?: string[];
  allowedChannels?: string[];
  blockedChannels?: string[];
}

export interface SlackTriggerResult {
  shouldRespond: boolean;
  context?: SlackContext;
  reason?: string;
  extractedText?: string;
}

/**
 * Check if a message contains the trigger phrase
 */
export function checkContainsTrigger(
  text: string, 
  triggerPhrase: string = "@bot",
  botUserId?: string,
): boolean {
  // If we have a bot user ID, check for direct mention
  if (botUserId && text.includes(`<@${botUserId}>`)) {
    return true;
  }

  // Check for trigger phrase (case insensitive)
  return text.toLowerCase().includes(triggerPhrase.toLowerCase());
}

/**
 * Validate permissions for user and channel
 */
export function validatePermissions(
  context: SlackContext,
  config: TriggerDetectionConfig,
): { allowed: boolean; reason?: string } {
  // Check blocked users
  if (config.blockedUsers?.includes(context.userId)) {
    return { allowed: false, reason: `User ${context.userId} is blocked` };
  }

  // Check allowed users (if specified)
  if (config.allowedUsers && config.allowedUsers.length > 0) {
    if (!config.allowedUsers.includes(context.userId)) {
      return { allowed: false, reason: `User ${context.userId} is not in allowed list` };
    }
  }

  // Check blocked channels
  if (config.blockedChannels?.includes(context.channelId)) {
    return { allowed: false, reason: `Channel ${context.channelId} is blocked` };
  }

  // Check allowed channels (if specified)
  if (config.allowedChannels && config.allowedChannels.length > 0) {
    if (!config.allowedChannels.includes(context.channelId)) {
      return { allowed: false, reason: `Channel ${context.channelId} is not in allowed list` };
    }
  }

  // Check direct message permissions
  if (isDirectMessage(context) && !config.allowDirectMessages) {
    return { allowed: false, reason: "Direct messages are not allowed" };
  }

  // Check private channel permissions
  if (isPrivateChannel(context) && !config.allowPrivateChannels) {
    return { allowed: false, reason: "Private channels are not allowed" };
  }

  return { allowed: true };
}

/**
 * Process trigger detection for Slack events
 */
export function processTriggerDetection(
  event: SlackAppMentionEvent | SlackMessageEvent,
  config: TriggerDetectionConfig,
): SlackTriggerResult {
  // Parse the event into context
  const context = parseSlackEvent(event);
  if (!context) {
    return { 
      shouldRespond: false, 
      reason: "Failed to parse Slack event" 
    };
  }

  // Validate context structure
  if (!validateSlackContext(context)) {
    return { 
      shouldRespond: false, 
      reason: "Invalid Slack context structure" 
    };
  }

  // Skip bot's own messages (should be handled by middleware but double-check)
  if (context.userId === config.botUserId) {
    return { 
      shouldRespond: false, 
      reason: "Ignoring bot's own message" 
    };
  }

  // Check permissions
  const permissionCheck = validatePermissions(context, config);
  if (!permissionCheck.allowed) {
    return { 
      shouldRespond: false, 
      reason: permissionCheck.reason 
    };
  }

  // For app mentions, we always respond (since user explicitly mentioned the bot)
  if (event.type === "app_mention") {
    const extractedText = extractTriggerText(context.text, config.botUserId);
    return {
      shouldRespond: true,
      context,
      extractedText,
    };
  }

  // For regular messages, check if they contain the trigger phrase
  if (event.type === "message") {
    const containsTrigger = checkContainsTrigger(
      context.text, 
      config.triggerPhrase, 
      config.botUserId
    );

    if (!containsTrigger) {
      return { 
        shouldRespond: false, 
        reason: `Message does not contain trigger phrase: ${config.triggerPhrase}` 
      };
    }

    const extractedText = extractTriggerText(context.text, config.botUserId);
    return {
      shouldRespond: true,
      context,
      extractedText,
    };
  }

  return { 
    shouldRespond: false, 
    reason: `Unsupported event type: ${event.type}` 
  };
}

/**
 * App mention event handler
 */
export function createAppMentionHandler(
  config: TriggerDetectionConfig,
  onTrigger: (context: SlackContext, extractedText: string) => Promise<void>,
) {
  return async ({ event, say, logger }: SlackEventMiddlewareArgs<"app_mention">) => {
    try {
      logger.info("Received app mention event", { 
        channel: event.channel, 
        user: event.user,
        text: event.text 
      });

      const result = processTriggerDetection(event, config);
      
      if (!result.shouldRespond) {
        logger.info("Skipping app mention", { reason: result.reason });
        return;
      }

      if (!result.context || !result.extractedText) {
        logger.error("Missing context or extracted text in trigger result");
        return;
      }

      logger.info("Processing app mention trigger", {
        channel: result.context.channelId,
        user: result.context.userId,
        extractedText: result.extractedText,
      });

      await onTrigger(result.context, result.extractedText);
    } catch (error) {
      logger.error("Error handling app mention", error);
      
      // Try to post error message
      try {
        await say("Sorry, I encountered an error processing your request. Please try again.");
      } catch (sayError) {
        logger.error("Failed to send error message", sayError);
      }
    }
  };
}

/**
 * Message event handler  
 */
export function createMessageHandler(
  config: TriggerDetectionConfig,
  onTrigger: (context: SlackContext, extractedText: string) => Promise<void>,
) {
  return async ({ event, say, logger }: SlackEventMiddlewareArgs<"message">) => {
    try {
      // Skip if this is not a regular message (e.g., bot message, message changed, etc.)
      if (event.subtype || !event.user || !event.text) {
        return;
      }

      logger.info("Received message event", { 
        channel: event.channel, 
        user: event.user,
        text: event.text 
      });

      const result = processTriggerDetection(event as SlackMessageEvent, config);
      
      if (!result.shouldRespond) {
        logger.debug("Skipping message", { reason: result.reason });
        return;
      }

      if (!result.context || !result.extractedText) {
        logger.error("Missing context or extracted text in trigger result");
        return;
      }

      logger.info("Processing message trigger", {
        channel: result.context.channelId,
        user: result.context.userId,
        extractedText: result.extractedText,
      });

      await onTrigger(result.context, result.extractedText);
    } catch (error) {
      logger.error("Error handling message", error);
      
      // Try to post error message  
      try {
        await say("Sorry, I encountered an error processing your request. Please try again.");
      } catch (sayError) {
        logger.error("Failed to send error message", sayError);
      }
    }
  };
}

/**
 * Register event handlers with the Slack app
 */
export function registerSlackEventHandlers(
  app: App,
  config: TriggerDetectionConfig,
  onTrigger: (context: SlackContext, extractedText: string) => Promise<void>,
): void {
  // Register app mention handler
  app.event("app_mention", createAppMentionHandler(config, onTrigger));

  // Register message handler (only if trigger phrase is configured for non-mentions)
  if (config.triggerPhrase) {
    app.event("message", createMessageHandler(config, onTrigger));
  }

  // Register error handler
  app.error(async (error) => {
    console.error("Slack app error:", error);
  });
}