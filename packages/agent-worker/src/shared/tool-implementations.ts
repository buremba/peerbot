import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "@lobu/core";
import FormData from "form-data";
import { invalidateSessionContextCache } from "../openclaw/session-context";
import { fetchAudioProviderSuggestions } from "./audio-provider-suggestions";
import { createGatewayClient } from "./gateway-client";

const logger = createLogger("shared-tools");

/** Standard text result shape used by both SDK wrappers */
export interface TextResult {
  [key: string]: unknown;
  content: Array<{ [key: string]: unknown; type: "text"; text: string }>;
}

function textResult(text: string): TextResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Join the `text` of every `{ type: "text" }` block in an MCP/tool content
 * array with newlines. Centralizes the `.filter(...).map(...).join("\n")`
 * idiom that every caller (link-button errors, MCP tool results, the MCP CLI)
 * otherwise hand-rolls. Tolerates blocks with a missing `text` field.
 */
export function joinTextContent(
  content: Array<{ type: string; text?: string }> | undefined
): string {
  return (content ?? [])
    .filter(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && typeof c.text === "string"
    )
    .map((c) => c.text)
    .join("\n");
}

/** TextResult carrying a JSON-encoded payload (MCP auth tool responses). */
function jsonResult(payload: Record<string, unknown>): TextResult {
  return textResult(JSON.stringify(payload));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withErrorHandling(
  label: string,
  fn: () => Promise<TextResult>
): Promise<TextResult> {
  return fn().catch((error) => {
    logger.error(`${label} error:`, error);
    return textResult(`Error: ${formatError(error)}`);
  });
}

async function parseErrorBody(response: Response): Promise<{ error?: string }> {
  return response
    .json()
    .catch(() => ({ error: response.statusText })) as Promise<{
    error?: string;
  }>;
}

interface GatewayRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function gatewayFetch<T>(
  gw: GatewayParams,
  urlPath: string,
  options: GatewayRequestOptions = {},
  errorPrefix: string
): Promise<{ data?: T; error?: TextResult }> {
  const { method, body, headers: extraHeaders } = options;

  let response: Response;
  try {
    response = await createGatewayClient({
      baseUrl: gw.gatewayUrl,
      token: gw.workerToken,
    }).request(urlPath, {
      method,
      body,
      headers: extraHeaders,
      // A stalled gateway must not hang the agent turn indefinitely.
      timeoutMs: 60_000,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      logger.error(`${errorPrefix}: request timed out`);
      return { error: textResult(`Error: ${errorPrefix} (timed out)`) };
    }
    throw err;
  }

  if (!response.ok) {
    const errorData = await parseErrorBody(response);
    logger.error(`${errorPrefix}: ${response.status}`, errorData);
    return {
      error: textResult(`Error: ${errorData.error || errorPrefix}`),
    };
  }

  const data = (await response.json()) as T;
  return { data };
}

async function postLinkButton(
  gw: GatewayParams,
  args: {
    url: string;
    label: string;
    linkType?: "settings" | "install" | "oauth";
    body?: string;
  }
): Promise<void> {
  const { error } = await gatewayFetch<{ id: string }>(
    gw,
    "/internal/interactions/create",
    {
      method: "POST",
      body: JSON.stringify({
        interactionType: "link_button",
        url: args.url,
        label: args.label,
        linkType: args.linkType || "oauth",
        body: args.body,
      }),
    },
    "Failed to post link button"
  );

  if (error) {
    const text = joinTextContent(error.content);
    throw new Error(text || "Failed to post link button");
  }
}

/**
 * Gateway connection params shared by all tool implementations.
 */
export interface GatewayParams {
  gatewayUrl: string;
  workerToken: string;
  channelId: string;
  conversationId: string;
  /**
   * Platform identifier (e.g. "slack", "telegram"). Genuinely absent for some
   * callers (tests, non-platform contexts), so optional here — but there is
   * NO silent default: tools that need it (get_channel_history) throw if it
   * is missing.
   */
  platform?: string;
  /**
   * Session workspace directory. Relative file paths from the model get
   * resolved against this (not `process.cwd()`, which is the parent gateway
   * process's directory, not the per-conversation workspace).
   */
  workspaceDir?: string;
}

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

  try {
    const response = await fetch(`${gw.gatewayUrl}/internal/files/upload`, {
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
    });
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
// ask_user
// ============================================================================

export async function askUserQuestion(
  gw: GatewayParams,
  args: { question: string; options: unknown },
  hooks?: {
    /**
     * Invoked exactly once after the question is successfully posted. The
     * worker uses this to force the agent turn to END immediately (abort the
     * loop) rather than trusting the model to comply with the "end your turn"
     * instruction below — a weaker model ignores prose and re-posts the same
     * question dozens of times. The session resumes naturally when the user's
     * click arrives as a new inbound message.
     */
    onPosted?: () => void;
  }
): Promise<TextResult> {
  return withErrorHandling("ask_user", async () => {
    logger.info(`ask_user: ${args.question}`);

    const { error } = await gatewayFetch<{ id: string }>(
      gw,
      "/internal/interactions/create",
      {
        method: "POST",
        body: JSON.stringify({
          interactionType: "question",
          question: args.question,
          options: args.options,
        }),
      },
      "Failed to post question"
    );
    if (error) return error;

    // The post succeeded — terminating the turn here is the deterministic
    // guarantee. The prose instruction is kept only as a hint for models that
    // read the tool result before the abort lands.
    hooks?.onPosted?.();

    return textResult(
      "Question posted with buttons. Your turn is now ending — the user's click will arrive as a new inbound message that resumes this session. Do not call ask_user again."
    );
  });
}

// ============================================================================
// MCP auth tools
// ============================================================================

export async function startMcpLogin(
  gw: GatewayParams,
  args: { mcpId: string }
): Promise<TextResult> {
  return withErrorHandling(`${args.mcpId}_login`, async () => {
    logger.info(`Start MCP login: ${args.mcpId}`);

    const statusPath = `/internal/device-auth/status?mcpId=${encodeURIComponent(
      args.mcpId
    )}`;
    const statusResult = await gatewayFetch<{ authenticated: boolean }>(
      gw,
      statusPath,
      {},
      `Failed to check auth status for ${args.mcpId}`
    );
    if (statusResult.error) return statusResult.error;

    if (statusResult.data?.authenticated) {
      return jsonResult({
        status: "already_authenticated",
        mcp_id: args.mcpId,
        message: `${args.mcpId} is already authenticated.`,
      });
    }

    const startResult = await gatewayFetch<{
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresIn: number;
    }>(
      gw,
      "/internal/device-auth/start",
      {
        method: "POST",
        body: JSON.stringify({ mcpId: args.mcpId }),
      },
      `Failed to start login for ${args.mcpId}`
    );
    if (startResult.error) return startResult.error;

    const verificationUrl =
      startResult.data?.verificationUriComplete ||
      startResult.data?.verificationUri;
    if (verificationUrl) {
      await postLinkButton(gw, {
        url: verificationUrl,
        label: `Connect ${args.mcpId}`,
        linkType: "oauth",
        body: `Sign in to ${args.mcpId} so I can use its tools on your behalf.`,
      });
    }

    return jsonResult({
      status: "login_started",
      mcp_id: args.mcpId,
      verification_url: verificationUrl,
      verification_uri: startResult.data?.verificationUri,
      user_code: startResult.data?.userCode,
      expires_in_seconds: startResult.data?.expiresIn,
      interaction_posted: Boolean(verificationUrl),
      message: verificationUrl
        ? `Authentication required for ${args.mcpId}. The login link has been sent directly to the user. Do not repeat the URL unless they ask.`
        : `Authentication required for ${args.mcpId}. Show the user the verification URL and code, then wait for them to finish login.`,
    });
  });
}

export async function checkMcpLogin(
  gw: GatewayParams,
  args: { mcpId: string }
): Promise<TextResult> {
  return withErrorHandling(`${args.mcpId}_login_check`, async () => {
    logger.info(`Check MCP login: ${args.mcpId}`);

    const statusPath = `/internal/device-auth/status?mcpId=${encodeURIComponent(
      args.mcpId
    )}`;
    const statusResult = await gatewayFetch<{ authenticated: boolean }>(
      gw,
      statusPath,
      {},
      `Failed to check auth status for ${args.mcpId}`
    );
    if (statusResult.error) return statusResult.error;

    if (statusResult.data?.authenticated) {
      invalidateSessionContextCache();
      return jsonResult({
        status: "already_authenticated",
        mcp_id: args.mcpId,
        authenticated: true,
        refreshed_session_context: true,
        message: `${args.mcpId} is already authenticated. Newly available MCP tools will be refreshed for the next message.`,
      });
    }

    const pollResult = await gatewayFetch<{
      status: "pending" | "complete" | "error";
      message?: string;
    }>(
      gw,
      "/internal/device-auth/poll",
      {
        method: "POST",
        body: JSON.stringify({ mcpId: args.mcpId }),
      },
      `Failed to check login progress for ${args.mcpId}`
    );
    if (pollResult.error) return pollResult.error;

    const pollStatus = pollResult.data?.status || "error";
    if (pollStatus === "complete") {
      invalidateSessionContextCache();
      return jsonResult({
        status: "complete",
        mcp_id: args.mcpId,
        authenticated: true,
        refreshed_session_context: true,
        message: `${args.mcpId} authentication completed successfully. Newly available MCP tools will be refreshed for the next message.`,
      });
    }

    if (pollStatus === "pending") {
      return jsonResult({
        status: "pending",
        mcp_id: args.mcpId,
        authenticated: false,
        message: `Authentication for ${args.mcpId} is still pending. Wait for the user to complete login in their browser.`,
      });
    }

    return jsonResult({
      status: "error",
      mcp_id: args.mcpId,
      authenticated: false,
      message:
        pollResult.data?.message ||
        `Authentication for ${args.mcpId} failed or expired.`,
    });
  });
}

export async function logoutMcp(
  gw: GatewayParams,
  args: { mcpId: string }
): Promise<TextResult> {
  return withErrorHandling(`${args.mcpId}_logout`, async () => {
    logger.info(`Logout MCP: ${args.mcpId}`);

    const { data, error } = await gatewayFetch<{ success: boolean }>(
      gw,
      `/internal/device-auth/credential?mcpId=${encodeURIComponent(args.mcpId)}`,
      { method: "DELETE" },
      `Failed to log out from ${args.mcpId}`
    );
    if (error) return error;

    return jsonResult({
      status: data?.success ? "logged_out" : "already_logged_out",
      mcp_id: args.mcpId,
      authenticated: false,
      message: data?.success
        ? `${args.mcpId} has been logged out.`
        : `${args.mcpId} was not logged in.`,
    });
  });
}

// ============================================================================
// Utility: Upload generated file (image/audio) to gateway
// ============================================================================

async function uploadGeneratedFile(
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

// ============================================================================
// Shared driver: generate media → upload to the user
// ============================================================================

/**
 * Shared skeleton for `generate_image` / `generate_audio`: optional preflight
 * "is this configured?" check → POST the generate request → map `!ok` into one
 * of three operator-facing messages (provider-list / missing-scope / generic)
 * → read the binary body → upload it via `uploadGeneratedFile`. The two public
 * tools below are thin config objects over this; only the endpoint, preflight,
 * MIME→ext mapping, scope-substring match, and wording differ.
 */
async function generateAndUploadMedia(
  gw: GatewayParams,
  config: {
    label: string;
    logLine: string;
    /**
     * Pre-generation gate. Returns a `notConfigured` message to short-circuit
     * with, or `null` to proceed. Also exposes the resolved provider list so
     * the missing-scope branch can reference it.
     */
    preflight: () => Promise<{
      notConfigured: string | null;
      providerList: string;
    }>;
    endpoint: string;
    requestBody: Record<string, unknown>;
    /** Substring scan over the lowercased error message → missing-scope path. */
    missingScopeMatch: (lowerError: string) => boolean;
    extFromMime: (mimeType: string) => string;
    defaultMimeType: string;
    providerHeader: string;
    uploadFilename: (ext: string) => string;
    uploadHeaders?: Record<string, string>;
    messages: {
      providerListFailure: (errorMessage: string) => string;
      missingScopeFailure: (providerList: string) => string;
      genericFailure: (errorMessage: string) => string;
      success: (provider: string) => string;
      uploadLog: (provider: string) => string;
    };
  }
): Promise<TextResult> {
  return withErrorHandling(config.label, async () => {
    logger.info(config.logLine);

    const { notConfigured, providerList } = await config.preflight();
    if (notConfigured) {
      return textResult(notConfigured);
    }

    const response = await createGatewayClient({
      baseUrl: gw.gatewayUrl,
      token: gw.workerToken,
    }).request(config.endpoint, {
      method: "POST",
      body: JSON.stringify(config.requestBody),
      // Generation can take a while at high quality, but never minutes — cap
      // the wait so a stalled upstream provider doesn't hang the agent turn.
      timeoutMs: 120_000,
    });

    if (!response.ok) {
      const errorData = (await parseErrorBody(response)) as {
        error?: string;
        availableProviders?: string[];
      };
      const errorMessage = errorData.error || "Unknown error";
      const lowerError = errorMessage.toLowerCase();

      if (errorData.availableProviders?.length) {
        return textResult(config.messages.providerListFailure(errorMessage));
      }

      if (config.missingScopeMatch(lowerError)) {
        return textResult(config.messages.missingScopeFailure(providerList));
      }

      return textResult(config.messages.genericFailure(errorMessage));
    }

    const buffer = await response.arrayBuffer();
    const mimeType =
      response.headers.get("Content-Type") || config.defaultMimeType;
    const provider = response.headers.get(config.providerHeader) || "unknown";
    const ext = config.extFromMime(mimeType);

    const uploadError = await uploadGeneratedFile(
      gw,
      buffer,
      config.uploadFilename(ext),
      mimeType,
      config.uploadHeaders
    );
    if (uploadError) return uploadError;

    logger.info(config.messages.uploadLog(provider));
    return textResult(config.messages.success(provider));
  });
}

// ============================================================================
// generate_image
// ============================================================================

function imageExtFromMime(mimeType: string): string {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

export async function generateImage(
  gw: GatewayParams,
  args: {
    prompt: string;
    size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
    quality?: "low" | "medium" | "high" | "auto";
    background?: "transparent" | "opaque" | "auto";
    format?: "png" | "jpeg" | "webp";
  }
): Promise<TextResult> {
  return generateAndUploadMedia(gw, {
    label: "generate_image",
    logLine: `generate_image: ${args.prompt.substring(0, 80)}...`,
    preflight: async () => {
      const capResponse = await createGatewayClient({
        baseUrl: gw.gatewayUrl,
        token: gw.workerToken,
      }).request("/internal/images/capabilities", { timeoutMs: 30_000 });

      if (capResponse.ok) {
        const capabilities = (await capResponse.json()) as {
          available: boolean;
          providers?: Array<{ provider: string; name: string }>;
        };
        if (!capabilities.available) {
          const providerList =
            capabilities.providers?.map((p) => p.name).join(", ") || "OpenAI";
          return {
            notConfigured: `Image generation is not configured. Supported providers: ${providerList}.\n\nAsk an admin to connect one of these providers for the base agent.`,
            providerList,
          };
        }
      }
      return { notConfigured: null, providerList: "OpenAI" };
    },
    endpoint: "/internal/images/generate",
    requestBody: {
      prompt: args.prompt,
      size: args.size,
      quality: args.quality,
      background: args.background,
      format: args.format,
    },
    missingScopeMatch: (lowerError) =>
      lowerError.includes("missing scopes") ||
      lowerError.includes("missing_scope") ||
      (lowerError.includes("scope") &&
        (lowerError.includes("image") || lowerError.includes("model.request"))),
    extFromMime: imageExtFromMime,
    defaultMimeType: "image/png",
    providerHeader: "X-Image-Provider",
    uploadFilename: (ext) => `generated_image.${ext}`,
    messages: {
      providerListFailure: (errorMessage) =>
        `Image generation failed: ${errorMessage}.\n\nAsk an admin to connect one of the supported providers for the base agent.`,
      missingScopeFailure: () =>
        `Image generation failed because the current credential lacks required image permissions.\n\nAsk an admin to connect a provider with image generation access for the base agent.`,
      genericFailure: (errorMessage) =>
        `Error generating image: ${errorMessage}`,
      success: (provider) =>
        `Image sent successfully (generated with ${provider}).`,
      uploadLog: (provider) => `Image generated and sent using ${provider}`,
    },
  });
}

// ============================================================================
// generate_audio
// ============================================================================

function audioExtFromMime(mimeType: string): string {
  if (mimeType.includes("opus")) return "opus";
  if (mimeType.includes("ogg")) return "ogg";
  return "mp3";
}

export async function generateAudio(
  gw: GatewayParams,
  args: { text: string; voice?: string; speed?: number }
): Promise<TextResult> {
  return generateAndUploadMedia(gw, {
    label: "generate_audio",
    logLine: `generate_audio: ${args.text.substring(0, 50)}...`,
    preflight: async () => {
      const suggestions = await fetchAudioProviderSuggestions({
        gatewayUrl: gw.gatewayUrl,
        workerToken: gw.workerToken,
      });
      const providerList =
        suggestions.providerDisplayList || "an audio-capable provider";

      if (suggestions.available === false) {
        return {
          notConfigured: `Audio generation is not configured. To enable it, ask an admin to connect one of the available providers for the base agent: ${providerList}.`,
          providerList,
        };
      }
      return { notConfigured: null, providerList };
    },
    endpoint: "/internal/audio/synthesize",
    requestBody: {
      text: args.text,
      voice: args.voice,
      speed: args.speed,
    },
    missingScopeMatch: (lowerError) =>
      (lowerError.includes("missing scopes") ||
        lowerError.includes("missing_scope")) &&
      lowerError.includes("api.model.audio.request"),
    extFromMime: audioExtFromMime,
    defaultMimeType: "audio/mpeg",
    providerHeader: "X-Audio-Provider",
    uploadFilename: (ext) => `voice_response.${ext}`,
    uploadHeaders: { "X-Voice-Message": "true" },
    messages: {
      providerListFailure: (errorMessage) =>
        `Audio generation failed: ${errorMessage}. No provider configured.\n\nAsk an admin to connect an audio provider for the base agent.`,
      missingScopeFailure: (providerList) =>
        `Audio generation failed because the current OpenAI token lacks api.model.audio.request.\n\nAsk an admin to connect a provider with audio permission for the base agent, or to connect an alternative audio provider (${providerList}).`,
      genericFailure: (errorMessage) =>
        `Error generating audio: ${errorMessage}`,
      success: (provider) =>
        `Voice message sent successfully (generated with ${provider}).`,
      uploadLog: (provider) => `Audio generated and sent using ${provider}`,
    },
  });
}

// ============================================================================
// get_channel_history
// ============================================================================

export async function getChannelHistory(
  gw: GatewayParams,
  args: { limit?: number; before?: string }
): Promise<TextResult> {
  return withErrorHandling("get_channel_history", async () => {
    const limit = Math.min(Math.max(args.limit || 50, 1), 100);
    const platform = gw.platform;
    if (!platform) {
      // No silent fallback: defaulting to "slack" returned another platform's
      // (empty/wrong) history. Surface the wiring bug instead.
      throw new Error("platform is required for get_channel_history");
    }
    logger.info(
      `get_channel_history: limit=${limit}, before=${args.before || "none"}`
    );

    const params = new URLSearchParams({
      platform,
      channelId: gw.channelId,
      conversationId: gw.conversationId,
      limit: String(limit),
    });

    if (args.before) {
      params.set("before", args.before);
    }

    interface HistoryResult {
      messages: Array<{
        timestamp: string;
        user: string;
        text: string;
        isBot?: boolean;
      }>;
      nextCursor: string | null;
      hasMore: boolean;
      note?: string;
    }

    const { data, error } = await gatewayFetch<HistoryResult>(
      gw,
      `/internal/history?${params}`,
      {},
      "Failed to fetch channel history"
    );
    if (error) return error;
    const history = data!;

    if (history.note) {
      return textResult(history.note);
    }

    if (history.messages.length === 0) {
      return textResult("No messages found in channel history.");
    }

    const formatted = history.messages
      .map((msg) => {
        const time = new Date(msg.timestamp).toLocaleString();
        const sender = msg.isBot ? `[Bot] ${msg.user}` : msg.user;
        return `[${time}] ${sender}: ${msg.text}`;
      })
      .join("\n\n");

    let result = `Found ${history.messages.length} messages:\n\n${formatted}`;

    if (history.hasMore && history.nextCursor) {
      result += `\n\n---\nMore messages available. Use before="${history.nextCursor}" to fetch older messages.`;
    }

    return textResult(result);
  });
}

// ============================================================================
// MCP Tools (route to MCP proxy /mcp/{mcpId}/tools/{toolName})
// ============================================================================

/**
 * Retrieval tools that we ask the upstream MCP server to return as JSON instead
 * of formatted markdown so the worker can include structured `result_summary`
 * (event IDs, snippet text) in the `tool_use` SSE event for RAG assertions.
 */
const TOOLS_REQUESTING_JSON_FORMAT = new Set([
  "search_memory",
  "lobu_search_memory",
]);

export async function callMcpTool(
  gw: GatewayParams,
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<TextResult> {
  return withErrorHandling(`${mcpId}/${toolName}`, async () => {
    let response: Response;
    const wantsJson = TOOLS_REQUESTING_JSON_FORMAT.has(toolName);
    try {
      // Retrieval tools (`search_memory`) opt into JSON-encoded results so the
      // worker → SSE `tool_use` event can carry structured `result_summary`
      // (event ids + snippet text) to clients like @lobu/promptfoo-provider for
      // RAG assertions. Other tools keep the formatted-markdown output the
      // agent has been seeing. External MCP servers ignore the header.
      response = await createGatewayClient({
        baseUrl: gw.gatewayUrl,
        token: gw.workerToken,
      }).request(`/mcp/${mcpId}/tools/${toolName}`, {
        method: "POST",
        headers: wantsJson ? { "x-mcp-format": "json" } : undefined,
        body: JSON.stringify(args),
        // Third-party MCP server on the other side — give it a generous
        // budget but never wait forever.
        timeoutMs: 120_000,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        return textResult(`Error: MCP tool ${mcpId}/${toolName} timed out`);
      }
      throw err;
    }

    // MCP proxy returns JSON on success, but a misbehaving upstream (502
    // HTML, plain-text 500, empty body) would otherwise crash the tool call
    // with "Unexpected token < in JSON". Treat parse failure as a transport
    // error message instead of letting it bubble out as an unhandled throw.
    let data: {
      content?: Array<{ type: string; text: string }>;
      error?: string;
      isError?: boolean;
    };
    try {
      data = (await response.json()) as {
        content?: Array<{ type: string; text: string }>;
        error?: string;
        isError?: boolean;
      };
    } catch (parseErr) {
      const parseMsg =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
      return textResult(
        `Error: ${toolName} returned a non-JSON response (status ${response.status}): ${parseMsg}`
      );
    }

    if (!response.ok || data.isError) {
      const contentText = joinTextContent(data.content);
      const errorMsg =
        data.error || contentText || `${toolName} failed (${response.status})`;
      return textResult(`Error: ${errorMsg}`);
    }

    const text = joinTextContent(data.content);
    return textResult(text || `${toolName} completed.`);
  });
}
