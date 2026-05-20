/**
 * Agent history routes — proxy session data from worker HTTP server,
 * with direct session-file fallback for embedded dev mode.
 * Auth: settings session cookie (verifySettingsSession).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfigStore, ParsedMessage } from "@lobu/core";
import {
  createLogger,
  entryToMessage,
  parseSessionEntries,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import { getDb } from "../../../db/client.js";
import type { WorkerConnectionManager } from "../../gateway/connection-manager.js";
import { errorResponse } from "../shared/helpers.js";
import { createOwnershipResolver } from "../shared/agent-ownership.js";
import { verifySettingsSession } from "./settings-auth.js";

/**
 * Read the latest completed transcript snapshot for an agent's most-recent
 * conversation. Returns the raw JSONL content + sessionId-equivalent, or
 * null when no snapshot exists.
 *
 * The `organizationId` MUST be the authorised org id resolved by the caller
 * (typically via `verifyOwnedAgentAccess` → `AgentOwnershipResult.
 * organizationId`). Agents are keyed `(organization_id, id)` — the SAME
 * agentId can exist across orgs — so a prior version that resolved org
 * from agentId alone could serve a different org's bytes to a wrongly-
 * cookied session. Codex P2 on PR #865, same shape as PR #836's tenant-
 * isolation findings.
 *
 * Returns null when:
 *   - `organizationId` is empty / undefined (no scope to query under)
 *   - no completed snapshot exists for `(org, agent)`
 *
 * Only fires when snapshot mode is active (the default in Phase 5+).
 * LOBU_SESSION_STORE=file opts out and keeps reading workspaces/*
 * untouched for legacy/local-dev single-replica deploys.
 */
export async function readLatestSnapshotJsonl(
  agentId: string,
  organizationId: string | undefined
): Promise<string | null> {
  if (!organizationId) return null;
  const sql = getDb();
  const snapshotRows = await sql<{ snapshot_jsonl: string }>`
    SELECT snapshot_jsonl
    FROM public.agent_transcript_snapshot
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND terminal_status = 'completed'
    ORDER BY run_id DESC
    LIMIT 1
  `;
  return snapshotRows[0]?.snapshot_jsonl ?? null;
}

const logger = createLogger("agent-history-routes");

/** Alphanumeric, hyphens, and underscores only — no path separators or dots. */
const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]+$/;

function isSafeAgentId(id: string): boolean {
  return SAFE_AGENT_ID.test(id);
}

// ─── Direct session file reader (fallback) ─────────────────────────────────
//
// `SessionEntry`, `ParsedMessage`, `parseSessionEntries`, and `entryToMessage`
// are exported from `@lobu/core` so the worker's `/session/messages`
// route (`packages/agent-worker/src/server.ts`) and this gateway-side
// fallback can't drift again. `findSessionFile` stays here because the
// path-policy differs from the worker's — gateway scans
// `workspaces/<agentId>` up to three levels deep with a SAFE_AGENT_ID
// guard; the worker scans its own `WORKSPACE_DIR` one level deep.

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

async function readSessionMessages(
  agentId: string,
  cursorParam: string,
  limit: number,
  organizationId: string | undefined
) {
  // In snapshot mode (the Phase 5 default), the disk file may be empty
  // (a fresh pod has no workspaces/ tree on a multi-replica gateway).
  // Try the PG snapshot first; fall through to the disk read if the
  // snapshot is missing so local-dev workspaces/* trees keep working
  // without DB migrations. LOBU_SESSION_STORE=file opts back to disk-only.
  let content: string | null = null;
  if (process.env.LOBU_SESSION_STORE !== "file") {
    content = await readLatestSnapshotJsonl(agentId, organizationId);
  }
  if (content === null) {
    const sessionPath = await findSessionFile(agentId);
    if (!sessionPath) {
      return {
        messages: [],
        nextCursor: null,
        hasMore: false,
        sessionId: "none",
      };
    }
    content = await readFile(sessionPath, "utf-8");
  }
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

async function readSessionStats(
  agentId: string,
  organizationId: string | undefined
) {
  // Same fallback shape as readSessionMessages — DB first in snapshot mode
  // (Phase 5 default), disk read if absent. LOBU_SESSION_STORE=file opts out.
  let content: string | null = null;
  if (process.env.LOBU_SESSION_STORE !== "file") {
    content = await readLatestSnapshotJsonl(agentId, organizationId);
  }
  if (content === null) {
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
    content = await readFile(sessionPath, "utf-8");
  }
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
  agentConfigStore?: Pick<AgentConfigStore, "getMetadata">;
  userAgentsStore?: UserAgentsStore;
}) {
  const app = new Hono();
  const { connectionManager } = deps;
  const resolveOwnership = createOwnershipResolver({
    userAgentsStore: deps.userAgentsStore,
    agentMetadataStore: deps.agentConfigStore,
  });

  /**
   * Returns the agentId AND the authorised organizationId so the snapshot
   * fallback (which queries by `(org, agent)`) cannot cross tenants. agents
   * is keyed (organization_id, id) — different orgs can share an agentId —
   * so the agent-id alone is not a tenant boundary. Codex P2 on PR #865.
   */
  async function getAuthorizedAgentScope(
    c: Context
  ): Promise<{ agentId: string; organizationId: string | undefined } | null> {
    const session = await verifySettingsSession(c);
    if (!session) return null;
    const agentId = c.req.param("agentId") || session.agentId || null;
    if (!agentId || !isSafeAgentId(agentId)) return null;
    const result = await resolveOwnership(session, agentId);
    if (!result.authorized) return null;
    return { agentId, organizationId: result.organizationId };
  }

  /**
   * Resolve whether a deployment for `agentId` is currently running.
   * No more sandbox fallback — one agent row maps directly to its worker
   * deployment (or no worker at all).
   */
  async function resolveActiveAgent(
    agentId: string
  ): Promise<{ connected: boolean; resolvedAgentId: string }> {
    if (connectionManager.getDeploymentsForAgent(agentId).length > 0) {
      return { connected: true, resolvedAgentId: agentId };
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
    const scope = await getAuthorizedAgentScope(c);
    if (!scope) return errorResponse(c, "Unauthorized", 401);

    const { connected, resolvedAgentId } = await resolveActiveAgent(
      scope.agentId
    );

    // Even if worker HTTP is unreachable, check if session content exists.
    // Same fallback shape as readSessionMessages: snapshot first, disk
    // second. Avoids reporting `connected: false` when the worker is dead
    // but a PG snapshot is recoverable.
    let hasSessionFile = false;
    if (process.env.LOBU_SESSION_STORE !== "file") {
      hasSessionFile =
        (await readLatestSnapshotJsonl(
          resolvedAgentId,
          scope.organizationId
        )) !== null;
    }
    if (!hasSessionFile) {
      hasSessionFile = !!(await findSessionFile(resolvedAgentId));
    }

    return c.json({
      connected: connected || hasSessionFile,
      hasHttpServer: !!connectionManager.getHttpUrl(resolvedAgentId),
      deploymentCount:
        connectionManager.getDeploymentsForAgent(resolvedAgentId).length,
    });
  });

  // Session messages
  app.get("/session/messages", async (c) => {
    const scope = await getAuthorizedAgentScope(c);
    if (!scope) return errorResponse(c, "Unauthorized", 401);

    const cursor = c.req.query("cursor") || "";
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);

    const result = await proxyOrFallback(
      scope.agentId,
      `/session/messages?cursor=${cursor}&limit=${limit}`,
      (resolved) =>
        readSessionMessages(resolved, cursor, limit, scope.organizationId)
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
    const scope = await getAuthorizedAgentScope(c);
    if (!scope) return errorResponse(c, "Unauthorized", 401);

    const result = await proxyOrFallback(
      scope.agentId,
      "/session/stats",
      (resolved) => readSessionStats(resolved, scope.organizationId)
    );

    if (!result) {
      return c.json({ error: "Agent offline", connected: false }, 503);
    }

    return c.json(result.data);
  });

  return app;
}
