import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "@lobu/core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import FormData from "form-data";
import type { InteractionClient } from "../common/interaction-client";
import {
  createMcpDiscoveryClient,
  formatSearchResults,
} from "../common/mcp-discovery-client";

const logger = createLogger("openclaw-custom-tools");

type ToolResult = AgentToolResult<Record<string, unknown>>;
type UploadUserFileArgs = {
  file_path: string;
  description?: string;
};
type AskUserArgs = {
  question: string;
  options: unknown;
};
type ScheduleReminderArgs = {
  task: string;
  delayMinutes?: number;
  cron?: string;
  maxIterations?: number;
};
type CancelReminderArgs = {
  scheduleId: string;
};
type GetChannelHistoryArgs = {
  limit?: number;
  before?: string;
};
type GetSettingsLinkArgs = {
  reason: string;
  message?: string;
  prefillEnvVars?: string[];
  prefillSkills?: Array<{ repo: string; name?: string; description?: string }>;
  prefillMcpServers?: Array<{
    id: string;
    name?: string;
    url?: string;
    type?: "sse" | "stdio";
    command?: string;
    args?: string[];
    envVars?: string[];
  }>;
};
type GenerateAudioArgs = {
  text: string;
  voice?: string;
  speed?: number;
};

function buildTextResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export function createOpenClawCustomTools(params: {
  gatewayUrl: string;
  workerToken: string;
  channelId: string;
  conversationId: string;
  interactionClient?: InteractionClient;
  platform?: string;
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const mcpClient = createMcpDiscoveryClient(
    params.gatewayUrl,
    params.workerToken
  );

  tools.push({
    name: "UploadUserFile",
    label: "UploadUserFile",
    description:
      "Use this whenever you create a visualization, chart, image, document, report, or any file that helps answer the user's request. This is how you share your work with the user.",
    parameters: Type.Object({
      file_path: Type.String({
        description:
          "Path to the file to show (absolute or relative to workspace)",
      }),
      description: Type.Optional(
        Type.String({
          description:
            "Optional description of what the file contains or shows",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const toolArgs = args as UploadUserFileArgs;
        const filePath = path.isAbsolute(toolArgs.file_path)
          ? toolArgs.file_path
          : path.join(process.cwd(), toolArgs.file_path);

        const stats = await fs.stat(filePath).catch(() => null);
        if (!stats || !stats.isFile()) {
          return buildTextResult(
            `Error: Cannot show file - not found or is not a file: ${toolArgs.file_path}`
          );
        }

        if (stats.size === 0) {
          return buildTextResult(
            `Error: Cannot show empty file: ${toolArgs.file_path}`
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
        if (toolArgs.description) {
          formData.append("comment", toolArgs.description);
        }

        const formDataBuffer = await new Promise<Buffer>((resolve, reject) => {
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

        const headers = formData.getHeaders();
        const response = await fetch(
          `${params.gatewayUrl}/internal/files/upload`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${params.workerToken}`,
              "X-Channel-Id": params.channelId,
              "X-Conversation-Id": params.conversationId,
              ...headers,
              "Content-Length": formDataBuffer.length.toString(),
            },
            body: formDataBuffer,
          }
        );

        if (!response.ok) {
          const error = await response.text();
          logger.error(`Failed to show file: ${response.status} - ${error}`);
          return buildTextResult(
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

        return buildTextResult(`Successfully showed ${fileName} to the user`);
      } catch (error) {
        logger.error("Show file tool error:", error);
        return buildTextResult(
          `Error: Failed to show file to user: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  if (params.interactionClient) {
    tools.push({
      name: "AskUserQuestion",
      label: "AskUserQuestion",
      description:
        "Ask the user a question with options. Supports simple buttons or modal forms.",
      parameters: Type.Object({
        question: Type.String({ description: "The question to ask the user" }),
        options: Type.Any({
          description:
            "Either an array of button labels, or a form schema object/array",
        }),
      }),
      execute: async (_toolCallId, args) => {
        try {
          const toolArgs = args as AskUserArgs;
          logger.info(`AskUserQuestion: ${toolArgs.question}`);

          const response = await params.interactionClient!.askUser({
            interactionType: "question",
            question: toolArgs.question,
            options: toolArgs.options as any,
          });

          if (!response.answer && !response.formData) {
            return buildTextResult(
              "User did not respond within the timeout period."
            );
          }

          if (response.answer) {
            return buildTextResult(
              `User selected: ${response.answer}\n\nYou can now proceed based on this choice.`
            );
          }

          if (response.formData) {
            const formatted = JSON.stringify(response.formData, null, 2);
            return buildTextResult(
              `User submitted:\n\n\
\`\`\`json\n${formatted}\n\`\`\`\n\nYou can now proceed with this configuration.`
            );
          }

          return buildTextResult("Received invalid response format.");
        } catch (error) {
          logger.error("AskUserQuestion error:", error);
          return buildTextResult(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
    });
  }

  // ScheduleReminder
  tools.push({
    name: "ScheduleReminder",
    label: "ScheduleReminder",
    description:
      "Schedule a task for yourself to execute later. Use delayMinutes for one-time reminders, or cron for recurring schedules. The reminder will be delivered as a message in this thread.",
    parameters: Type.Object({
      task: Type.String({
        description: "Description of what you need to do when reminded",
      }),
      delayMinutes: Type.Optional(
        Type.Number({
          description:
            "Minutes from now to trigger (1-1440, max 24 hours). Use this OR cron, not both.",
        })
      ),
      cron: Type.Optional(
        Type.String({
          description:
            "Cron expression for recurring schedule (e.g., '*/30 * * * *' for every 30 min). Use this OR delayMinutes, not both.",
        })
      ),
      maxIterations: Type.Optional(
        Type.Number({
          description:
            "Maximum iterations for recurring schedules (default: 10, max: 100). Only used with cron.",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const toolArgs = args as ScheduleReminderArgs;
        const scheduleType = toolArgs.cron
          ? `cron: ${toolArgs.cron}`
          : `${toolArgs.delayMinutes} minutes`;
        logger.info(
          `ScheduleReminder: ${scheduleType} - ${toolArgs.task.substring(0, 50)}...`
        );

        const response = await fetch(`${params.gatewayUrl}/internal/schedule`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${params.workerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            delayMinutes: toolArgs.delayMinutes,
            cron: toolArgs.cron,
            maxIterations: toolArgs.maxIterations,
            task: toolArgs.task,
          }),
        });

        if (!response.ok) {
          const errorData = (await response
            .json()
            .catch(() => ({ error: response.statusText }))) as {
            error?: string;
          };
          logger.error(
            `Failed to schedule reminder: ${response.status}`,
            errorData
          );
          return buildTextResult(
            `Error: ${errorData.error || "Failed to schedule reminder"}`
          );
        }

        const result = (await response.json()) as {
          scheduleId: string;
          scheduledFor: string;
          isRecurring: boolean;
          cron?: string;
          maxIterations: number;
          message: string;
        };

        logger.info(
          `Scheduled reminder: ${result.scheduleId} for ${result.scheduledFor}${result.isRecurring ? ` (recurring: ${result.cron})` : ""}`
        );

        const recurringInfo = result.isRecurring
          ? `\nRecurring: ${result.cron} (max ${result.maxIterations} iterations)`
          : "";

        return buildTextResult(
          `Reminder scheduled successfully!\n\nSchedule ID: ${result.scheduleId}\nFirst trigger: ${new Date(result.scheduledFor).toLocaleString()}${recurringInfo}\n\nYou can cancel this with CancelReminder if needed.`
        );
      } catch (error) {
        logger.error("ScheduleReminder error:", error);
        return buildTextResult(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  // CancelReminder
  tools.push({
    name: "CancelReminder",
    label: "CancelReminder",
    description:
      "Cancel a previously scheduled reminder. Use the scheduleId returned from ScheduleReminder.",
    parameters: Type.Object({
      scheduleId: Type.String({
        description: "The schedule ID returned from ScheduleReminder",
      }),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const toolArgs = args as CancelReminderArgs;
        logger.info(`CancelReminder: ${toolArgs.scheduleId}`);

        const response = await fetch(
          `${params.gatewayUrl}/internal/schedule/${encodeURIComponent(toolArgs.scheduleId)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${params.workerToken}`,
            },
          }
        );

        if (!response.ok) {
          const errorData = (await response
            .json()
            .catch(() => ({ error: response.statusText }))) as {
            error?: string;
          };
          logger.error(
            `Failed to cancel reminder: ${response.status}`,
            errorData
          );
          return buildTextResult(
            `Error: ${errorData.error || "Failed to cancel reminder"}`
          );
        }

        const result = (await response.json()) as {
          success: boolean;
          message: string;
        };

        return buildTextResult(
          result.success
            ? `Reminder cancelled successfully.`
            : `Could not cancel reminder: ${result.message}`
        );
      } catch (error) {
        logger.error("CancelReminder error:", error);
        return buildTextResult(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  // ListReminders
  tools.push({
    name: "ListReminders",
    label: "ListReminders",
    description:
      "List all pending reminders you have scheduled. Shows upcoming reminders with their schedule IDs and remaining time.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        logger.info("ListReminders");

        const response = await fetch(`${params.gatewayUrl}/internal/schedule`, {
          headers: {
            Authorization: `Bearer ${params.workerToken}`,
          },
        });

        if (!response.ok) {
          const errorData = (await response
            .json()
            .catch(() => ({ error: response.statusText }))) as {
            error?: string;
          };
          logger.error(
            `Failed to list reminders: ${response.status}`,
            errorData
          );
          return buildTextResult(
            `Error: ${errorData.error || "Failed to list reminders"}`
          );
        }

        const result = (await response.json()) as {
          reminders: Array<{
            scheduleId: string;
            task: string;
            scheduledFor: string;
            minutesRemaining: number;
            isRecurring: boolean;
            cron?: string;
            iteration: number;
            maxIterations: number;
          }>;
        };

        if (result.reminders.length === 0) {
          return buildTextResult("No pending reminders scheduled.");
        }

        const formatted = result.reminders
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

        return buildTextResult(
          `Pending reminders (${result.reminders.length}):\n\n${formatted}`
        );
      } catch (error) {
        logger.error("ListReminders error:", error);
        return buildTextResult(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  tools.push({
    name: "SearchMcpServers",
    label: "SearchMcpServers",
    description:
      "Search for installable remote MCP servers. Returns up to 5 candidates.",
    parameters: Type.Object({
      query: Type.String({
        description: "What to search for (e.g., 'gmail', 'notion', 'github')",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum candidates to return (default 5, max 5)",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const toolArgs = args as { query: string; limit?: number };
        const results = await mcpClient.search(
          toolArgs.query,
          toolArgs.limit || 5
        );
        if (!results.length) {
          return buildTextResult(
            `No MCP servers found for "${toolArgs.query}". Try a broader query.`
          );
        }

        return buildTextResult(
          `Found ${Math.min(results.length, 5)} MCP candidate(s):\n\n${formatSearchResults(results)}\n\nAsk the user which one they want, then call InstallMcpServer with the selected mcpId.`
        );
      } catch (error) {
        logger.error("SearchMcpServers error:", error);
        return buildTextResult(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  tools.push({
    name: "InstallMcpServer",
    label: "InstallMcpServer",
    description:
      "Generate a settings link that pre-fills one selected MCP server for explicit user confirmation.",
    parameters: Type.Object({
      mcpId: Type.String({
        description: "MCP ID from SearchMcpServers results",
      }),
      reason: Type.Optional(
        Type.String({
          description: "Optional user-facing reason for this installation",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const toolArgs = args as { mcpId: string; reason?: string };
        const result = await mcpClient.install(toolArgs.mcpId, toolArgs.reason);
        return buildTextResult(
          `Install link generated for ${result.mcp.name} (${result.mcp.id}).\n\nURL: ${result.url}\n\nAsk the user to open the link and explicitly confirm installation.`
        );
      } catch (error) {
        logger.error("InstallMcpServer error:", error);
        return buildTextResult(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  tools.push({
    name: "GetSettingsLink",
    label: "GetSettingsLink",
    description:
      "Generate a settings link for the user to configure their agent. Use when the user needs to add API keys, enable skills, configure MCP servers, or change other settings.",
    parameters: Type.Object({
      reason: Type.String({
        description:
          "Brief explanation of what the user should configure (e.g., 'add your OpenAI API key for voice transcription')",
      }),
      message: Type.Optional(
        Type.String({
          description:
            "Optional message to display on the settings page with instructions",
        })
      ),
      prefillEnvVars: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional list of environment variable names to pre-fill in the settings form",
        })
      ),
      prefillSkills: Type.Optional(
        Type.Array(
          Type.Object({
            repo: Type.String({
              description: "Skill repository (e.g., 'anthropics/skills/pdf')",
            }),
            name: Type.Optional(
              Type.String({ description: "Display name for the skill" })
            ),
            description: Type.Optional(
              Type.String({
                description: "Brief description of what the skill does",
              })
            ),
          }),
          { description: "Optional list of skills to pre-fill" }
        )
      ),
      prefillMcpServers: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({
              description: "Unique identifier for the MCP server",
            }),
            name: Type.Optional(
              Type.String({ description: "Display name for the MCP server" })
            ),
            url: Type.Optional(
              Type.String({ description: "Server URL for SSE-type MCPs" })
            ),
            type: Type.Optional(
              Type.Union([Type.Literal("sse"), Type.Literal("stdio")], {
                description: "Server type",
              })
            ),
            command: Type.Optional(
              Type.String({
                description: "Command to run for stdio-type MCPs",
              })
            ),
            args: Type.Optional(
              Type.Array(Type.String(), {
                description: "Arguments for stdio-type MCPs",
              })
            ),
            envVars: Type.Optional(
              Type.Array(Type.String(), {
                description: "Required environment variable names",
              })
            ),
          }),
          { description: "Optional list of MCP servers to pre-fill" }
        )
      ),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const toolArgs = args as GetSettingsLinkArgs;
        logger.info(`GetSettingsLink: ${toolArgs.reason}`);

        const response = await fetch(
          `${params.gatewayUrl}/internal/settings-link`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${params.workerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              reason: toolArgs.reason,
              message: toolArgs.message,
              prefillEnvVars: toolArgs.prefillEnvVars,
              prefillSkills: toolArgs.prefillSkills,
              prefillMcpServers: toolArgs.prefillMcpServers,
            }),
          }
        );

        if (!response.ok) {
          const errorData = (await response
            .json()
            .catch(() => ({ error: response.statusText }))) as {
            error?: string;
          };
          logger.error(
            `Failed to generate settings link: ${response.status}`,
            errorData
          );
          return buildTextResult(
            `Error: ${errorData.error || "Failed to generate settings link"}`
          );
        }

        const result = (await response.json()) as {
          url: string;
          expiresAt: string;
        };

        logger.info(`Generated settings link: ${result.url}`);

        return buildTextResult(
          `Settings link generated successfully!\n\nURL: ${result.url}\n\nThis link expires in 1 hour.\n\nReason: ${toolArgs.reason}\n\nShare this link with the user so they can configure their settings.`
        );
      } catch (error) {
        logger.error("GetSettingsLink error:", error);
        return buildTextResult(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  // GenerateAudio
  tools.push({
    name: "GenerateAudio",
    label: "GenerateAudio",
    description:
      "Generate audio from text (text-to-speech). Use when you want to respond with a voice message, read content aloud, or when the user asks for audio output.",
    parameters: Type.Object({
      text: Type.String({
        description: "The text to convert to speech (max 4096 characters)",
      }),
      voice: Type.Optional(
        Type.String({
          description:
            "Voice ID (provider-specific). OpenAI: alloy, echo, fable, onyx, nova, shimmer. Leave empty for default.",
        })
      ),
      speed: Type.Optional(
        Type.Number({
          description: "Speech speed (0.5-2.0, default 1.0).",
        })
      ),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const toolArgs = args as GenerateAudioArgs;
        logger.info(`GenerateAudio: ${toolArgs.text.substring(0, 50)}...`);

        // Check capabilities
        const capResponse = await fetch(
          `${params.gatewayUrl}/internal/audio/capabilities`,
          {
            headers: {
              Authorization: `Bearer ${params.workerToken}`,
            },
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
            return buildTextResult(
              `Audio generation is not configured. To enable it, add an API key for one of these providers: ${providerList}. Use the GetSettingsLink tool to help the user configure this.`
            );
          }
        }

        // Generate audio
        const response = await fetch(
          `${params.gatewayUrl}/internal/audio/synthesize`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${params.workerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: toolArgs.text,
              voice: toolArgs.voice,
              speed: toolArgs.speed,
            }),
          }
        );

        if (!response.ok) {
          const errorData = (await response
            .json()
            .catch(() => ({ error: response.statusText }))) as {
            error?: string;
            availableProviders?: string[];
          };

          if (errorData.availableProviders?.length) {
            return buildTextResult(
              `Audio generation failed: ${errorData.error}. No provider configured. Use GetSettingsLink to help the user add an API key.`
            );
          }

          return buildTextResult(
            `Error generating audio: ${errorData.error || "Unknown error"}`
          );
        }

        const audioBuffer = await response.arrayBuffer();
        const mimeType = response.headers.get("Content-Type") || "audio/mpeg";
        const provider = response.headers.get("X-Audio-Provider") || "unknown";
        const ext = mimeType.includes("opus")
          ? "opus"
          : mimeType.includes("ogg")
            ? "ogg"
            : "mp3";

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

          const formDataBuffer = await new Promise<Buffer>(
            (resolve, reject) => {
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
            }
          );

          const headers = formData.getHeaders();

          const uploadResponse = await fetch(
            `${params.gatewayUrl}/internal/files/upload`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${params.workerToken}`,
                "X-Channel-Id": params.channelId,
                "X-Conversation-Id": params.conversationId,
                "X-Voice-Message": "true",
                ...headers,
                "Content-Length": formDataBuffer.length.toString(),
              },
              body: formDataBuffer,
            }
          );

          if (!uploadResponse.ok) {
            const error = await uploadResponse.text();
            return buildTextResult(
              `Generated audio but failed to send: ${error}`
            );
          }
        } finally {
          if (tempPath) {
            await fs.unlink(tempPath).catch(() => undefined);
          }
        }

        logger.info(`Audio generated and sent using ${provider}`);

        return buildTextResult(
          `Voice message sent successfully (generated with ${provider}).`
        );
      } catch (error) {
        logger.error("GenerateAudio error:", error);
        return buildTextResult(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  // GetChannelHistory - always available for conversation context
  {
    const platform = params.platform || "slack";
    tools.push({
      name: "GetChannelHistory",
      label: "GetChannelHistory",
      description:
        "Fetch previous messages from this conversation thread. Use when the user references past discussions, asks 'what did we talk about', or you need context.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({
            description: "Number of messages to fetch (default 50, max 100)",
          })
        ),
        before: Type.Optional(
          Type.String({
            description:
              "ISO timestamp cursor - fetch messages before this time (for pagination)",
          })
        ),
      }),
      execute: async (_toolCallId, args) => {
        try {
          const toolArgs = args as GetChannelHistoryArgs;
          const limit = Math.min(Math.max(toolArgs.limit || 50, 1), 100);
          logger.info(
            `GetChannelHistory: limit=${limit}, before=${toolArgs.before || "none"}`
          );

          const queryParams = new URLSearchParams({
            platform,
            channelId: params.channelId,
            conversationId: params.conversationId,
            limit: String(limit),
          });

          if (toolArgs.before) {
            queryParams.set("before", toolArgs.before);
          }

          const response = await fetch(
            `${params.gatewayUrl}/internal/history?${queryParams}`,
            {
              headers: {
                Authorization: `Bearer ${params.workerToken}`,
              },
            }
          );

          if (!response.ok) {
            const error = await response.text();
            logger.error(
              `Failed to fetch history: ${response.status} - ${error}`
            );
            return buildTextResult(
              `Error: Failed to fetch channel history: ${response.status} - ${error}`
            );
          }

          const data = (await response.json()) as {
            messages: Array<{
              timestamp: string;
              user: string;
              text: string;
              isBot?: boolean;
            }>;
            nextCursor: string | null;
            hasMore: boolean;
            note?: string;
          };

          if (data.note) {
            return buildTextResult(data.note);
          }

          if (data.messages.length === 0) {
            return buildTextResult("No messages found in channel history.");
          }

          const formatted = data.messages
            .map((msg) => {
              const time = new Date(msg.timestamp).toLocaleString();
              const sender = msg.isBot ? `[Bot] ${msg.user}` : msg.user;
              return `[${time}] ${sender}: ${msg.text}`;
            })
            .join("\n\n");

          let result = `Found ${data.messages.length} messages:\n\n${formatted}`;

          if (data.hasMore && data.nextCursor) {
            result += `\n\n---\nMore messages available. Use before="${data.nextCursor}" to fetch older messages.`;
          }

          return buildTextResult(result);
        } catch (error) {
          logger.error("GetChannelHistory error:", error);
          return buildTextResult(
            `Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
    });
  }

  return tools;
}
