/**
 * File handler interface for platform-specific file operations.
 *
 * Inbound files are NOT handled here — `MessageHandlerBridge` fetches each
 * inbound attachment via the chat SDK's `Attachment.fetchData()`, publishes
 * it as a gateway artifact, and forwards a signed download URL on
 * `platformMetadata.files[].downloadUrl`. This interface only exists for
 * outbound uploads where the platform's native file API is preferred (e.g.
 * Slack `files.uploadV2`, Telegram `sendDocument`).
 */

import type { Readable } from "node:stream";

export interface FileUploadResult {
  fileId: string;
  permalink: string;
  name: string;
  size: number;
  delivery?: "platform-upload" | "artifact-url";
  artifactId?: string;
}

export interface FileUploadOptions {
  filename: string;
  channelId: string;
  threadTs?: string;
  title?: string;
  initialComment?: string;
  sessionKey?: string;
  /** Send as voice message (ptt) on platforms that support it */
  voiceMessage?: boolean;
}

export interface IFileHandler {
  uploadFile(
    fileStream: Readable,
    options: FileUploadOptions
  ): Promise<FileUploadResult>;
}
