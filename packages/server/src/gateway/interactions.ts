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
export function assertSafeLinkButtonUrl(url: string): void {
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
 * Refuse to post a chat-platform interaction event without a non-empty
 * `connectionId`.
 *
 * For chat platforms, `connectionId` is the routing key that prevents
 * cross-tenant / cross-connection event leakage: the interaction bridge's
 * `shouldHandle` filter would otherwise fall through when
 * `event.connectionId` is falsy. Fail closed at post-time so a missing
 * connection id surfaces as an error rather than silently routing to the
 * wrong tenant.
 *
 * `platform: "api"` is exempt: API sessions have no Chat SDK connection at
 * all — their cards are routed by `conversationId` through the API
 * platform's own `event.platform === "api"` subscriptions, and the bridge's
 * `shouldHandle` drops foreign-platform events (`event.platform` check), so
 * there is no bridge to leak through. Requiring a connectionId here is what
 * silently broke ask_user/tool-approval for every API/SPA session (#847).
 */
export function assertRoutableInteraction(
  connectionId: string | undefined,
  platform: string,
  kind: string
): void {
  if (platform === "api") return;
  if (!connectionId) {
    throw new Error(
      `Refusing to post ${kind}: connectionId is required to prevent cross-platform event leakage`
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
    options: string[],
    source?: string
  ): Promise<PostedQuestion> {
    assertRoutableInteraction(connectionId, platform, "question");
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
      source,
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
    grantPattern: string,
    source?: string
  ): Promise<PostedToolApproval> {
    assertRoutableInteraction(connectionId, platform, "tool approval");
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
      source,
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
    body?: string,
    source?: string
  ): Promise<PostedLinkButton> {
    assertRoutableInteraction(connectionId, platform, "link button");
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
      source,
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
    body?: string,
    source?: string
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
      body,
      source
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
    assertRoutableInteraction(connectionId, platform, "status message");
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
