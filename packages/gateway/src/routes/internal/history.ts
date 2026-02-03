#!/usr/bin/env bun

import { createLogger, verifyWorkerToken } from "@peerbot/core";
import { Hono } from "hono";

const logger = createLogger("history-routes");

type WorkerContext = {
  Variables: {
    worker: {
      threadId: string;
      channelId: string;
      platform: string;
      teamId: string;
    };
  };
};

interface HistoryMessage {
  timestamp: string;
  user: string;
  text: string;
  isBot?: boolean;
}

interface HistoryResponse {
  messages: HistoryMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Create internal history routes (Hono)
 * Provides channel history to workers via MCP tool
 */
export function createHistoryRoutes(): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  // Worker authentication middleware
  const authenticateWorker = async (c: any, next: () => Promise<void>) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid authorization" }, 401);
    }
    const workerToken = authHeader.substring(7);
    const tokenData = verifyWorkerToken(workerToken);
    if (!tokenData) {
      return c.json({ error: "Invalid worker token" }, 401);
    }
    c.set("worker", tokenData);
    await next();
  };

  /**
   * Get channel history
   * GET /history?platform=slack&channelId=xxx&threadId=xxx&limit=50&before=timestamp
   */
  router.get("/history", authenticateWorker, async (c) => {
    try {
      const worker = c.get("worker");
      const platform = c.req.query("platform") || worker.platform || "slack";
      const channelId = c.req.query("channelId") || worker.channelId;
      const threadId = c.req.query("threadId") || worker.threadId;
      const limitStr = c.req.query("limit") || "50";
      const before = c.req.query("before"); // ISO timestamp cursor

      const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 100);

      if (!channelId) {
        return c.json({ error: "Missing channelId parameter" }, 400);
      }

      logger.info(`Fetching history for ${platform}/${channelId}`, {
        threadId,
        limit,
        before,
      });

      if (platform === "slack") {
        const response = await fetchSlackHistory(
          channelId,
          threadId,
          limit,
          before
        );
        return c.json(response);
      } else if (platform === "whatsapp") {
        // WhatsApp doesn't have server-side history storage
        return c.json({
          messages: [],
          nextCursor: null,
          hasMore: false,
          note: "WhatsApp history is not stored server-side",
        });
      } else {
        return c.json({ error: `Unsupported platform: ${platform}` }, 400);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to fetch history: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  return router;
}

// Cache for user info to avoid repeated API calls
const userCache = new Map<string, string>();

/**
 * Resolve Slack user ID to display name
 */
async function resolveUserName(
  userId: string,
  slackToken: string
): Promise<string> {
  if (userCache.has(userId)) {
    return userCache.get(userId)!;
  }

  try {
    const response = await fetch(
      `https://slack.com/api/users.info?user=${userId}`,
      {
        headers: { Authorization: `Bearer ${slackToken}` },
      }
    );
    const data = (await response.json()) as {
      ok: boolean;
      user?: { real_name?: string; name?: string };
    };
    if (data.ok && data.user) {
      const name = data.user.real_name || data.user.name || userId;
      userCache.set(userId, name);
      return name;
    }
  } catch {
    // Fall through to return userId
  }
  return userId;
}

/**
 * Fetch message history from Slack
 */
async function fetchSlackHistory(
  channelId: string,
  threadId: string | undefined,
  limit: number,
  before: string | undefined
): Promise<HistoryResponse> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    throw new Error("Slack token not configured");
  }

  // Convert ISO timestamp to Slack timestamp format (seconds.microseconds)
  let latestTs: string | undefined;
  if (before) {
    try {
      const date = new Date(before);
      latestTs = (date.getTime() / 1000).toFixed(6);
    } catch {
      // Ignore invalid dates
    }
  }

  // Use conversations.replies for threads, conversations.history for channels
  const endpoint = threadId
    ? "https://slack.com/api/conversations.replies"
    : "https://slack.com/api/conversations.history";

  const params = new URLSearchParams({
    channel: channelId,
    limit: String(limit),
  });

  if (threadId) {
    params.set("ts", threadId);
  }

  if (latestTs) {
    params.set("latest", latestTs);
    params.set("inclusive", "false");
  }

  const response = await fetch(`${endpoint}?${params}`, {
    headers: {
      Authorization: `Bearer ${slackToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    ok: boolean;
    error?: string;
    messages?: Array<{
      ts: string;
      user?: string;
      bot_id?: string;
      text?: string;
      subtype?: string;
    }>;
    has_more?: boolean;
    response_metadata?: {
      next_cursor?: string;
    };
  };

  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  // Collect unique user IDs for batch resolution
  const userIds = new Set<string>();
  for (const msg of data.messages || []) {
    if (msg.user) userIds.add(msg.user);
  }

  // Resolve user names in parallel
  await Promise.all(
    Array.from(userIds).map((id) => resolveUserName(id, slackToken))
  );

  const messages: HistoryMessage[] = (data.messages || [])
    .filter((msg) => {
      // Filter out system messages
      if (msg.subtype && !["bot_message", "me_message"].includes(msg.subtype)) {
        return false;
      }
      return true;
    })
    .map((msg) => ({
      timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      user: msg.user
        ? userCache.get(msg.user) || msg.user
        : msg.bot_id || "unknown",
      text: msg.text || "",
      isBot: !!msg.bot_id,
    }));

  // Calculate next cursor based on oldest message timestamp
  const oldestMessage = messages[messages.length - 1];
  const nextCursor = oldestMessage ? oldestMessage.timestamp : null;

  return {
    messages,
    nextCursor: data.has_more ? nextCursor : null,
    hasMore: data.has_more || false,
  };
}
