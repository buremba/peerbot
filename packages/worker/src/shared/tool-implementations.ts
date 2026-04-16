import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "@lobu/core";
import FormData from "form-data";
import { fetchAudioProviderSuggestions } from "./audio-provider-suggestions";

const logger = createLogger("shared-tools");

/** Standard text result shape used by both SDK wrappers */
export interface TextResult {
  [key: string]: unknown;
  content: Array<{ [key: string]: unknown; type: "text"; text: string }>;
}

function textResult(text: string): TextResult {
  return { content: [{ type: "text" as const, text }] };
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
  const headers: Record<string, string> = {
    Authorization: `Bearer ${gw.workerToken}`,
    ...extraHeaders,
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${gw.gatewayUrl}${urlPath}`, {
    method,
    headers,
    body,
  });

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
    const text = error.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
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
// UploadUserFile
// ============================================================================

export async function uploadUserFile(
  gw: GatewayParams,
  args: { file_path: string; description?: string },
  hooks?: {
    onUploaded?: (payload: {
      tool: "UploadUserFile";
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
    const filePath = path.isAbsolute(args.file_path)
      ? args.file_path
      : path.join(gw.workspaceDir as string, args.file_path);

    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats || !stats.isFile()) {
      return textResult(
        `Error: Cannot show file - not found or is not a file: ${args.file_path}`
      );
    }
    if (stats.size === 0) {
      return textResult(`Error: Cannot show empty file: ${args.file_path}`);
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

    const formDataBuffer = await formDataToBuffer(formData);
    const fdHeaders = formData.getHeaders();

    const response = await fetch(`${gw.gatewayUrl}/internal/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gw.workerToken}`,
        "X-Channel-Id": gw.channelId,
        "X-Conversation-Id": gw.conversationId,
        ...fdHeaders,
        "Content-Length": formDataBuffer.length.toString(),
      },
      body: formDataBuffer,
    });

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
      tool: "UploadUserFile",
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
// AskUserQuestion
// ============================================================================

export async function askUserQuestion(
  gw: GatewayParams,
  args: { question: string; options: unknown }
): Promise<TextResult> {
  return withErrorHandling("AskUserQuestion", async () => {
    logger.info(`AskUserQuestion: ${args.question}`);

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

    return textResult(
      "Question posted with buttons. End your turn now — the user's click will arrive as a new inbound message that resumes this session."
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
      return textResult(
        JSON.stringify({
          status: "already_authenticated",
          mcp_id: args.mcpId,
          message: `${args.mcpId} is already authenticated.`,
        })
      );
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

    return textResult(
      JSON.stringify({
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
      })
    );
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
      const { invalidateSessionContextCache } = await import(
        "../openclaw/session-context"
      );
      invalidateSessionContextCache();
      return textResult(
        JSON.stringify({
          status: "already_authenticated",
          mcp_id: args.mcpId,
          authenticated: true,
          refreshed_session_context: true,
          message: `${args.mcpId} is already authenticated. Newly available MCP tools will be refreshed for the next message.`,
        })
      );
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
      const { invalidateSessionContextCache } = await import(
        "../openclaw/session-context"
      );
      invalidateSessionContextCache();
      return textResult(
        JSON.stringify({
          status: "complete",
          mcp_id: args.mcpId,
          authenticated: true,
          refreshed_session_context: true,
          message: `${args.mcpId} authentication completed successfully. Newly available MCP tools will be refreshed for the next message.`,
        })
      );
    }

    if (pollStatus === "pending") {
      return textResult(
        JSON.stringify({
          status: "pending",
          mcp_id: args.mcpId,
          authenticated: false,
          message: `Authentication for ${args.mcpId} is still pending. Wait for the user to complete login in their browser.`,
        })
      );
    }

    return textResult(
      JSON.stringify({
        status: "error",
        mcp_id: args.mcpId,
        authenticated: false,
        message:
          pollResult.data?.message ||
          `Authentication for ${args.mcpId} failed or expired.`,
      })
    );
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

    return textResult(
      JSON.stringify({
        status: data?.success ? "logged_out" : "already_logged_out",
        mcp_id: args.mcpId,
        authenticated: false,
        message: data?.success
          ? `${args.mcpId} has been logged out.`
          : `${args.mcpId} was not logged in.`,
      })
    );
  });
}

// ============================================================================
// ScheduleReminder
// ============================================================================

export async function scheduleReminder(
  gw: GatewayParams,
  args: {
    task: string;
    delayMinutes?: number;
    cron?: string;
    maxIterations?: number;
  }
): Promise<TextResult> {
  return withErrorHandling("ScheduleReminder", async () => {
    const scheduleType = args.cron
      ? `cron: ${args.cron}`
      : `${args.delayMinutes} minutes`;
    logger.info(
      `ScheduleReminder: ${scheduleType} - ${args.task.substring(0, 50)}...`
    );

    interface ScheduleResult {
      scheduleId: string;
      scheduledFor: string;
      isRecurring: boolean;
      cron?: string;
      maxIterations: number;
      message: string;
    }

    const { data, error } = await gatewayFetch<ScheduleResult>(
      gw,
      "/internal/schedule",
      {
        method: "POST",
        body: JSON.stringify({
          delayMinutes: args.delayMinutes,
          cron: args.cron,
          maxIterations: args.maxIterations,
          task: args.task,
        }),
      },
      "Failed to schedule reminder"
    );
    if (error) return error;
    const result = data!;

    logger.info(
      `Scheduled reminder: ${result.scheduleId} for ${result.scheduledFor}${result.isRecurring ? ` (recurring: ${result.cron})` : ""}`
    );

    const recurringInfo = result.isRecurring
      ? `\nRecurring: ${result.cron} (max ${result.maxIterations} iterations)`
      : "";

    return textResult(
      `Reminder scheduled successfully!\n\nSchedule ID: ${result.scheduleId}\nFirst trigger: ${new Date(result.scheduledFor).toLocaleString()}${recurringInfo}\n\nYou can cancel this with CancelReminder if needed.`
    );
  });
}

// ============================================================================
// CancelReminder
// ============================================================================

export async function cancelReminder(
  gw: GatewayParams,
  args: { scheduleId: string }
): Promise<TextResult> {
  return withErrorHandling("CancelReminder", async () => {
    logger.info(`CancelReminder: ${args.scheduleId}`);

    interface CancelResult {
      success: boolean;
      message: string;
    }

    const { data, error } = await gatewayFetch<CancelResult>(
      gw,
      `/internal/schedule/${encodeURIComponent(args.scheduleId)}`,
      { method: "DELETE" },
      "Failed to cancel reminder"
    );
    if (error) return error;
    const result = data!;

    return textResult(
      result.success
        ? "Reminder cancelled successfully."
        : `Could not cancel reminder: ${result.message}`
    );
  });
}

// ============================================================================
// ListReminders
// ============================================================================

export async function listReminders(gw: GatewayParams): Promise<TextResult> {
  return withErrorHandling("ListReminders", async () => {
    logger.info("ListReminders");

    interface ReminderEntry {
      scheduleId: string;
      task: string;
      scheduledFor: string;
      minutesRemaining: number;
      isRecurring: boolean;
      cron?: string;
      iteration: number;
      maxIterations: number;
    }

    const { data, error } = await gatewayFetch<{ reminders: ReminderEntry[] }>(
      gw,
      "/internal/schedule",
      {},
      "Failed to list reminders"
    );
    if (error) return error;
    const { reminders } = data!;

    if (reminders.length === 0) {
      return textResult("No pending reminders scheduled.");
    }

    const formatted = reminders
      .map((r, i) => {
        const timeStr =
          r.minutesRemaining < 60
            ? `${r.minutesRemaining} minutes`
            : `${Math.round(r.minutesRemaining / 60)} hours`;
        const recurringInfo = r.isRecurring
          ? `\n   Recurring: ${r.cron} (iteration ${r.iteration}/${r.maxIterations})`
          : "";
        return `${i + 1}. [${r.scheduleId}]\n   Task: ${r.task}\n   Next trigger in: ${timeStr} (${new Date(r.scheduledFor).toLocaleString()})${recurringInfo}`;
      })
      .join("\n\n");

    return textResult(
      `Pending reminders (${reminders.length}):\n\n${formatted}`
    );
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
    tempPath = `/tmp/${filename}_${Date.now()}`;
    await fs.writeFile(tempPath, Buffer.from(buffer));

    const formData = new FormData();
    formData.append("file", nodeFs.createReadStream(tempPath), {
      filename,
      contentType: mimeType,
    });
    formData.append("filename", filename);
    formData.append("comment", "Generated content");

    const formDataBuffer = await formDataToBuffer(formData);
    const fdHeaders = formData.getHeaders();

    const uploadResponse = await fetch(
      `${gw.gatewayUrl}/internal/files/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gw.workerToken}`,
          "X-Channel-Id": gw.channelId,
          "X-Conversation-Id": gw.conversationId,
          ...fdHeaders,
          "Content-Length": formDataBuffer.length.toString(),
          ...extraHeaders,
        },
        body: formDataBuffer,
      }
    );

    if (!uploadResponse.ok) {
      const uploadError = await uploadResponse.text();
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
// GenerateImage
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
  return withErrorHandling("GenerateImage", async () => {
    logger.info(`GenerateImage: ${args.prompt.substring(0, 80)}...`);

    const capResponse = await fetch(
      `${gw.gatewayUrl}/internal/images/capabilities`,
      {
        headers: { Authorization: `Bearer ${gw.workerToken}` },
      }
    );

    if (capResponse.ok) {
      const capabilities = (await capResponse.json()) as {
        available: boolean;
        providers?: Array<{ provider: string; name: string }>;
      };
      if (!capabilities.available) {
        const providerList =
          capabilities.providers?.map((p) => p.name).join(", ") || "OpenAI";
        return textResult(
          `Image generation is not configured. Supported providers: ${providerList}.\n\nAsk an admin to connect one of these providers for the base agent.`
        );
      }
    }

    const response = await fetch(`${gw.gatewayUrl}/internal/images/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gw.workerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: args.prompt,
        size: args.size,
        quality: args.quality,
        background: args.background,
        format: args.format,
      }),
    });

    if (!response.ok) {
      const errorData = (await parseErrorBody(response)) as {
        error?: string;
        availableProviders?: string[];
      };
      const errorMessage = errorData.error || "Unknown error";
      const lowerError = errorMessage.toLowerCase();
      const missingImagePermission =
        lowerError.includes("missing scopes") ||
        lowerError.includes("missing_scope") ||
        (lowerError.includes("scope") &&
          (lowerError.includes("image") ||
            lowerError.includes("model.request")));

      if (errorData.availableProviders?.length) {
        return textResult(
          `Image generation failed: ${errorMessage}.\n\nAsk an admin to connect one of the supported providers for the base agent.`
        );
      }

      if (missingImagePermission) {
        return textResult(
          `Image generation failed because the current credential lacks required image permissions.\n\nAsk an admin to connect a provider with image generation access for the base agent.`
        );
      }

      return textResult(`Error generating image: ${errorMessage}`);
    }

    const imageBuffer = await response.arrayBuffer();
    const mimeType = response.headers.get("Content-Type") || "image/png";
    const provider = response.headers.get("X-Image-Provider") || "unknown";
    const ext = imageExtFromMime(mimeType);

    const uploadError = await uploadGeneratedFile(
      gw,
      imageBuffer,
      `generated_image.${ext}`,
      mimeType
    );
    if (uploadError) return uploadError;

    logger.info(`Image generated and sent using ${provider}`);
    return textResult(`Image sent successfully (generated with ${provider}).`);
  });
}

// ============================================================================
// GenerateAudio
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
  return withErrorHandling("GenerateAudio", async () => {
    logger.info(`GenerateAudio: ${args.text.substring(0, 50)}...`);

    const suggestions = await fetchAudioProviderSuggestions({
      gatewayUrl: gw.gatewayUrl,
      workerToken: gw.workerToken,
    });
    const providerList =
      suggestions.providerDisplayList || "an audio-capable provider";

    if (suggestions.available === false) {
      return textResult(
        `Audio generation is not configured. To enable it, ask an admin to connect one of the available providers for the base agent: ${providerList}.`
      );
    }

    const response = await fetch(`${gw.gatewayUrl}/internal/audio/synthesize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gw.workerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: args.text,
        voice: args.voice,
        speed: args.speed,
      }),
    });

    if (!response.ok) {
      const errorData = (await parseErrorBody(response)) as {
        error?: string;
        availableProviders?: string[];
      };
      const errorMessage = errorData.error || "Unknown error";
      const lowerError = errorMessage.toLowerCase();
      const missingOpenAiAudioScope =
        (lowerError.includes("missing scopes") ||
          lowerError.includes("missing_scope")) &&
        lowerError.includes("api.model.audio.request");

      if (errorData.availableProviders?.length) {
        return textResult(
          `Audio generation failed: ${errorMessage}. No provider configured.\n\nAsk an admin to connect an audio provider for the base agent.`
        );
      }

      if (missingOpenAiAudioScope) {
        return textResult(
          `Audio generation failed because the current OpenAI token lacks api.model.audio.request.\n\nAsk an admin to connect a provider with audio permission for the base agent, or to connect an alternative audio provider (${providerList}).`
        );
      }

      return textResult(`Error generating audio: ${errorMessage}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const mimeType = response.headers.get("Content-Type") || "audio/mpeg";
    const provider = response.headers.get("X-Audio-Provider") || "unknown";
    const ext = audioExtFromMime(mimeType);

    const uploadError = await uploadGeneratedFile(
      gw,
      audioBuffer,
      `voice_response.${ext}`,
      mimeType,
      { "X-Voice-Message": "true" }
    );
    if (uploadError) return uploadError;

    logger.info(`Audio generated and sent using ${provider}`);
    return textResult(
      `Voice message sent successfully (generated with ${provider}).`
    );
  });
}

// ============================================================================
// GetChannelHistory
// ============================================================================

export async function getChannelHistory(
  gw: GatewayParams,
  args: { limit?: number; before?: string }
): Promise<TextResult> {
  return withErrorHandling("GetChannelHistory", async () => {
    const limit = Math.min(Math.max(args.limit || 50, 1), 100);
    const platform = gw.platform || "slack";
    logger.info(
      `GetChannelHistory: limit=${limit}, before=${args.before || "none"}`
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

export async function callMcpTool(
  gw: GatewayParams,
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<TextResult> {
  return withErrorHandling(`${mcpId}/${toolName}`, async () => {
    const response = await fetch(
      `${gw.gatewayUrl}/mcp/${mcpId}/tools/${toolName}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gw.workerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      }
    );

    const data = (await response.json()) as {
      content?: Array<{ type: string; text: string }>;
      error?: string;
      isError?: boolean;
    };

    if (!response.ok || data.isError) {
      const contentText = data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const errorMsg =
        data.error || contentText || `${toolName} failed (${response.status})`;
      return textResult(`Error: ${errorMsg}`);
    }

    const text = data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return textResult(text || `${toolName} completed.`);
  });
}
