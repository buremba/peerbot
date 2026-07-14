import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "@lobu/core";
import {
  textResult,
  withErrorHandling,
  type GatewayParams,
  type TextResult,
} from "@lobu/plugin-toolkit";
import FormData from "form-data";

const logger = createLogger("plugin-media");

// ============================================================================
// Utility: Content type detection
// ============================================================================

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".json": "application/json",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

function getContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// ============================================================================
// Utility: FormData buffer serialisation
// ============================================================================

async function formDataToBuffer(formData: FormData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    formData.on("data", (chunk: string | Buffer) => {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(chunk);
      }
    });
    formData.on("end", () => resolve(Buffer.concat(chunks)));
    formData.on("error", (err: Error) => reject(err));
    formData.resume();
  });
}

// ============================================================================
// Utility: multipart upload to /internal/files/upload
// ============================================================================

/**
 * POST a pre-built `FormData` to the gateway's file-upload endpoint. Owns the
 * buffer-serialization, the worker-auth + channel/conversation headers, the
 * `Content-Length`, the abort budget, and the `TimeoutError` → discriminated
 * result mapping that both `uploadUserFile` and `uploadGeneratedFile`
 * otherwise hand-roll. Callers keep their own success/error body handling
 * (the two endpoints surface different fields), so this returns the raw
 * `Response` on success and a `timedOut` flag instead of a `TextResult`.
 *
 * The `FormData` body is built by the caller (buffer vs. read-stream), so the
 * streaming behaviour of generated-file uploads is preserved exactly.
 */
async function uploadMultipart(
  gw: GatewayParams,
  options: {
    formData: FormData;
    extraHeaders?: Record<string, string>;
    timeoutMs?: number;
  }
): Promise<{ ok: true; response: Response } | { ok: false; timedOut: true }> {
  const formDataBuffer = await formDataToBuffer(options.formData);
  const fdHeaders = options.formData.getHeaders();
  // Bun accepts Node buffers as fetch bodies, although the shared DOM
  // RequestInit declaration does not model that runtime extension.
  const fetchWithBufferBody = fetch as (
    input: string | URL | Request,
    init?: Omit<RequestInit, "body"> & {
      body?: RequestInit["body"] | Buffer;
    }
  ) => Promise<Response>;

  try {
    const response = await fetchWithBufferBody(
      `${gw.gatewayUrl}/internal/files/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gw.workerToken}`,
          "X-Channel-Id": gw.channelId,
          "X-Conversation-Id": gw.conversationId,
          ...fdHeaders,
          "Content-Length": formDataBuffer.length.toString(),
          ...options.extraHeaders,
        },
        body: formDataBuffer,
        // A stalled gateway upload must not wedge the agent turn forever —
        // a 5-minute ceiling is well above any legitimate file delivery.
        signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
      }
    );
    return { ok: true, response };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, timedOut: true };
    }
    throw err;
  }
}

// ============================================================================
// upload_file
// ============================================================================

export async function uploadUserFile(
  gw: GatewayParams,
  args: { file_path: string; description?: string },
  hooks?: {
    onUploaded?: (payload: {
      tool: "upload_file";
      platform: string;
      fileId: string;
      name: string;
      permalink: string;
      size: number;
      delivery?: "platform-upload" | "artifact-url";
      artifactId?: string;
    }) => Promise<void> | void;
  }
): Promise<TextResult> {
  return withErrorHandling("Show file tool", async () => {
    logger.info(
      `Show file to user: ${args.file_path}, description: ${args.description || "none"}`
    );

    if (!path.isAbsolute(args.file_path) && !gw.workspaceDir) {
      return textResult(
        `Error: Cannot resolve relative file path "${args.file_path}" — workspaceDir not set. This is a wiring bug; pass an absolute path or ensure the worker was started with a workspace.`
      );
    }
    const requestedPath = path.isAbsolute(args.file_path)
      ? args.file_path
      : path.join(gw.workspaceDir as string, args.file_path);

    // Containment check: resolve the real path (following any symlinks) and
    // ensure it stays inside the worker's workspace. Without this, an agent
    // can hand us `../../etc/passwd` (or a symlink that points there) and we
    // would happily upload it to the user.
    let filePath: string;
    if (gw.workspaceDir) {
      try {
        const workspaceReal = await fs.realpath(gw.workspaceDir);
        const requestedReal = await fs.realpath(requestedPath);
        const withSep = workspaceReal.endsWith(path.sep)
          ? workspaceReal
          : workspaceReal + path.sep;
        if (
          requestedReal !== workspaceReal &&
          !requestedReal.startsWith(withSep)
        ) {
          return textResult(
            `Error: Refusing to upload file outside workspace: ${args.file_path}`
          );
        }
        filePath = requestedReal;
      } catch {
        return textResult(
          `Error: Cannot show file - not found or is not a file: ${args.file_path}`
        );
      }
    } else {
      filePath = requestedPath;
    }

    // Use lstat so we don't dereference symlinks for the file-type check —
    // realpath above already proved the resolved target is in-workspace.
    const stats = await fs.lstat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      return textResult(
        `Error: Cannot show file - not found or is not a file: ${args.file_path}`
      );
    }
    if (stats.size === 0) {
      return textResult(`Error: Cannot show empty file: ${args.file_path}`);
    }
    // Cap upload size BEFORE reading into memory. The whole file is buffered
    // (and re-buffered into multipart form data), so an agent pointing this at
    // a multi-GB file it wrote in the workspace could OOM the worker. Reject
    // pathological sizes up front. Override via LOBU_MAX_UPLOAD_BYTES.
    const maxUploadBytes = (() => {
      const raw = parseInt(process.env.LOBU_MAX_UPLOAD_BYTES ?? "", 10);
      return Number.isInteger(raw) && raw > 0 ? raw : 100 * 1024 * 1024;
    })();
    if (stats.size > maxUploadBytes) {
      return textResult(
        `Error: Cannot show file - too large (${stats.size} bytes, limit ${maxUploadBytes}): ${args.file_path}`
      );
    }

    const fileName = path.basename(filePath);
    const fileBuffer = await fs.readFile(filePath);

    const formData = new FormData();
    formData.append("file", fileBuffer, {
      filename: fileName,
      contentType: getContentType(fileName),
    });
    formData.append("filename", fileName);
    if (args.description) {
      formData.append("comment", args.description);
    }

    const upload = await uploadMultipart(gw, { formData });
    if (!upload.ok) {
      return textResult(`Error: Failed to show file to user: upload timed out`);
    }
    const response = upload.response;

    if (!response.ok) {
      const error = await response.text();
      logger.error(`Failed to show file: ${response.status} - ${error}`);
      return textResult(
        `Error: Failed to show file to user: ${response.status} - ${error}`
      );
    }

    const result = (await response.json()) as {
      fileId: string;
      name: string;
      permalink: string;
      delivery?: "platform-upload" | "artifact-url";
      artifactId?: string;
    };
    logger.info(
      `Successfully showed file to user: ${result.fileId} - ${result.name}`
    );
    await hooks?.onUploaded?.({
      tool: "upload_file",
      platform: gw.platform || "unknown",
      fileId: result.fileId,
      name: result.name || fileName,
      permalink: result.permalink,
      size: stats.size,
      ...(result.delivery ? { delivery: result.delivery } : {}),
      ...(result.artifactId ? { artifactId: result.artifactId } : {}),
    });
    return textResult(`Successfully showed ${fileName} to the user`);
  });
}

// ============================================================================
// ============================================================================
// Utility: Upload generated file (image/audio) to gateway
// ============================================================================

export async function uploadGeneratedFile(
  gw: GatewayParams,
  buffer: ArrayBuffer,
  filename: string,
  mimeType: string,
  extraHeaders?: Record<string, string>
): Promise<TextResult | null> {
  let tempPath: string | null = null;
  try {
    // Unique per call: a Date.now() suffix collides when two generate calls
    // share a filename within the same millisecond, and the loser's finally
    // unlink would delete the other's file mid-read. The on-disk name is
    // independent of the upload filename (sent separately in the form data).
    tempPath = path.join(os.tmpdir(), `lobu-gen-${randomUUID()}`);
    await fs.writeFile(tempPath, Buffer.from(buffer));

    const formData = new FormData();
    formData.append("file", nodeFs.createReadStream(tempPath), {
      filename,
      contentType: mimeType,
    });
    formData.append("filename", filename);
    formData.append("comment", "Generated content");

    const upload = await uploadMultipart(gw, { formData, extraHeaders });
    if (!upload.ok) {
      return textResult(`Generated content but upload timed out`);
    }

    if (!upload.response.ok) {
      const uploadError = await upload.response.text();
      return textResult(`Generated content but failed to send: ${uploadError}`);
    }

    return null;
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  }
}
