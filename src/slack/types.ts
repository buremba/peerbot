#!/usr/bin/env bun

// Slack-specific types and interfaces

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

export interface SlackRunContext {
  context: SlackContext;
  initialMessageTs: string;
  workingReactionAdded: boolean;
  executionStartTime: number;
  claudeExecutionId?: string;
}

export interface SlackMessageUpdate {
  channel: string;
  ts: string;
  text: string;
  blocks?: any[];
}

export enum EmojiStatus {
  Working = "hourglass_flowing_sand",
  Completed = "white_check_mark", 
  Error = "x",
  Info = "information_source",
}

export interface SlackExecutionResult {
  success: boolean;
  finalMessage?: string;
  error?: string;
  duration?: number;
  cost?: number;
}

export interface SlackEventData {
  event: {
    type: string;
    channel: string;
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
    channel_type?: string;
  };
  team_id: string;
  api_app_id: string;
  event_id: string;
  event_time: number;
}

export interface SlackAppMentionEvent {
  type: "app_mention";
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  team: string;
}

export interface SlackMessageEvent {
  type: "message";
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  team: string;
  channel_type: string;
}

// Type guards
export function isSlackAppMentionEvent(event: any): event is SlackAppMentionEvent {
  return event?.type === "app_mention" && 
         typeof event.channel === "string" &&
         typeof event.user === "string" &&
         typeof event.text === "string" &&
         typeof event.ts === "string";
}

export function isSlackMessageEvent(event: any): event is SlackMessageEvent {
  return event?.type === "message" &&
         typeof event.channel === "string" &&
         typeof event.user === "string" &&
         typeof event.text === "string" &&
         typeof event.ts === "string";
}

export function isValidSlackContext(context: any): context is SlackContext {
  return typeof context === "object" &&
         typeof context.channelId === "string" &&
         typeof context.userId === "string" &&
         typeof context.teamId === "string" &&
         typeof context.messageTs === "string" &&
         typeof context.text === "string";
}