#!/usr/bin/env bun

import { Readable } from "node:stream";
import { createLogger, getErrorMessage } from "@lobu/core";
import { Hono } from "hono";
import type { ArtifactStore } from "../../files/artifact-store.js";
import type { IFileHandler } from "../../platform/file-handler.js";
import type { PlatformRegistry } from "../../platform.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { captureSideEffect } from "./capture-mode.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

const logger = createLogger("file-routes");
const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BATCH_FILES = 10;
const MAX_UPLOAD_BATCH_BYTES = 100 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

class UploadBodyTooLargeError extends Error {}

function declaredBodyTooLarge(
  c: { req: { header(name: string): string | undefined } },
  maxBytes: number,
): boolean {
  const raw = c.req.header("content-length");
  if (!raw) return false;
  const length = Number(raw);
  return (
    Number.isFinite(length) && length > maxBytes + MULTIPART_OVERHEAD_BYTES
  );
}

async function parseBoundedMultipartFormData(
  request: Request,
  maxFileBytes: number,
): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType) return new FormData();
  const reader = request.body?.getReader();
  if (!reader) return new FormData();
  const maxBodyBytes = maxFileBytes + MULTIPART_OVERHEAD_BYTES;
  let totalBytes = 0;
  const boundedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (!value) return;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        controller.error(new UploadBodyTooLargeError());
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(boundedBody, {
    headers: { "content-type": contentType },
  }).formData();
}

/**
 * Resolve the file handler for a given platform from the registry.
 * Connections hydrate lazily per replica, and the pod that claims a worker's
 * run is routinely not the pod that received the inbound webhook — so warm
 * the connection from its row first, otherwise `getFileHandler` (a
 * synchronous instance lookup) misses and every upload falls back to an
 * artifact URL instead of a native platform upload.
 */
async function resolveFileHandler(
  platformRegistry: PlatformRegistry,
  options: {
    platformName?: string;
    connectionId?: string;
    channelId?: string;
    conversationId?: string;
    teamId?: string;
  },
): Promise<IFileHandler | null> {
  if (!options.platformName) return null;
  const platform = platformRegistry.get(options.platformName);
  if (!platform) return null;
  if (options.connectionId && platform.warmConnection) {
    try {
      await platform.warmConnection(options.connectionId);
    } catch (error) {
      logger.warn(
        { connectionId: options.connectionId, error: String(error) },
        "Failed to warm connection for file handler; falling back",
      );
    }
  }
  return (
    platform.getFileHandler?.({
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
  publicGatewayUrl: string,
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
      if (declaredBodyTooLarge(c, MAX_UPLOAD_FILE_BYTES)) {
        return errorResponse(c, "File exceeds maximum size of 50MB", 413);
      }
      const worker = getVerifiedWorker(c);
      // SECURITY: the channel/conversation a worker may upload to is fixed by
      // its verified token, NOT by request headers. Trusting the X-Channel-Id /
      // X-Conversation-Id headers let a worker (or anyone holding a worker
      // token) deliver attachments to ANY channel the connection's bot can
      // reach — cross-channel/cross-conversation disclosure. Mirror the history
      // route, which is token-bound for exactly this reason. Only the voice-
      // message flag stays caller-controlled (it's not a routing decision).
      const channelId = worker.channelId;
      const conversationId = worker.conversationId;
      const voiceMessage = c.req.header("x-voice-message") === "true";

      if (!channelId || !conversationId) {
        return errorResponse(c, "Missing channel or conversation ID", 400);
      }

      const fileHandler = await resolveFileHandler(platformRegistry, {
        platformName: worker.platform,
        connectionId: worker.connectionId,
        channelId,
        conversationId,
        teamId: worker.teamId,
      });

      let formData: FormData;
      try {
        formData = await parseBoundedMultipartFormData(
          c.req.raw,
          MAX_UPLOAD_FILE_BYTES,
        );
      } catch (error) {
        if (error instanceof UploadBodyTooLargeError) {
          return errorResponse(c, "File exceeds maximum size of 50MB", 413);
        }
        throw error;
      }
      const file = formData.get("file") as File | null;

      if (!file) {
        return errorResponse(c, "No file provided", 400);
      }
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        return errorResponse(c, "File exceeds maximum size of 50MB", 413);
      }

      const filename = (formData.get("filename") as string) || file.name;
      const initialComment = formData.get("comment") as string | null;

      // Delivery into the conversation is a side effect: the media plugins
      // generate content and then land it here, so this is where a capture
      // run's attachment attempt is recorded instead of delivered. Callers
      // only require a 2xx (`upload.response.ok`), so the generic body works.
      const captured = await captureSideEffect(c, "files.upload", {
        filename,
        mimeType: file.type || null,
        size: file.size,
        voiceMessage,
      });
      if (captured) return captured;

      logger.info(
        `Worker uploading file ${filename} via ${worker.platform || "unknown"} for conversation ${worker.conversationId} to conversation ${conversationId}${voiceMessage ? " as voice message" : ""}`,
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
            error,
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
      logger.error("Failed to upload file", {
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return errorResponse(c, "Failed to upload file", 500);
    }
  });

  /**
   * Batch upload endpoint for multiple files
   * POST /upload-batch
   */
  router.post("/upload-batch", authenticateWorker, async (c) => {
    try {
      if (declaredBodyTooLarge(c, MAX_UPLOAD_BATCH_BYTES)) {
        return errorResponse(
          c,
          "Upload batch exceeds maximum size of 100MB",
          413,
        );
      }
      const worker = getVerifiedWorker(c);
      // SECURITY: token-bound channel/conversation (see /upload above) — never
      // the X-Channel-Id / X-Conversation-Id headers, which a worker could
      // override to deliver attachments to an arbitrary channel.
      const channelId = worker.channelId;
      const conversationId = worker.conversationId;

      if (!channelId || !conversationId) {
        return errorResponse(c, "Missing channel or conversation ID", 400);
      }

      const fileHandler = await resolveFileHandler(platformRegistry, {
        platformName: worker.platform,
        connectionId: worker.connectionId,
        channelId,
        conversationId,
        teamId: worker.teamId,
      });

      let formData: FormData;
      try {
        formData = await parseBoundedMultipartFormData(
          c.req.raw,
          MAX_UPLOAD_BATCH_BYTES,
        );
      } catch (error) {
        if (error instanceof UploadBodyTooLargeError) {
          return errorResponse(
            c,
            "Upload batch exceeds maximum size of 100MB",
            413,
          );
        }
        throw error;
      }
      const fileEntries = formData.getAll("files");

      if (!fileEntries || fileEntries.length === 0) {
        return errorResponse(c, "No files provided", 400);
      }
      if (fileEntries.length > MAX_UPLOAD_BATCH_FILES) {
        return errorResponse(c, "Too many files (maximum 10)", 413);
      }
      const files: File[] = [];
      let totalBytes = 0;
      for (const [index, entry] of fileEntries.entries()) {
        if (!(entry instanceof File)) {
          return errorResponse(c, `Entry ${index} is not a file`, 400);
        }
        if (entry.size > MAX_UPLOAD_FILE_BYTES) {
          return errorResponse(
            c,
            `File ${index} exceeds maximum size of 50MB`,
            413,
          );
        }
        totalBytes += entry.size;
        if (totalBytes > MAX_UPLOAD_BATCH_BYTES) {
          return errorResponse(
            c,
            "Upload batch exceeds maximum size of 100MB",
            413,
          );
        }
        files.push(entry);
      }

      const captured = await captureSideEffect(c, "files.upload_batch", {
        count: files.length,
        filenames: files.map((entry) => entry.name),
      });
      if (captured) return captured;

      logger.info(
        `Worker uploading ${files.length} files for conversation ${worker.conversationId}`,
      );

      const uploadResults: PromiseSettledResult<{
        fileId: string;
        permalink: string;
        name: string;
        size: number;
        delivery?: "platform-upload" | "artifact-url";
        artifactId?: string;
      }>[] = [];
      // Read one bounded blob at a time. Promise.all over ten 50 MiB files
      // creates a preventable half-gigabyte allocation spike.
      for (const entry of files) {
        try {
          const filename = entry.name;
          const fileBuffer = Buffer.from(await entry.arrayBuffer());
          let result;
          if (fileHandler) {
            try {
              result = await fileHandler.uploadFile(Readable.from(fileBuffer), {
                filename,
                channelId,
                threadTs: conversationId,
              });
            } catch (error) {
              logger.warn(
                `Platform batch upload failed for ${filename}; falling back to artifact URL`,
                error,
              );
            }
          }
          if (!result) {
            const artifact = await artifactStore.publish({
              buffer: fileBuffer,
              filename,
              contentType: entry.type || "application/octet-stream",
              publicGatewayUrl,
            });
            result = {
              fileId: artifact.artifactId,
              permalink: artifact.downloadUrl,
              name: artifact.filename,
              size: artifact.size,
              delivery: "artifact-url" as const,
              artifactId: artifact.artifactId,
            };
          }
          uploadResults.push({ status: "fulfilled", value: result });
        } catch (reason) {
          uploadResults.push({ status: "rejected", reason });
        }
      }

      const results = uploadResults.map((result, index) => {
        if (result.status === "fulfilled") {
          return {
            success: true,
            delivery: result.value.delivery || "platform-upload",
            ...result.value,
          };
        }
        logger.error(`Failed to upload file ${index}`, {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          stack:
            result.reason instanceof Error ? result.reason.stack : undefined,
        });
        return {
          success: false,
          error: result.reason?.message || "Upload failed",
        };
      });

      return c.json({ results });
    } catch (error) {
      logger.error("Failed to batch upload files", {
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return errorResponse(c, "Failed to batch upload files", 500);
    }
  });

  return router;
}
