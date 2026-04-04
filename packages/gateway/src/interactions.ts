#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createLogger, type UserSuggestion } from "@lobu/core";

const logger = createLogger("interactions");

/**
 * Payload emitted on "question:created" — platform renderers listen for this.
 */
export interface PostedQuestion {
  id: string;
  userId: string;
  conversationId: string;
  channelId: string;
  teamId?: string;
  connectionId?: string;
  question: string;
  options: string[];
}

/**
 * Payload emitted on "link-button:created" — platform renderers listen for this.
 */
export interface PostedLinkButton {
  id: string;
  userId: string;
  conversationId: string;
  channelId: string;
  teamId?: string;
  connectionId?: string;
  platform: string;
  url: string;
  label: string;
  linkType: "settings" | "install" | "oauth";
}

/**
 * Payload emitted on "grant:requested" — platform renderers listen for this.
 */
export interface PostedGrantRequest {
  id: string;
  userId: string;
  agentId: string;
  conversationId: string;
  channelId: string;
  teamId?: string;
  connectionId?: string;
  domains: string[];
  reason: string;
}

/**
 * Payload emitted on "package:requested" — platform renderers listen for this.
 */
export interface PostedPackageRequest {
  id: string;
  userId: string;
  agentId: string;
  conversationId: string;
  channelId: string;
  teamId?: string;
  packages: string[];
  reason: string;
}

/**
 * Payload emitted on "config:requested" — platform renderers listen for this.
 */
export interface PostedConfigRequest {
  id: string;
  userId: string;
  agentId: string;
  conversationId: string;
  channelId: string;
  teamId?: string;
  connectionId?: string;
  text: string;
}

/**
 * Payload emitted on "status-message:created" — platform renderers listen for this.
 */
export interface PostedStatusMessage {
  id: string;
  conversationId: string;
  channelId: string;
  teamId?: string;
  connectionId?: string;
  platform: string;
  text: string;
}

/**
 * Platform-agnostic interaction service (fire-and-forget).
 * Posts questions with buttons; no Redis, no blocking, no state machine.
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
   * Post a grant request with approve/deny buttons (non-blocking, fire-and-forget).
   * Emits "grant:requested" for platform renderers.
   */
  async postGrantRequest(
    userId: string,
    agentId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    domains: string[],
    reason: string
  ): Promise<PostedGrantRequest> {
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedGrantRequest = {
      id: `gr_${randomUUID()}`,
      userId,
      agentId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      domains,
      reason,
    };

    logger.info(
      `Posted grant request ${posted.id} for agent ${agentId} domains=${domains.join(",")}`
    );

    this.emit("grant:requested", posted);
    return posted;
  }

  /**
   * Post a package install request with approve/deny buttons (non-blocking, fire-and-forget).
   * Emits "package:requested" for platform renderers.
   */
  async postPackageRequest(
    userId: string,
    agentId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    packages: string[],
    reason: string
  ): Promise<PostedPackageRequest> {
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedPackageRequest = {
      id: `pkg_${randomUUID()}`,
      userId,
      agentId,
      conversationId,
      channelId,
      teamId,
      packages,
      reason,
    };

    logger.info(
      `Posted package request ${posted.id} for agent ${agentId} packages=${packages.join(",")}`
    );

    this.emit("package:requested", posted);
    return posted;
  }

  /**
   * Post a config request with approve/deny buttons (non-blocking).
   * Emits "config:requested" for platform renderers.
   */
  async postConfigRequest(
    userId: string,
    agentId: string,
    conversationId: string,
    channelId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    text: string
  ): Promise<PostedConfigRequest> {
    if (this.beforeCreateHook) {
      await this.beforeCreateHook(userId, conversationId);
    }

    const posted: PostedConfigRequest = {
      id: `cfg_${randomUUID()}`,
      userId,
      agentId,
      conversationId,
      channelId,
      teamId,
      connectionId,
      text,
    };

    logger.info(
      `Posted config request ${posted.id} for agent ${agentId} conversation ${conversationId}`
    );

    this.emit("config:requested", posted);
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
    linkType: "settings" | "install" | "oauth"
  ): Promise<PostedLinkButton> {
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
      linkType,
    };

    logger.info(
      `Posted link button ${posted.id} for conversation ${conversationId} (${linkType})`
    );

    this.emit("link-button:created", posted);
    return posted;
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
