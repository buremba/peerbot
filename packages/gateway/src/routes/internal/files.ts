#!/usr/bin/env bun

import { Readable } from "node:stream";
import { createLogger, verifyWorkerToken } from "@peerbot/core";
import { Hono } from "hono";
import type { IFileHandler } from "../../platform/file-handler";
import type { ISessionManager } from "../../session";

const logger = createLogger("file-routes");

type WorkerContext = {
  Variables: {
    worker: any;
  };
};

/**
 * Create internal file routes (Hono)
 */
export function createFileRoutes(
  fileHandler: IFileHandler,
  _sessionManager: ISessionManager
): Hono<WorkerContext> {
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
   * Download file endpoint for workers
   * GET /download?fileId=xxx
   */
  router.get("/download", authenticateWorker, async (c) => {
    try {
      const fileId = c.req.query("fileId");
      const worker = c.get("worker");

      if (!fileId) {
        return c.json({ error: "Missing fileId parameter" }, 400);
      }

      logger.info(
        `Worker downloading file ${fileId} for thread ${worker.threadId}`
      );

      const slackToken = process.env.SLACK_BOT_TOKEN;
      if (!slackToken) {
        return c.json({ error: "Slack token not configured" }, 500);
      }

      const { stream, metadata } = await fileHandler.downloadFile(
        fileId,
        slackToken
      );

      c.header("Content-Type", metadata.mimetype || "application/octet-stream");
      c.header("Content-Length", metadata.size.toString());
      c.header(
        "Content-Disposition",
        `attachment; filename="${metadata.name}"`
      );

      // Convert Node stream to web stream
      const webStream = new ReadableStream({
        start(controller) {
          stream.on("data", (chunk: Buffer) => controller.enqueue(chunk));
          stream.on("end", () => controller.close());
          stream.on("error", (err: Error) => controller.error(err));
        },
      });

      return new Response(webStream, {
        headers: c.res.headers,
      });
    } catch (error) {
      logger.error("Failed to download file:", error);
      return c.json({ error: "Failed to download file" }, 500);
    }
  });

  /**
   * Upload file endpoint for workers
   * POST /upload
   */
  router.post("/upload", authenticateWorker, async (c) => {
    try {
      const worker = c.get("worker");
      const channelId = c.req.header("x-channel-id");
      const threadId = c.req.header("x-thread-id");

      if (!channelId || !threadId) {
        return c.json({ error: "Missing channel or thread ID" }, 400);
      }

      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;

      if (!file) {
        return c.json({ error: "No file provided" }, 400);
      }

      const filename = (formData.get("filename") as string) || file.name;
      const initialComment = formData.get("comment") as string | null;

      logger.info(
        `Worker uploading file ${filename} for thread ${worker.threadId} to Slack thread ${threadId}`
      );

      const arrayBuffer = await file.arrayBuffer();
      const fileStream = Readable.from(Buffer.from(arrayBuffer));

      const result = await fileHandler.uploadFile(fileStream, {
        filename,
        channelId,
        threadTs: threadId,
        initialComment: initialComment || undefined,
      });

      logger.info(`File uploaded successfully: ${result.fileId}`);

      return c.json({
        success: true,
        fileId: result.fileId,
        permalink: result.permalink,
        name: result.name,
        size: result.size,
      });
    } catch (error) {
      logger.error("Failed to upload file:", error);
      return c.json({ error: "Failed to upload file" }, 500);
    }
  });

  /**
   * Batch upload endpoint for multiple files
   * POST /upload-batch
   */
  router.post("/upload-batch", authenticateWorker, async (c) => {
    try {
      const worker = c.get("worker");
      const channelId = c.req.header("x-channel-id");
      const threadId = c.req.header("x-thread-id");

      if (!channelId || !threadId) {
        return c.json({ error: "Missing channel or thread ID" }, 400);
      }

      const formData = await c.req.formData();
      const fileEntries = formData.getAll("files");

      if (!fileEntries || fileEntries.length === 0) {
        return c.json({ error: "No files provided" }, 400);
      }

      logger.info(
        `Worker uploading ${fileEntries.length} files for thread ${worker.threadId}`
      );

      const uploadPromises = fileEntries.map(async (entry, index) => {
        if (!(entry instanceof File)) {
          throw new Error(`Entry ${index} is not a file`);
        }

        const filename = entry.name;
        const arrayBuffer = await entry.arrayBuffer();
        const fileStream = Readable.from(Buffer.from(arrayBuffer));

        return fileHandler.uploadFile(fileStream, {
          filename,
          channelId,
          threadTs: threadId,
        });
      });

      const uploadResults = await Promise.allSettled(uploadPromises);

      const results = uploadResults.map((result, index) => {
        if (result.status === "fulfilled") {
          return { success: true, ...result.value };
        } else {
          logger.error(`Failed to upload file ${index}:`, result.reason);
          return {
            success: false,
            error: result.reason?.message || "Upload failed",
          };
        }
      });

      return c.json({ results });
    } catch (error) {
      logger.error("Failed to batch upload files:", error);
      return c.json({ error: "Failed to batch upload files" }, 500);
    }
  });

  return router;
}
