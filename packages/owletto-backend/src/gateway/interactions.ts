#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  type BaseMessage,
  createLogger,
  type UserSuggestion,
} from "@lobu/core";

const logger = createLogger("interactions");

const SAFE_LINK_BUTTON_SCHEMES = new Set(["http:", "https:"]);

/**
 * Reject URLs whose scheme could be used to execute code in the user's
 * client (e.g. `javascript:`, `data:`, `vbscript:`, `file:`) when posted
 * as a link button. We only accept normal web URLs.
 */
function assertSafeLinkButtonUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid link button URL: ${url}`);
  }
  if (!SAFE_LINK_BUTTON_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Refusing to post link button with unsafe scheme: ${parsed.protocol}`
    );
  }
}

/**
 * Payload emitted on "question:created" — platform renderers listen for this.
 */
export interface PostedQuestion extends BaseMessage {
  userId: string;
  platform: string;
  question: string;
  options: string[];
}

/**
 * Payload emitted on "link-button:created" — platform renderers listen for this.
 *
 * `body`: optional explanatory text shown above the button inside the card.
 * Leave undefined when the button label alone is self-explanatory — the
 * renderer will skip the card-body text entirely rather than duplicate the
 * button's own label.
 */
export interface PostedLinkButton extends BaseMessage {
  userId: string;
  platform: string;
  url: string;
  label: string;
  body?: string;
  linkType: "settings" | "install" | "oauth";
}

/**
 * Payload emitted on "tool:approval-needed" — platform renderers listen for this.
 */
export interface PostedToolApproval extends BaseMessage {
  agentId: string;
  userId: string;
  platform: string;
  mcpId: string;
  toolName: string;
  args: Record<string, unknown>;
  grantPattern: string;
}

/**
 * Payload emitted on "status-message:created" — platform renderers listen for this.
 */
export interface PostedStatusMessage extends BaseMessage {
  platform: string;
  text: string;
}

/**
 * Platform-agnostic interaction service (fire-and-forget).
 * Posts questions with buttons; no blocking, no state machine.
 * User clicks → platform converts to regular message → normal queue.
 */
export class InteractionService extends EventEmitter {
  private beforeCreateHook?: (
    userId: string,
    conversationId: string
  ) => Promise<void>;

  /**
   * Set a hook to run before creating interactions.
   * Used by platforms to stop streams before interaction messages appear.
   */
  setBeforeCreateHook(
    hook: (userId: string, conversationId: string) => Promise<void>
  ): void {
    this.beforeCreateHook = hook;
  }

  /**
   * Post a question with button options (non-blocking, fire-and-forget).
   * Emits "question:created" for platform renderers.
   */
  async postQuestion(
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    question: string,
    options: string[]
  ): Promise<PostedQuestion> {
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedQuestion = {
      id: `q_${randomUUID()}`,
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      question,
      options,
    };

    logger.info(
      `Posted question ${posted.id} for conversation ${conversationId}`
    );

    this.emit("question:created", posted);
    return posted;
  }

  /**
   * Post a tool approval request with duration buttons (non-blocking, fire-and-forget).
   * Emits "tool:approval-needed" for platform renderers.
   *
   * `requestId` MUST be the same value the MCP proxy used as the
   * `PendingToolStore` key. It's embedded into the button `actionId` so the
   * interaction bridge can look up the pending invocation on click.
   */
  async postToolApproval(
    requestId: string,
    agentId: string,
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    grantPattern: string
  ): Promise<PostedToolApproval> {
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedToolApproval = {
      id: requestId,
      agentId,
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      mcpId,
      toolName,
      args,
      grantPattern,
    };

    logger.info(
      `Posted tool approval ${posted.id} for ${mcpId}/${toolName} agent=${agentId}`
    );

    this.emit("tool:approval-needed", posted);
    return posted;
  }

  /**
   * Post a link button (non-blocking, fire-and-forget).
   * Emits "link-button:created" for platform renderers.
   */
  async postLinkButton(
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    url: string,
    label: string,
    linkType: "settings" | "install" | "oauth",
    body?: string
  ): Promise<PostedLinkButton> {
    assertSafeLinkButtonUrl(url);
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedLinkButton = {
      id: `lb_${randomUUID()}`,
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      url,
      label,
      body,
      linkType,
    };

    logger.info(
      `Posted link button ${posted.id} for conversation ${conversationId} (${linkType})`
    );

    this.emit("link-button:created", posted);
    return posted;
  }

  /**
   * Post an OAuth/login link button for an MCP auth flow.
   */
  async postOauthLink(
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    url: string,
    label: string,
    body?: string
  ): Promise<PostedLinkButton> {
    return this.postLinkButton(
      userId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      url,
      label,
      "oauth",
      body
    );
  }

  /**
   * Post a plain text status message (non-blocking, fire-and-forget).
   * Emits "status-message:created" for platform renderers.
   */
  async postStatusMessage(
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string,
    text: string
  ): Promise<PostedStatusMessage> {
    if (this.beforeCreateHook) {
      await this.beforeCreateHook("", conversationId);
    }

    const posted: PostedStatusMessage = {
      id: `sm_${randomUUID()}`,
      conversationId,
      channelId,
      teamId,
      connectionId,
      platform,
      text,
    };

    logger.info(
      `Posted status message ${posted.id} for conversation ${conversationId}`
    );

    this.emit("status-message:created", posted);
    return posted;
  }

  /**
   * Create non-blocking suggestions.
   * Emits event immediately, no state tracking needed.
   */
  async createSuggestion(
    userId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    prompts: Array<{ title: string; message: string }>
  ): Promise<void> {
    const suggestion: UserSuggestion = {
      id: `sug_${randomUUID()}`,
      userId,
      conversationId,
      channelId,
      teamId,
      blocking: false,
      prompts,
    };

    logger.info(
      `Created suggestion ${suggestion.id} for conversation ${conversationId}`
    );

    this.emit("suggestion:created", suggestion);
  }
}
