import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "@lobu/core";
import FormData from "form-data";
import { z } from "zod";
import type { InteractionClient } from "../common/interaction-client";
import {
  createMcpDiscoveryClient,
  formatSearchResults,
} from "../common/mcp-discovery-client";

const logger = createLogger("custom-tools");

/**
 * Create custom MCP server with tools for showing content to users
 */
export function createCustomToolsServer(
  gatewayUrl: string,
  workerToken: string,
  channelId: string,
  conversationId: string,
  interactionClient?: InteractionClient,
  options?: { platform?: string }
) {
  const platform = options?.platform || "slack";
  const mcpClient = createMcpDiscoveryClient(gatewayUrl, workerToken);

  const tools: any[] = [
    tool(
      "UploadUserFile",
      "Use this whenever you create a visualization, chart, image, document, report, or any file that helps answer the user's request. This is how you share your work with the user.",
      {
        file_path: z
          .string()
          .describe(
            "Path to the file to show (absolute or relative to workspace)"
          ),
        description: z
          .string()
          .optional()
          .describe("Optional description of what the file contains or shows"),
      } as const,
      async (args) => {
        try {
          logger.info(
            `Show file to user: ${args.file_path}, description: ${args.description || "none"}`
          );

          // Resolve file path
          const filePath = path.isAbsolute(args.file_path)
            ? args.file_path
            : path.join(process.cwd(), args.file_path);

          // Check if file exists
          const stats = await fs.stat(filePath).catch(() => null);
          if (!stats || !stats.isFile()) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Cannot show file - not found or is not a file: ${args.file_path}`,
                },
              ],
            };
          }

          // Skip empty files
          if (stats.size === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Cannot show empty file: ${args.file_path}`,
                },
              ],
            };
          }

          const fileName = path.basename(filePath);

          // Read file into buffer
          const fileBuffer = await fs.readFile(filePath);

          // Create form data
          const formData = new FormData();
          formData.append("file", fileBuffer, {
            filename: fileName,
            contentType: getContentType(fileName),
          });
          formData.append("filename", fileName);

          if (args.description) {
            formData.append("comment", args.description);
          }

          // Convert FormData stream to buffer
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

              formData.on("end", () => {
                resolve(Buffer.concat(chunks));
              });

              formData.on("error", (err: Error) => {
                reject(err);
              });

              formData.resume();
            }
          );

          const headers = formData.getHeaders();

          // Upload via gateway
          const response = await fetch(`${gatewayUrl}/internal/files/upload`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${workerToken}`,
              "X-Channel-Id": channelId,
              "X-Conversation-Id": conversationId,
              ...headers,
              "Content-Length": formDataBuffer.length.toString(),
            },
            body: formDataBuffer,
          });

          if (!response.ok) {
            const error = await response.text();
            logger.error(`Failed to show file: ${response.status} - ${error}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Failed to show file to user: ${response.status} - ${error}`,
                },
              ],
            };
          }

          const result = (await response.json()) as {
            fileId: string;
            name: string;
            permalink: string;
          };

          logger.info(
            `Successfully showed file to user: ${result.fileId} - ${result.name}`
          );

          return {
            content: [
              {
                type: "text",
                text: `Successfully showed ${fileName} to the user`,
              },
            ],
          };
        } catch (error) {
          logger.error("Show file tool error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: Failed to show file to user: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    ),
  ];

  // Add AskUserQuestion tool if interaction client is provided
  if (interactionClient) {
    tools.push(
      tool(
        "AskUserQuestion",
        "Ask the user a question with options. Supports three patterns: (1) Simple buttons: pass string array for immediate response. (2) Single form: pass object with field schemas to open a modal. (3) Multi-form workflow: pass array of {label, fields} to let user fill multiple forms before submitting.",
        {
          question: z.string().describe("The question to ask the user"),
          options: z.union([
            z
              .array(z.string())
              .describe(
                "Array of button labels for simple choice (e.g., ['React', 'Vue', 'Angular'])"
              ),
            z
              .any()
              .describe(
                "Object with field schemas for single modal form. Keys are field names, values are {type: 'text'|'select'|'textarea'|'number'|'checkbox'|'multiselect', label?: string, placeholder?: string, options?: string[], required?: boolean, default?: any}"
              ),
            z
              .array(
                z.object({
                  label: z
                    .string()
                    .describe(
                      "Short section label (1-2 words max, under 25 chars). " +
                        "Examples: 'Personal Info', 'Work History', 'Preferences'. " +
                        "Avoid long descriptive names - keep it concise for button display."
                    ),
                  // Using z.any() for fields to avoid z.record compatibility issues with SDK
                  fields: z
                    .any()
                    .describe(
                      "Object with field schemas. Keys are field names, values are {type: 'text'|'select'|'textarea'|'number'|'checkbox'|'multiselect', label?: string, placeholder?: string, options?: string[], required?: boolean, default?: any}"
                    ),
                })
              )
              .describe("Array of forms for multi-step workflow"),
          ]),
        } as const,
        async (args) => {
          try {
            logger.info(`AskUserQuestion: ${args.question}`);

            const response = await interactionClient.askUser({
              interactionType: "question",
              question: args.question,
              options: args.options as any,
            });

            // No response (timeout)
            if (!response.answer && !response.formData) {
              return {
                content: [
                  {
                    type: "text",
                    text: "User did not respond within the timeout period.",
                  },
                ],
              };
            }

            // Simple button response
            if (response.answer) {
              logger.info(`User selected: ${response.answer}`);
              return {
                content: [
                  {
                    type: "text",
                    text: `User selected: ${response.answer}\n\nYou can now proceed based on this choice.`,
                  },
                ],
              };
            }

            // Form response (single or multi)
            if (response.formData) {
              logger.info(
                `User submitted form data: ${JSON.stringify(response.formData)}`
              );
              const formattedData = JSON.stringify(response.formData, null, 2);
              return {
                content: [
                  {
                    type: "text",
                    text: `User submitted:\n\`\`\`json\n${formattedData}\n\`\`\`\n\nYou can now proceed with this configuration.`,
                  },
                ],
              };
            }

            // Shouldn't reach here
            return {
              content: [
                {
                  type: "text",
                  text: "Received invalid response format.",
                },
              ],
            };
          } catch (error) {
            logger.error("AskUserQuestion error:", error);
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        }
      )
    );
  }

  // Add schedule reminder tools (always available)
  tools.push(
    tool(
      "ScheduleReminder",
      "Schedule a task for yourself to execute later. Use delayMinutes for one-time reminders, or cron for recurring schedules. The reminder will be delivered as a message in this thread.",
      {
        task: z
          .string()
          .min(1)
          .max(2000)
          .describe("Description of what you need to do when reminded"),
        delayMinutes: z
          .number()
          .min(1)
          .max(1440)
          .optional()
          .describe(
            "Minutes from now to trigger (1-1440, max 24 hours). Use this OR cron, not both."
          ),
        cron: z
          .string()
          .optional()
          .describe(
            "Cron expression for recurring schedule (e.g., '*/30 * * * *' for every 30 min, '0 9 * * 1-5' for 9am weekdays). Use this OR delayMinutes, not both."
          ),
        maxIterations: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Maximum iterations for recurring schedules (default: 10, max: 100). Only used with cron."
          ),
      } as const,
      async (args) => {
        try {
          const scheduleType = args.cron
            ? `cron: ${args.cron}`
            : `${args.delayMinutes} minutes`;
          logger.info(
            `ScheduleReminder: ${scheduleType} - ${args.task.substring(0, 50)}...`
          );

          const response = await fetch(`${gatewayUrl}/internal/schedule`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${workerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              delayMinutes: args.delayMinutes,
              cron: args.cron,
              maxIterations: args.maxIterations,
              task: args.task,
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
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${errorData.error || "Failed to schedule reminder"}`,
                },
              ],
            };
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

          return {
            content: [
              {
                type: "text",
                text: `Reminder scheduled successfully!\n\nSchedule ID: ${result.scheduleId}\nFirst trigger: ${new Date(result.scheduledFor).toLocaleString()}${recurringInfo}\n\nYou can cancel this with CancelReminder if needed.`,
              },
            ],
          };
        } catch (error) {
          logger.error("ScheduleReminder error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    ),

    tool(
      "CancelReminder",
      "Cancel a previously scheduled reminder. Use the scheduleId returned from ScheduleReminder.",
      {
        scheduleId: z
          .string()
          .describe("The schedule ID returned from ScheduleReminder"),
      } as const,
      async (args) => {
        try {
          logger.info(`CancelReminder: ${args.scheduleId}`);

          const response = await fetch(
            `${gatewayUrl}/internal/schedule/${encodeURIComponent(args.scheduleId)}`,
            {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${workerToken}`,
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
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${errorData.error || "Failed to cancel reminder"}`,
                },
              ],
            };
          }

          const result = (await response.json()) as {
            success: boolean;
            message: string;
          };

          return {
            content: [
              {
                type: "text",
                text: result.success
                  ? `Reminder cancelled successfully.`
                  : `Could not cancel reminder: ${result.message}`,
              },
            ],
          };
        } catch (error) {
          logger.error("CancelReminder error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    ),

    tool(
      "ListReminders",
      "List all pending reminders you have scheduled. Shows upcoming reminders with their schedule IDs and remaining time.",
      {} as const,
      async () => {
        try {
          logger.info("ListReminders");

          const response = await fetch(`${gatewayUrl}/internal/schedule`, {
            headers: {
              Authorization: `Bearer ${workerToken}`,
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
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${errorData.error || "Failed to list reminders"}`,
                },
              ],
            };
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
            return {
              content: [
                {
                  type: "text",
                  text: "No pending reminders scheduled.",
                },
              ],
            };
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

          return {
            content: [
              {
                type: "text",
                text: `Pending reminders (${result.reminders.length}):\n\n${formatted}`,
              },
            ],
          };
        } catch (error) {
          logger.error("ListReminders error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    )
  );

  tools.push(
    tool(
      "SearchMcpServers",
      "Search for installable remote MCP servers. Returns up to 5 candidates. Use this when the user asks to connect a service (for example Gmail, Notion, Linear) and you need to find matching MCP options.",
      {
        query: z
          .string()
          .min(1)
          .describe("What to search for (e.g., 'gmail', 'notion', 'github')"),
        limit: z
          .number()
          .min(1)
          .max(5)
          .optional()
          .describe("Maximum candidates to return (default 5, max 5)"),
      } as const,
      async (args) => {
        try {
          const results = await mcpClient.search(args.query, args.limit || 5);
          if (!results.length) {
            return {
              content: [
                {
                  type: "text",
                  text: `No MCP servers found for "${args.query}". Try a broader query.`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text:
                  `Found ${Math.min(results.length, 5)} MCP candidate(s):\n\n${formatSearchResults(results)}\n\n` +
                  `Ask the user which one they want, then call InstallMcpServer with the selected mcpId.`,
              },
            ],
          };
        } catch (error) {
          logger.error("SearchMcpServers error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    )
  );

  tools.push(
    tool(
      "InstallMcpServer",
      "Generate a settings link that pre-fills one selected MCP server for explicit user confirmation.",
      {
        mcpId: z.string().describe("MCP ID from SearchMcpServers results"),
        reason: z
          .string()
          .optional()
          .describe("Optional user-facing reason for this installation"),
      } as const,
      async (args) => {
        try {
          const result = await mcpClient.install(args.mcpId, args.reason);
          return {
            content: [
              {
                type: "text",
                text:
                  `Install link generated for ${result.mcp.name} (${result.mcp.id}).\n\n` +
                  `URL: ${result.url}\n\n` +
                  `Ask the user to open the link and explicitly confirm installation.`,
              },
            ],
          };
        } catch (error) {
          logger.error("InstallMcpServer error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    )
  );

  // Add GetSettingsLink tool for directing users to configure their agent
  tools.push(
    tool(
      "GetSettingsLink",
      "Generate a settings link for the user to configure their agent. Use when the user needs to add API keys, enable skills, configure MCP servers, or change other settings. The link opens a web page where they can securely configure options. You can pre-fill environment variables, skills, and MCP servers for easy setup.",
      {
        reason: z
          .string()
          .describe(
            "Brief explanation of what the user should configure (e.g., 'add your OpenAI API key for voice transcription')"
          ),
        message: z
          .string()
          .optional()
          .describe(
            "Optional message to display on the settings page with instructions (e.g., 'Get your API key from https://platform.openai.com/api-keys')"
          ),
        prefillEnvVars: z
          .array(z.string())
          .optional()
          .describe(
            "Optional list of environment variable names to pre-fill in the settings form (e.g., ['OPENAI_API_KEY', 'TRANSCRIPTION_PROVIDER'])"
          ),
        prefillSkills: z
          .array(
            z.object({
              repo: z
                .string()
                .describe("Skill repository (e.g., 'anthropics/skills/pdf')"),
              name: z
                .string()
                .optional()
                .describe("Display name for the skill"),
              description: z
                .string()
                .optional()
                .describe("Brief description of what the skill does"),
            })
          )
          .optional()
          .describe(
            "Optional list of skills to pre-fill for the user to enable (e.g., [{ repo: 'anthropics/skills/pdf', name: 'PDF Reader' }])"
          ),
        prefillNixPackages: z
          .array(z.string())
          .optional()
          .describe(
            "Optional list of Nix packages to pre-fill in the system packages section (e.g., ['chromium', 'ffmpeg'])"
          ),
        prefillMcpServers: z
          .array(
            z.object({
              id: z.string().describe("Unique identifier for the MCP server"),
              name: z
                .string()
                .optional()
                .describe("Display name for the MCP server"),
              url: z
                .string()
                .optional()
                .describe("Server URL for SSE-type MCPs"),
              type: z
                .enum(["sse", "stdio"])
                .optional()
                .describe(
                  "Server type: 'sse' for HTTP or 'stdio' for command-based"
                ),
              command: z
                .string()
                .optional()
                .describe("Command to run for stdio-type MCPs"),
              args: z
                .array(z.string())
                .optional()
                .describe("Arguments for stdio-type MCPs"),
              envVars: z
                .array(z.string())
                .optional()
                .describe(
                  "Required environment variable names (user fills values)"
                ),
            })
          )
          .optional()
          .describe(
            "Optional list of MCP servers to pre-fill for the user to enable"
          ),
      } as const,
      async (args) => {
        try {
          logger.info(`GetSettingsLink: ${args.reason}`);

          const response = await fetch(`${gatewayUrl}/internal/settings-link`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${workerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              reason: args.reason,
              message: args.message,
              prefillEnvVars: args.prefillEnvVars,
              prefillNixPackages: args.prefillNixPackages,
              prefillSkills: args.prefillSkills,
              prefillMcpServers: args.prefillMcpServers,
            }),
          });

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
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${errorData.error || "Failed to generate settings link"}`,
                },
              ],
            };
          }

          const result = (await response.json()) as {
            url: string;
            expiresAt: string;
          };

          logger.info(`Generated settings link: ${result.url}`);

          return {
            content: [
              {
                type: "text",
                text: `Settings link generated successfully!\n\nURL: ${result.url}\n\nThis link expires in 1 hour.\n\nReason: ${args.reason}\n\nShare this link with the user so they can configure their settings.`,
              },
            ],
          };
        } catch (error) {
          logger.error("GetSettingsLink error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    )
  );

  // Add GenerateAudio tool for text-to-speech
  tools.push(
    tool(
      "GenerateAudio",
      "Generate audio from text (text-to-speech). Use when you want to respond with a voice message, read content aloud, or when the user asks for audio output. The generated audio will be sent as a voice message to the user.",
      {
        text: z
          .string()
          .max(4096)
          .describe("The text to convert to speech (max 4096 characters)"),
        voice: z
          .string()
          .optional()
          .describe(
            "Voice ID (provider-specific). OpenAI: alloy, echo, fable, onyx, nova, shimmer. ElevenLabs: voice ID. Leave empty for default."
          ),
        speed: z
          .number()
          .min(0.5)
          .max(2.0)
          .optional()
          .describe(
            "Speech speed (0.5-2.0, default 1.0). Only supported by some providers."
          ),
      } as const,
      async (args) => {
        try {
          logger.info(`GenerateAudio: ${args.text.substring(0, 50)}...`);

          // First check if audio is available
          const capResponse = await fetch(
            `${gatewayUrl}/internal/audio/capabilities`,
            {
              headers: {
                Authorization: `Bearer ${workerToken}`,
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
              return {
                content: [
                  {
                    type: "text",
                    text: `Audio generation is not configured. To enable it, add an API key for one of these providers: ${providerList}. Use the GetSettingsLink tool to help the user configure this.`,
                  },
                ],
              };
            }
          }

          // Generate audio
          const response = await fetch(
            `${gatewayUrl}/internal/audio/synthesize`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${workerToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: args.text,
                voice: args.voice,
                speed: args.speed,
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
              return {
                content: [
                  {
                    type: "text",
                    text: `Audio generation failed: ${errorData.error}. No provider configured. Use GetSettingsLink to help the user add an API key.`,
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Error generating audio: ${errorData.error || "Unknown error"}`,
                },
              ],
            };
          }

          // Get audio buffer and upload as file
          const audioBuffer = await response.arrayBuffer();
          const mimeType = response.headers.get("Content-Type") || "audio/mpeg";
          const provider =
            response.headers.get("X-Audio-Provider") || "unknown";
          const ext = mimeType.includes("opus")
            ? "opus"
            : mimeType.includes("ogg")
              ? "ogg"
              : "mp3";

          let tempPath: string | null = null;
          try {
            // Save to temp file and upload
            tempPath = `/tmp/audio_${Date.now()}.${ext}`;
            await fs.writeFile(tempPath, Buffer.from(audioBuffer));

            // Upload the audio file to user (buffered form-data for Node 18 fetch)
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

                formData.on("end", () => {
                  resolve(Buffer.concat(chunks));
                });

                formData.on("error", (err: Error) => {
                  reject(err);
                });

                formData.resume();
              }
            );

            const headers = formData.getHeaders();

            const uploadResponse = await fetch(
              `${gatewayUrl}/internal/files/upload`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${workerToken}`,
                  "X-Channel-Id": channelId,
                  "X-Conversation-Id": conversationId,
                  "X-Voice-Message": "true",
                  ...headers,
                  "Content-Length": formDataBuffer.length.toString(),
                },
                body: formDataBuffer,
              }
            );

            if (!uploadResponse.ok) {
              const error = await uploadResponse.text();
              return {
                content: [
                  {
                    type: "text",
                    text: `Generated audio but failed to send: ${error}`,
                  },
                ],
              };
            }
          } finally {
            if (tempPath) {
              await fs.unlink(tempPath).catch(() => {
                // Ignore cleanup errors for temp files
              });
            }
          }

          logger.info(`Audio generated and sent using ${provider}`);

          return {
            content: [
              {
                type: "text",
                text: `Voice message sent successfully (generated with ${provider}).`,
              },
            ],
          };
        } catch (error) {
          logger.error("GenerateAudio error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    )
  );

  // GetChannelHistory - always available for conversation context
  tools.push(
    tool(
      "GetChannelHistory",
      "Fetch previous messages from this conversation thread. Use when the user references past discussions, asks 'what did we talk about', or you need context. Returns messages in reverse chronological order (newest first).",
      {
        limit: z
          .number()
          .optional()
          .describe("Number of messages to fetch (default 50, max 100)"),
        before: z
          .string()
          .optional()
          .describe(
            "ISO timestamp cursor - fetch messages before this time (for pagination)"
          ),
      } as const,
      async (args) => {
        try {
          const limit = Math.min(Math.max(args.limit || 50, 1), 100);
          logger.info(
            `GetChannelHistory: limit=${limit}, before=${args.before || "none"}`
          );

          const params = new URLSearchParams({
            platform,
            channelId,
            conversationId,
            limit: String(limit),
          });

          if (args.before) {
            params.set("before", args.before);
          }

          const response = await fetch(
            `${gatewayUrl}/internal/history?${params}`,
            {
              headers: {
                Authorization: `Bearer ${workerToken}`,
              },
            }
          );

          if (!response.ok) {
            const error = await response.text();
            logger.error(
              `Failed to fetch history: ${response.status} - ${error}`
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Failed to fetch channel history: ${response.status} - ${error}`,
                },
              ],
            };
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
            return {
              content: [
                {
                  type: "text",
                  text: data.note,
                },
              ],
            };
          }

          if (data.messages.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No messages found in channel history.",
                },
              ],
            };
          }

          // Format messages for display
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

          return {
            content: [
              {
                type: "text",
                text: result,
              },
            ],
          };
        } catch (error) {
          logger.error("GetChannelHistory error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    )
  );

  return createSdkMcpServer({
    name: "lobu",
    version: "1.0.0",
    tools,
  });
}

/**
 * Get content type for file based on extension
 */
function getContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
  return contentTypes[ext] || "application/octet-stream";
}
