/**
 * Slack file handler implementation.
 */

import { Readable } from "node:stream";
import { createLogger, sanitizeFilename } from "@peerbot/core";
import type { WebClient } from "@slack/web-api";
import jwt from "jsonwebtoken";
import type {
  FileMetadata,
  FileUploadOptions,
  FileUploadResult,
  IFileHandler,
} from "../platform/file-handler";

const logger = createLogger("slack-file-handler");

function getJwtSecret(): string {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("ENCRYPTION_KEY required for file token generation");
  }
  return secret;
}

interface SlackFileMetadata extends FileMetadata {
  url_private: string;
  url_private_download: string;
}

export class SlackFileHandler implements IFileHandler {
  private uploadedFiles = new Map<string, Set<string>>();

  constructor(private slackClient: WebClient) {}

  async downloadFile(
    fileId: string,
    bearerToken: string
  ): Promise<{ stream: Readable; metadata: FileMetadata }> {
    const fileInfo = await this.slackClient.files.info({ file: fileId });

    if (!fileInfo.ok || !fileInfo.file) {
      throw new Error(`Failed to get file info: ${fileInfo.error}`);
    }

    const file = fileInfo.file as any;
    const metadata: SlackFileMetadata = {
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      size: file.size,
      url: file.url_private,
      url_private: file.url_private,
      url_private_download: file.url_private_download,
      downloadUrl: file.url_private_download,
      permalink: file.permalink,
      timestamp: file.timestamp,
    };

    const response = await fetch(metadata.url_private_download, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    return {
      stream: Readable.fromWeb(response.body as any),
      metadata,
    };
  }

  async uploadFile(
    fileStream: Readable,
    options: FileUploadOptions
  ): Promise<FileUploadResult> {
    const safeFilename = sanitizeFilename(options.filename);

    const chunks: Buffer[] = [];
    for await (const chunk of fileStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const fileBuffer = Buffer.concat(chunks);

    logger.info(
      `Uploading ${safeFilename} (${fileBuffer.length} bytes) to ${options.channelId}`
    );

    const uploadParams: any = {
      channel_id: options.channelId,
      filename: safeFilename,
      file: fileBuffer,
      title: options.title || safeFilename,
      ...(options.threadTs && { thread_ts: options.threadTs }),
      ...(options.initialComment && {
        initial_comment: options.initialComment,
      }),
    };

    const result = await this.slackClient.files.uploadV2(uploadParams);

    if (!result.ok) {
      throw new Error(`Failed to upload file: ${result.error}`);
    }

    const files = (result as any).files;
    if (!files?.length) {
      throw new Error("Upload succeeded but no file info returned");
    }

    const file = files[0];

    if (options.sessionKey) {
      if (!this.uploadedFiles.has(options.sessionKey)) {
        this.uploadedFiles.set(options.sessionKey, new Set());
      }
      this.uploadedFiles.get(options.sessionKey)!.add(file.id);
    }

    return {
      fileId: file.id,
      permalink: file.permalink || file.url_private,
      name: file.name,
      size: file.size || fileBuffer.length,
    };
  }

  getSessionFiles(sessionKey: string): string[] {
    return Array.from(this.uploadedFiles.get(sessionKey) || []);
  }

  cleanupSession(sessionKey: string): void {
    this.uploadedFiles.delete(sessionKey);
  }

  generateFileToken(
    sessionKey: string,
    fileId: string,
    expiresIn = 3600
  ): string {
    const jwtSecret = getJwtSecret();
    return jwt.sign(
      {
        sessionKey,
        fileId,
        type: "file_access",
        iat: Math.floor(Date.now() / 1000),
      },
      jwtSecret,
      {
        expiresIn,
        algorithm: "HS256",
        issuer: "peerbot-gateway",
        audience: "peerbot-worker",
      }
    );
  }

  validateFileToken(token: string): {
    valid: boolean;
    sessionKey?: string;
    fileId?: string;
    error?: string;
  } {
    try {
      const jwtSecret = getJwtSecret();
      const decoded = jwt.verify(token, jwtSecret, {
        algorithms: ["HS256"],
        issuer: "peerbot-gateway",
        audience: "peerbot-worker",
      });

      if (
        typeof decoded === "string" ||
        typeof decoded.sessionKey !== "string" ||
        typeof decoded.fileId !== "string" ||
        decoded.type !== "file_access"
      ) {
        return { valid: false, error: "Invalid token structure" };
      }

      return {
        valid: true,
        sessionKey: decoded.sessionKey,
        fileId: decoded.fileId,
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return { valid: false, error: "Token expired" };
      }
      return { valid: false, error: "Invalid token" };
    }
  }
}
