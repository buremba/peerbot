#!/usr/bin/env bun

import { Readable } from "node:stream";
import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { ArtifactStore } from "../../files/artifact-store";
import type { PlatformRegistry } from "../../platform";
import type { IFileHandler } from "../../platform/file-handler";
import { errorResponse, getVerifiedWorker } from "../shared/helpers";
import { authenticateWorker } from "./middleware";
import type { WorkerContext } from "./types";

const logger = createLogger("file-routes");

/**
 * Resolve the file handler for a given platform from the registry.
 */
function resolveFileHandler(
  platformRegistry: PlatformRegistry,
  options: {
    platformName?: string;
    connectionId?: string;
    channelId?: string;
    conversationId?: string;
    teamId?: string;
  }
): IFileHandler | null {
  if (!options.platformName) return null;
  const platform = platformRegistry.get(options.platformName);
  return (
    platform?.getFileHandler?.({
      connectionId: options.connectionId,
      channelId: options.channelId,
      conversationId: options.conversationId,
      teamId: options.teamId,
    }) ?? null
  );
}

/**
 * Create internal file routes (Hono)
 */
export function createFileRoutes(
  platformRegistry: PlatformRegistry,
  artifactStore: ArtifactStore,
  publicGatewayUrl: string
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  // Worker file downloads are no longer routed through the gateway with a
  // platform-specific fileId. Inbound attachments are pre-published as
  // gateway artifacts in `MessageHandlerBridge.ingestAttachments` and the
  // worker fetches them directly via the signed `/api/v1/files/:artifactId`
  // public URL embedded in `platformMetadata.files[].downloadUrl`.

  /**
   * Upload file endpoint for workers
   * POST /upload
   */
  router.post("/upload", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const channelId = c.req.header("x-channel-id");
      const conversationId = c.req.header("x-conversation-id");
      const voiceMessage = c.req.header("x-voice-message") === "true";

      if (!channelId || !conversationId) {
        return errorResponse(c, "Missing channel or conversation ID", 400);
      }

      const fileHandler = resolveFileHandler(platformRegistry, {
        platformName: worker.platform,
        connectionId: worker.connectionId,
        channelId,
        conversationId,
        teamId: worker.teamId,
      });

      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;

      if (!file) {
        return errorResponse(c, "No file provided", 400);
      }

      const filename = (formData.get("filename") as string) || file.name;
      const initialComment = formData.get("comment") as string | null;

      logger.info(
        `Worker uploading file ${filename} via ${worker.platform || "unknown"} for conversation ${worker.conversationId} to conversation ${conversationId}${voiceMessage ? " as voice message" : ""}`
      );

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      let result:
        | {
            fileId: string;
            permalink: string;
            name: string;
            size: number;
            delivery?: "platform-upload" | "artifact-url";
            artifactId?: string;
          }
        | undefined;

      if (fileHandler) {
        try {
          result = await fileHandler.uploadFile(Readable.from(fileBuffer), {
            filename,
            channelId,
            threadTs: conversationId,
            initialComment: initialComment || undefined,
            voiceMessage,
          });
          logger.info(`File uploaded successfully: ${result.fileId}`);
        } catch (error) {
          logger.warn(
            `Platform upload failed for ${filename}; falling back to artifact URL`,
            error
          );
        }
      }

      if (!result) {
        const artifact = await artifactStore.publish({
          buffer: fileBuffer,
          filename,
          contentType: file.type || "application/octet-stream",
          publicGatewayUrl,
        });
        result = {
          fileId: artifact.artifactId,
          permalink: artifact.downloadUrl,
          name: artifact.filename,
          size: artifact.size,
          delivery: "artifact-url",
          artifactId: artifact.artifactId,
        };
        logger.info(`Published artifact fallback: ${artifact.artifactId}`);
      }

      return c.json({
        success: true,
        fileId: result.fileId,
        permalink: result.permalink,
        name: result.name,
        size: result.size,
        delivery: result.delivery || "platform-upload",
        artifactId: result.artifactId,
      });
    } catch (error) {
      logger.error("Failed to upload file:", error);
      return errorResponse(c, "Failed to upload file", 500);
    }
  });

  /**
   * Batch upload endpoint for multiple files
   * POST /upload-batch
   */
  router.post("/upload-batch", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const channelId = c.req.header("x-channel-id");
      const conversationId = c.req.header("x-conversation-id");

      if (!channelId || !conversationId) {
        return errorResponse(c, "Missing channel or conversation ID", 400);
      }

      const fileHandler = resolveFileHandler(platformRegistry, {
        platformName: worker.platform,
        connectionId: worker.connectionId,
        channelId,
        conversationId,
        teamId: worker.teamId,
      });

      const formData = await c.req.formData();
      const fileEntries = formData.getAll("files");

      if (!fileEntries || fileEntries.length === 0) {
        return errorResponse(c, "No files provided", 400);
      }

      logger.info(
        `Worker uploading ${fileEntries.length} files for conversation ${worker.conversationId}`
      );

      const uploadPromises = fileEntries.map(async (entry, index) => {
        if (!(entry instanceof File)) {
          throw new Error(`Entry ${index} is not a file`);
        }

        const filename = entry.name;
        const fileBuffer = Buffer.from(await entry.arrayBuffer());

        if (fileHandler) {
          try {
            return await fileHandler.uploadFile(Readable.from(fileBuffer), {
              filename,
              channelId,
              threadTs: conversationId,
            });
          } catch (error) {
            logger.warn(
              `Platform batch upload failed for ${filename}; falling back to artifact URL`,
              error
            );
          }
        }

        const artifact = await artifactStore.publish({
          buffer: fileBuffer,
          filename,
          contentType: entry.type || "application/octet-stream",
          publicGatewayUrl,
        });
        return {
          fileId: artifact.artifactId,
          permalink: artifact.downloadUrl,
          name: artifact.filename,
          size: artifact.size,
          delivery: "artifact-url" as const,
          artifactId: artifact.artifactId,
        };
      });

      const uploadResults = await Promise.allSettled(uploadPromises);

      const results = uploadResults.map((result, index) => {
        if (result.status === "fulfilled") {
          return {
            success: true,
            delivery: result.value.delivery || "platform-upload",
            ...result.value,
          };
        }
        logger.error(`Failed to upload file ${index}:`, result.reason);
        return {
          success: false,
          error: result.reason?.message || "Upload failed",
        };
      });

      return c.json({ results });
    } catch (error) {
      logger.error("Failed to batch upload files:", error);
      return errorResponse(c, "Failed to batch upload files", 500);
    }
  });

  return router;
}
