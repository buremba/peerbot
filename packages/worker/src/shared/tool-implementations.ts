import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "@lobu/core";
import FormData from "form-data";
import { createMcpDiscoveryClient } from "../common/mcp-discovery-client";

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

/**
 * Gateway connection params shared by all tool implementations.
 */
export interface GatewayParams {
  gatewayUrl: string;
  workerToken: string;
  channelId: string;
  conversationId: string;
  platform?: string;
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

export function getContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// ============================================================================
// Utility: FormData buffer serialisation
// ============================================================================

export async function formDataToBuffer(formData: FormData): Promise<Buffer> {
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
  args: { file_path: string; description?: string }
): Promise<TextResult> {
  return withErrorHandling("Show file tool", async () => {
    logger.info(
      `Show file to user: ${args.file_path}, description: ${args.description || "none"}`
    );

    const filePath = path.isAbsolute(args.file_path)
      ? args.file_path
      : path.join(process.cwd(), args.file_path);

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
    };
    logger.info(
      `Successfully showed file to user: ${result.fileId} - ${result.name}`
    );
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
      "Question posted with buttons. Your session will end now. The user's answer will arrive as your next message."
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
// SearchExtensions (unified search for skills + MCP servers)
// ============================================================================

interface ExtensionResult {
  id: string;
  name: string;
  description: string;
  type: "skill" | "mcp";
  source: string;
}

async function searchSkillsFromGateway(
  gw: GatewayParams,
  query: string,
  limit: number
): Promise<ExtensionResult[]> {
  try {
    const response = await fetch(
      `${gw.gatewayUrl}/internal/integrations/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${gw.workerToken}` } }
    );
    if (!response.ok) return [];
    const data = (await response.json()) as {
      skills: Array<{ id: string; name: string; source: string }>;
    };
    return (data.skills || []).map((s) => ({
      id: s.id,
      name: s.name,
      description: "",
      type: "skill" as const,
      source: s.source || "clawhub",
    }));
  } catch (error) {
    logger.error("Failed to search skills from gateway:", error);
    return [];
  }
}

async function searchMcpsFromGateway(
  gw: GatewayParams,
  query: string,
  limit: number
): Promise<ExtensionResult[]> {
  try {
    const mcpClient = createMcpDiscoveryClient(gw.gatewayUrl, gw.workerToken);
    const results = await mcpClient.search(query, limit);
    return results.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || "",
      type: "mcp" as const,
      source: r.source || "mcp-registry",
    }));
  } catch (error) {
    logger.error("Failed to search MCPs:", error);
    return [];
  }
}

function formatExtensionResults(results: ExtensionResult[]): string {
  return results
    .map(
      (item, index) =>
        `${index + 1}. [${item.type.toUpperCase()}] ${item.name} (${item.id})\n   ${item.description || "No description"}\n   source: ${item.source}`
    )
    .join("\n\n");
}

export async function searchExtensions(
  gw: GatewayParams,
  args: { query: string; type?: "skill" | "mcp"; limit?: number }
): Promise<TextResult> {
  return withErrorHandling("SearchExtensions", async () => {
    const limit = Math.min(args.limit || 5, 10);
    const searchType = args.type;

    let results: ExtensionResult[];

    if (searchType === "skill") {
      results = await searchSkillsFromGateway(gw, args.query, limit);
    } else if (searchType === "mcp") {
      results = await searchMcpsFromGateway(gw, args.query, limit);
    } else {
      const [skills, mcps] = await Promise.all([
        searchSkillsFromGateway(gw, args.query, limit),
        searchMcpsFromGateway(gw, args.query, limit),
      ]);
      results = [...skills, ...mcps].slice(0, limit);
    }

    if (!results.length) {
      return textResult(
        `No extensions found for "${args.query}". Try a broader query.`
      );
    }

    return textResult(
      `Found ${results.length} extension(s):\n\n${formatExtensionResults(results)}\n\n` +
        `Ask the user which one they want, then call InstallExtension with the selected id and type.`
    );
  });
}

// ============================================================================
// InstallExtension (unified install for skills + MCP servers)
// ============================================================================

export async function installExtension(
  gw: GatewayParams,
  args: {
    id: string;
    type: "skill" | "mcp";
    reason?: string;
    envVars?: string[];
    nixPackages?: string[];
  }
): Promise<TextResult> {
  return withErrorHandling("InstallExtension", async () => {
    if (args.type === "mcp") {
      const mcpClient = createMcpDiscoveryClient(gw.gatewayUrl, gw.workerToken);
      const mcp = await mcpClient.getById(args.id);
      const reason =
        args.reason ||
        `Install MCP server "${mcp.name}" so it can be used in this agent`;

      const body: Record<string, unknown> = {
        reason,
        prefillMcpServers: [mcp.prefillMcpServer],
      };
      if (args.envVars?.length) body.prefillEnvVars = args.envVars;
      if (args.nixPackages?.length) body.prefillNixPackages = args.nixPackages;

      interface SettingsLinkResult {
        url: string;
        expiresAt: string;
      }

      const { data, error } = await gatewayFetch<SettingsLinkResult>(
        gw,
        "/internal/settings-link",
        { method: "POST", body: JSON.stringify(body) },
        "Failed to generate install link"
      );
      if (error) return error;

      return textResult(
        `Install link generated for MCP server "${mcp.name}" (${mcp.id}).\n\n` +
          `URL: ${data!.url}\n\n` +
          `Ask the user to open the link and confirm installation.`
      );
    }

    // type === "skill"
    const reason = args.reason || `Install skill "${args.id}" for this agent`;

    const body: Record<string, unknown> = {
      reason,
      prefillSkills: [{ repo: args.id }],
    };
    if (args.envVars?.length) body.prefillEnvVars = args.envVars;
    if (args.nixPackages?.length) body.prefillNixPackages = args.nixPackages;

    interface SettingsLinkResult {
      url: string;
      expiresAt: string;
    }

    const { data, error } = await gatewayFetch<SettingsLinkResult>(
      gw,
      "/internal/settings-link",
      { method: "POST", body: JSON.stringify(body) },
      "Failed to generate install link"
    );
    if (error) return error;

    return textResult(
      `Install link generated for skill "${args.id}".\n\n` +
        `URL: ${data!.url}\n\n` +
        `Ask the user to open the link and confirm installation.`
    );
  });
}

// ============================================================================
// GetSettingsLink
// ============================================================================

export async function getSettingsLink(
  gw: GatewayParams,
  args: {
    reason: string;
    message?: string;
    prefillEnvVars?: string[];
    prefillSkills?: Array<{
      repo: string;
      name?: string;
      description?: string;
    }>;
    prefillNixPackages?: string[];
    prefillGrants?: string[];
    prefillMcpServers?: Array<{
      id: string;
      name?: string;
      url?: string;
      type?: "sse" | "stdio";
      command?: string;
      args?: string[];
      envVars?: string[];
    }>;
  }
): Promise<TextResult> {
  return withErrorHandling("GetSettingsLink", async () => {
    logger.info(`GetSettingsLink: ${args.reason}`);

    interface SettingsLinkResult {
      url: string;
      expiresAt: string;
    }

    const { data, error } = await gatewayFetch<SettingsLinkResult>(
      gw,
      "/internal/settings-link",
      {
        method: "POST",
        body: JSON.stringify({
          reason: args.reason,
          message: args.message,
          prefillEnvVars: args.prefillEnvVars,
          prefillNixPackages: args.prefillNixPackages,
          prefillGrants: args.prefillGrants,
          prefillSkills: args.prefillSkills,
          prefillMcpServers: args.prefillMcpServers,
        }),
      },
      "Failed to generate settings link"
    );
    if (error) return error;
    const result = data!;

    logger.info(`Generated settings link: ${result.url}`);

    const expiresLabel = result.expiresAt
      ? `Expires: ${new Date(result.expiresAt).toLocaleString()}`
      : "";

    return textResult(
      `Settings link generated successfully!\n\nURL: ${result.url}\n\n${expiresLabel}\n\nReason: ${args.reason}\n\nShare this link with the user so they can configure their settings.`
    );
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

    const capResponse = await fetch(
      `${gw.gatewayUrl}/internal/audio/capabilities`,
      {
        headers: { Authorization: `Bearer ${gw.workerToken}` },
      }
    );

    if (capResponse.ok) {
      const capabilities = (await capResponse.json()) as {
        available: boolean;
        provider?: string;
        providers?: Array<{
          provider: string;
          name: string;
          envVar: string;
        }>;
      };

      if (!capabilities.available) {
        const providerList =
          capabilities.providers
            ?.map((p) => `${p.name} (${p.envVar})`)
            .join(", ") || "openai, gemini, elevenlabs";
        return textResult(
          `Audio generation is not configured. To enable it, add an API key for one of these providers: ${providerList}. Use the GetSettingsLink tool to help the user configure this.`
        );
      }
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

      if (errorData.availableProviders?.length) {
        return textResult(
          `Audio generation failed: ${errorData.error}. No provider configured. Use GetSettingsLink to help the user add an API key.`
        );
      }

      return textResult(
        `Error generating audio: ${errorData.error || "Unknown error"}`
      );
    }

    const audioBuffer = await response.arrayBuffer();
    const mimeType = response.headers.get("Content-Type") || "audio/mpeg";
    const provider = response.headers.get("X-Audio-Provider") || "unknown";
    const ext = audioExtFromMime(mimeType);

    let tempPath: string | null = null;
    try {
      tempPath = `/tmp/audio_${Date.now()}.${ext}`;
      await fs.writeFile(tempPath, Buffer.from(audioBuffer));

      const formData = new FormData();
      formData.append("file", nodeFs.createReadStream(tempPath), {
        filename: `voice_response.${ext}`,
        contentType: mimeType,
      });
      formData.append("filename", `voice_response.${ext}`);
      formData.append("comment", "Voice response");

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
            "X-Voice-Message": "true",
            ...fdHeaders,
            "Content-Length": formDataBuffer.length.toString(),
          },
          body: formDataBuffer,
        }
      );

      if (!uploadResponse.ok) {
        const uploadError = await uploadResponse.text();
        return textResult(`Generated audio but failed to send: ${uploadError}`);
      }
    } finally {
      if (tempPath) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
    }

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
