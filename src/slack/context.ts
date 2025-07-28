#!/usr/bin/env bun

import type { 
  SlackContext, 
  SlackAppMentionEvent, 
  SlackMessageEvent,
  isSlackAppMentionEvent,
  isSlackMessageEvent,
  isValidSlackContext 
} from "./types";
import type { GenericContext, GenericComment } from "../core/prompt";

export { isSlackAppMentionEvent, isSlackMessageEvent, isValidSlackContext };

/**
 * Parse Slack app mention event into SlackContext
 */
export function parseAppMentionEvent(event: SlackAppMentionEvent): SlackContext {
  return {
    channelId: event.channel,
    userId: event.user,
    teamId: event.team,
    threadTs: event.thread_ts,
    messageTs: event.ts,
    text: event.text,
  };
}

/**
 * Parse Slack message event into SlackContext
 */
export function parseMessageEvent(event: SlackMessageEvent): SlackContext {
  return {
    channelId: event.channel,
    userId: event.user,
    teamId: event.team,
    threadTs: event.thread_ts,
    messageTs: event.ts,
    text: event.text,
  };
}

/**
 * Parse generic Slack event into SlackContext
 */
export function parseSlackEvent(event: any): SlackContext | null {
  if (isSlackAppMentionEvent(event)) {
    return parseAppMentionEvent(event);
  }
  
  if (isSlackMessageEvent(event)) {
    return parseMessageEvent(event);
  }

  return null;
}

/**
 * Extract trigger text from Slack message, removing bot mention
 */
export function extractTriggerText(text: string, botUserId?: string): string {
  let cleanText = text;

  // Remove bot mention if present
  if (botUserId) {
    const mentionPattern = new RegExp(`<@${botUserId}>`, "g");
    cleanText = cleanText.replace(mentionPattern, "").trim();
  }

  // Remove any other user mentions from the beginning
  cleanText = cleanText.replace(/^<@\w+>\s*/, "").trim();

  return cleanText;
}

/**
 * Validate Slack context data
 */
export function validateSlackContext(context: any): context is SlackContext {
  return isValidSlackContext(context);
}

/**
 * Convert Slack message history to generic comments format
 */
export function convertSlackMessagesToComments(
  messages: any[],
  currentUserId?: string,
): GenericComment[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter(msg => msg.user !== currentUserId) // Exclude bot's own messages
    .map((msg) => ({
      id: msg.ts,
      body: msg.text || "",
      author: msg.username || msg.user || "Unknown",
      createdAt: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      url: `slack://channel?team=${msg.team}&id=${msg.channel}&message=${msg.ts}`,
    }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/**
 * Convert SlackContext to GenericContext for use with core prompt generation
 */
export function convertSlackToGenericContext(
  slackContext: SlackContext,
  options: {
    triggerPhrase?: string;
    customInstructions?: string;
    directPrompt?: string;
    overridePrompt?: string;
    allowedTools?: string;
    disallowedTools?: string;
    messages?: any[];
    userDisplayName?: string;
    botUserId?: string;
  } = {},
): GenericContext {
  const triggerText = extractTriggerText(slackContext.text, options.botUserId);
  
  // Determine event type and context
  let eventType = "SLACK_MENTION";
  let triggerContext = `slack mention with '${options.triggerPhrase || "@bot"}'`;
  
  if (slackContext.threadTs) {
    eventType = "SLACK_THREAD_REPLY";
    triggerContext = `slack thread reply with '${options.triggerPhrase || "@bot"}'`;
  }

  // Convert messages to comments if provided
  const comments = options.messages 
    ? convertSlackMessagesToComments(options.messages, options.botUserId)
    : [];

  return {
    repository: undefined, // Not applicable for Slack
    platform: "slack",
    eventType,
    triggerContext,
    triggerUsername: slackContext.userId,
    triggerDisplayName: options.userDisplayName,
    triggerPhrase: options.triggerPhrase || "@bot",
    triggerComment: triggerText,
    customInstructions: options.customInstructions,
    directPrompt: options.directPrompt,
    overridePrompt: options.overridePrompt,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    
    // Context data
    contextData: {
      title: slackContext.threadTs ? "Thread Reply" : "Channel Message",
      body: slackContext.text,
      author: slackContext.userId,
      createdAt: new Date(parseFloat(slackContext.messageTs) * 1000).toISOString(),
      url: slackContext.messageUrl,
    },
    comments,
    
    // Slack-specific tracking
    trackingId: slackContext.messageTs,
    channelId: slackContext.channelId,
    threadTs: slackContext.threadTs,
  };
}

/**
 * Create Slack channel URL
 */
export function createSlackChannelUrl(teamId: string, channelId: string): string {
  return `slack://channel?team=${teamId}&id=${channelId}`;
}

/**
 * Create Slack message URL
 */
export function createSlackMessageUrl(
  teamId: string, 
  channelId: string, 
  messageTs: string,
): string {
  return `slack://channel?team=${teamId}&id=${channelId}&message=${messageTs}`;
}

/**
 * Parse Slack timestamp to Date
 */
export function parseSlackTimestamp(ts: string): Date {
  return new Date(parseFloat(ts) * 1000);
}

/**
 * Check if message is in a thread
 */
export function isThreadMessage(context: SlackContext): boolean {
  return !!context.threadTs;
}

/**
 * Check if message is a direct message
 */
export function isDirectMessage(context: SlackContext): boolean {
  return context.channelId.startsWith("D");
}

/**
 * Check if message is in a private channel
 */
export function isPrivateChannel(context: SlackContext): boolean {
  return context.channelId.startsWith("G");
}

/**
 * Check if message is in a public channel
 */
export function isPublicChannel(context: SlackContext): boolean {
  return context.channelId.startsWith("C");
}