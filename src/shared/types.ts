#!/usr/bin/env bun

export interface SlackContext {
  channelId: string;
  userId: string;
  userDisplayName?: string;
  teamId: string;
  threadTs?: string;
  messageTs: string;
  text: string;
  messageUrl?: string;
}

export interface WorkerDeploymentRequest {
  userId: string;
  botId: string;
  agentSessionId: string;
  threadId: string;
  platform: string;
  platformUserId: string;
  messageId?: string;
  messageText?: string;
  channelId?: string;
  platformMetadata?: Record<string, any>;
  claudeOptions?: Record<string, any>;
  environmentVariables?: Record<string, string>;
}

export class BaseError extends Error {
  constructor(
    public operation: string,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = "BaseError";
  }
}