/**
 * Worker HTTP server for serving session data and health checks.
 * Lightweight Hono server started before SSE gateway connection.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import {
  createLogger,
  entryToMessage,
  getOptionalEnv,
  getOptionalNumber,
  type ParsedMessage,
  parseSessionEntries,
} from "@lobu/core";
import { Hono } from "hono";

const logger = createLogger("worker-http");

const app = new Hono();

/**
 * Locate a `.openclaw/session.jsonl` under the worker's own `WORKSPACE_DIR`.
 *
 * Different from the gateway-side `findSessionFile` (in
 * `packages/server/src/gateway/routes/public/agent-history.ts`) on purpose
 * — the worker's tree is single-agent, anchored at `WORKSPACE_DIR`, and
 * only one level deep; the gateway scans up to three levels under
 * `workspaces/<agentId>` with a `SAFE_AGENT_ID` regex guard. Path-policy
 * stays per-caller.
 */
async function findSessionFile(): Promise<string | null> {
  const workspaceDir = getOptionalEnv("WORKSPACE_DIR", "/workspace");

  // Direct path: {WORKSPACE_DIR}/.openclaw/session.jsonl
  const directPath = join(workspaceDir, ".openclaw", "session.jsonl");
  try {
    await stat(directPath);
    return directPath;
  } catch {
    // Not found, search subdirectories
  }

  // Search one level deep: {WORKSPACE_DIR}/{subdir}/.openclaw/session.jsonl
  try {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const subPath = join(
          workspaceDir,
          entry.name,
          ".openclaw",
          "session.jsonl"
        );
        try {
          await stat(subPath);
          return subPath;
        } catch {
          // Not in this subdir
        }
      }
    }
  } catch {
    // Can't read workspace dir
  }

  return null;
}

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/session/messages", async (c) => {
  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);

  try {
    const sessionPath = await findSessionFile();
    if (!sessionPath) {
      return c.json({
        messages: [],
        nextCursor: null,
        hasMore: false,
        sessionId: "none",
      });
    }
    const content = await readFile(sessionPath, "utf-8");
    const { entries, sessionId } = parseSessionEntries(content);

    // Convert all entries to messages, filtering nulls
    const allMessages: ParsedMessage[] = [];
    for (const entry of entries) {
      const msg = entryToMessage(entry);
      if (msg) allMessages.push(msg);
    }

    // Find cursor position
    let startIndex = 0;
    if (cursor) {
      const cursorIdx = allMessages.findIndex((m) => m.id === cursor);
      if (cursorIdx >= 0) {
        startIndex = cursorIdx + 1;
      }
    }

    const pageMessages = allMessages.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allMessages.length;
    const nextCursor = hasMore
      ? pageMessages[pageMessages.length - 1]?.id
      : null;

    return c.json({
      messages: pageMessages,
      nextCursor,
      hasMore,
      sessionId: sessionId || "unknown",
    });
  } catch (error: unknown) {
    const isNotFound =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) {
      return c.json({
        messages: [],
        nextCursor: null,
        hasMore: false,
        sessionId: "none",
      });
    }
    logger.error("Failed to read session file", { error });
    return c.json({ error: "Failed to read session" }, 500);
  }
});

app.get("/session/stats", async (c) => {
  try {
    const sessionPath = await findSessionFile();
    if (!sessionPath) {
      return c.json({
        sessionId: "none",
        messageCount: 0,
        userMessages: 0,
        assistantMessages: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      });
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

    return c.json({
      sessionId: sessionId || "unknown",
      messageCount,
      userMessages,
      assistantMessages,
      totalInputTokens,
      totalOutputTokens,
      currentModel,
    });
  } catch (error: unknown) {
    const isNotFound =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) {
      return c.json({
        sessionId: "none",
        messageCount: 0,
        userMessages: 0,
        assistantMessages: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      });
    }
    logger.error("Failed to read session stats", { error });
    return c.json({ error: "Failed to read session stats" }, 500);
  }
});

let server: ReturnType<typeof createServer> | null = null;

export function startWorkerHttpServer(): Promise<number> {
  // Use port 0 to let the OS assign a free port (multiple workers share the host network)
  const port = getOptionalNumber("WORKER_HTTP_PORT", 0);

  return new Promise((resolve, reject) => {
    const listener = getRequestListener(app.fetch);
    server = createServer(listener);

    server.on("error", (err) => {
      logger.error("Worker HTTP server error", { error: err });
      reject(err);
    });

    server.listen(port, () => {
      const addr = server!.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      logger.info(`Worker HTTP server listening on port ${actualPort}`);
      resolve(actualPort);
    });
  });
}

export function stopWorkerHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
