/**
 * Agent history routes — proxy session data from worker HTTP server,
 * with direct session-file fallback for embedded dev mode.
 * Auth: settings session cookie (verifySettingsSession).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfigStore } from "@lobu/core";
import { createLogger } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";
import type { WorkerConnectionManager } from "../../gateway/connection-manager.js";
import { errorResponse } from "../shared/helpers.js";
import { createTokenVerifier } from "../shared/token-verifier.js";
import { verifySettingsSession } from "./settings-auth.js";

const logger = createLogger("agent-history-routes");

/** Alphanumeric, hyphens, and underscores only — no path separators or dots. */
const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]+$/;

function isSafeAgentId(id: string): boolean {
  return SAFE_AGENT_ID.test(id);
}

// ─── Direct session file reader (fallback) ─────────────────────────────────

interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role: string;
    content: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  summary?: string;
  provider?: string;
  modelId?: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
}

interface ParsedMessage {
  id: string;
  type: string;
  role?: string;
  content: unknown;
  model?: string;
  timestamp: string;
  isVerbose?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

async function findSessionFile(agentId: string): Promise<string | null> {
  if (!isSafeAgentId(agentId)) return null;
  const workspacesRoot = resolve("workspaces");
  const workspaceDir = resolve(workspacesRoot, agentId);
  if (!workspaceDir.startsWith(`${workspacesRoot}/`)) return null;

  // Direct: workspaces/{agentId}/.openclaw/session.jsonl
  const directPath = join(workspaceDir, ".openclaw", "session.jsonl");
  try {
    await stat(directPath);
    return directPath;
  } catch {
    // Not found
  }

  // Search subdirectories (up to 3 levels deep for nested workspace layouts)
  try {
    const search = async (
      dir: string,
      depth: number
    ): Promise<string | null> => {
      if (depth > 3) return null;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const sessionPath = join(dir, entry.name, ".openclaw", "session.jsonl");
        try {
          await stat(sessionPath);
          return sessionPath;
        } catch {
          // Try deeper
          const deeper = await search(join(dir, entry.name), depth + 1);
          if (deeper) return deeper;
        }
      }
      return null;
    };
    return await search(workspaceDir, 0);
  } catch {
    // Workspace dir doesn't exist
  }

  return null;
}

function parseSessionEntries(content: string): {
  entries: SessionEntry[];
  sessionId?: string;
} {
  const lines = content.split("\n").filter((l) => l.trim());
  const entries: SessionEntry[] = [];
  let sessionId: string | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "session") {
        sessionId = parsed.id;
        continue;
      }
      entries.push(parsed);
    } catch {
      // Skip malformed
    }
  }
  return { entries, sessionId };
}

function entryToMessage(entry: SessionEntry): ParsedMessage | null {
  if (entry.type === "message" && entry.message) {
    return {
      id: entry.id,
      type: "message",
      role: entry.message.role,
      content: entry.message.content,
      timestamp: entry.timestamp,
      isVerbose: entry.message.role === "toolResult",
      usage: entry.message.usage,
    };
  }
  if (entry.type === "compaction") {
    return {
      id: entry.id,
      type: "compaction",
      content: entry.summary || "",
      timestamp: entry.timestamp,
      isVerbose: true,
    };
  }
  if (entry.type === "model_change") {
    return {
      id: entry.id,
      type: "model_change",
      content: `${entry.provider}/${entry.modelId}`,
      model: `${entry.provider}/${entry.modelId}`,
      timestamp: entry.timestamp,
      isVerbose: true,
    };
  }
  if (entry.type === "custom_message") {
    return {
      id: entry.id,
      type: "custom_message",
      role: "user",
      content: entry.content,
      timestamp: entry.timestamp,
      isVerbose: !entry.display,
    };
  }
  return null;
}

async function readSessionMessages(
  agentId: string,
  cursorParam: string,
  limit: number
) {
  const sessionPath = await findSessionFile(agentId);
  if (!sessionPath) {
    return {
      messages: [],
      nextCursor: null,
      hasMore: false,
      sessionId: "none",
    };
  }
  const content = await readFile(sessionPath, "utf-8");
  const { entries, sessionId } = parseSessionEntries(content);

  const allMessages: ParsedMessage[] = [];
  for (const entry of entries) {
    const msg = entryToMessage(entry);
    if (msg) allMessages.push(msg);
  }

  let startIndex = 0;
  if (cursorParam) {
    const idx = allMessages.findIndex((m) => m.id === cursorParam);
    if (idx >= 0) startIndex = idx + 1;
  }

  const pageMessages = allMessages.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < allMessages.length;
  const nextCursor = hasMore ? pageMessages[pageMessages.length - 1]?.id : null;

  return {
    messages: pageMessages,
    nextCursor,
    hasMore,
    sessionId: sessionId || "unknown",
  };
}

async function readSessionStats(agentId: string) {
  const sessionPath = await findSessionFile(agentId);
  if (!sessionPath) {
    return {
      sessionId: "none",
      messageCount: 0,
      userMessages: 0,
      assistantMessages: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }
  const content = await readFile(sessionPath, "utf-8");
  const { entries, sessionId } = parseSessionEntries(content);

  let messageCount = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let currentModel: string | undefined;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      messageCount++;
      if (entry.message.role === "user") userMessages++;
      if (entry.message.role === "assistant") assistantMessages++;
      if (entry.message.usage) {
        const u = entry.message.usage as any;
        totalInputTokens += u.inputTokens || u.input || 0;
        totalOutputTokens += u.outputTokens || u.output || 0;
      }
    }
    if (entry.type === "model_change") {
      currentModel = `${entry.provider}/${entry.modelId}`;
    }
  }

  return {
    sessionId: sessionId || "unknown",
    messageCount,
    userMessages,
    assistantMessages,
    totalInputTokens,
    totalOutputTokens,
    currentModel,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export function createAgentHistoryRoutes(deps: {
  connectionManager: WorkerConnectionManager;
  chatInstanceManager?: ChatInstanceManager;
  agentConfigStore?: Pick<AgentConfigStore, "listSandboxes" | "getMetadata">;
  userAgentsStore?: UserAgentsStore;
}) {
  const app = new Hono();
  const { connectionManager, chatInstanceManager, agentConfigStore } = deps;
  const verifyToken = createTokenVerifier({
    userAgentsStore: deps.userAgentsStore,
    agentMetadataStore: deps.agentConfigStore,
  });

  async function getAuthorizedAgentId(c: Context): Promise<string | null> {
    const session = verifySettingsSession(c);
    if (!session) return null;
    const agentId = c.req.param("agentId") || session.agentId || null;
    if (!agentId || !isSafeAgentId(agentId)) return null;
    const verified = await verifyToken(session, agentId);
    return verified ? agentId : null;
  }

  /**
   * Resolve the first active sandbox agentId that has a running deployment.
   * When a template agent (e.g. "lobu") has no direct deployments,
   * we look at its connections' sandbox agents for a running worker.
   */
  async function resolveActiveAgent(
    agentId: string
  ): Promise<{ connected: boolean; resolvedAgentId: string }> {
    if (connectionManager.getDeploymentsForAgent(agentId).length > 0) {
      return { connected: true, resolvedAgentId: agentId };
    }

    if (chatInstanceManager && agentConfigStore) {
      try {
        const connections = await chatInstanceManager.listConnections({
          templateAgentId: agentId,
        });
        for (const conn of connections) {
          const sandboxes = await agentConfigStore.listSandboxes(conn.id);
          for (const sb of sandboxes) {
            if (
              connectionManager.getDeploymentsForAgent(sb.agentId).length > 0
            ) {
              return { connected: true, resolvedAgentId: sb.agentId };
            }
          }
        }
      } catch (e) {
        logger.debug("Failed to resolve sandbox agents", { error: e });
      }
    }

    return { connected: false, resolvedAgentId: agentId };
  }

  /**
   * Try proxying to worker HTTP server, fall back to direct file read.
   */
  async function proxyOrFallback<T>(
    agentId: string,
    workerPath: string,
    fallback: (agentId: string) => Promise<T>
  ): Promise<{ data: T; proxied: boolean } | null> {
    const { resolvedAgentId } = await resolveActiveAgent(agentId);
    const httpUrl = connectionManager.getHttpUrl(resolvedAgentId);

    if (httpUrl) {
      try {
        const response = await fetch(`${httpUrl}${workerPath}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return { data: (await response.json()) as T, proxied: true };
        }
      } catch {
        // Worker HTTP not reachable, fall through to file read
      }
    }

    // Fallback: read session file directly
    try {
      return { data: await fallback(resolvedAgentId), proxied: false };
    } catch (e) {
      logger.debug("Session file fallback failed", {
        error: e,
        agentId: resolvedAgentId,
      });
      return null;
    }
  }

  // Agent status
  app.get("/status", async (c) => {
    const agentId = await getAuthorizedAgentId(c);
    if (!agentId) return errorResponse(c, "Unauthorized", 401);

    const { connected, resolvedAgentId } = await resolveActiveAgent(agentId);

    // Even if worker HTTP is unreachable, check if session file exists on disk
    const hasSessionFile = !!(await findSessionFile(resolvedAgentId));

    return c.json({
      connected: connected || hasSessionFile,
      hasHttpServer: !!connectionManager.getHttpUrl(resolvedAgentId),
      deploymentCount:
        connectionManager.getDeploymentsForAgent(resolvedAgentId).length,
    });
  });

  // Session messages
  app.get("/session/messages", async (c) => {
    const agentId = await getAuthorizedAgentId(c);
    if (!agentId) return errorResponse(c, "Unauthorized", 401);

    const cursor = c.req.query("cursor") || "";
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);

    const result = await proxyOrFallback(
      agentId,
      `/session/messages?cursor=${cursor}&limit=${limit}`,
      (resolved) => readSessionMessages(resolved, cursor, limit)
    );

    if (!result) {
      return c.json(
        {
          error: "Agent offline",
          connected: false,
          messages: [],
          nextCursor: null,
          hasMore: false,
        },
        503
      );
    }

    return c.json(result.data);
  });

  // Session stats
  app.get("/session/stats", async (c) => {
    const agentId = await getAuthorizedAgentId(c);
    if (!agentId) return errorResponse(c, "Unauthorized", 401);

    const result = await proxyOrFallback(
      agentId,
      "/session/stats",
      readSessionStats
    );

    if (!result) {
      return c.json({ error: "Agent offline", connected: false }, 503);
    }

    return c.json(result.data);
  });

  return app;
}
