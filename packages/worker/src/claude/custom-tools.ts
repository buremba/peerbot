import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "@peerbot/core";
import FormData from "form-data";
import { z } from "zod";
import type { InteractionClient } from "../common/interaction-client";

const logger = createLogger("custom-tools");

/**
 * Create custom MCP server with tools for showing content to users
 */
export function createCustomToolsServer(
  gatewayUrl: string,
  workerToken: string,
  channelId: string,
  threadId: string,
  interactionClient?: InteractionClient,
  options?: { platform?: string; historyEnabled?: boolean }
) {
  const platform = options?.platform || "slack";
  const historyEnabled = options?.historyEnabled ?? false;
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
              "X-Thread-Id": threadId,
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

  // Add GetChannelHistory tool if history is enabled
  if (historyEnabled) {
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
              threadId,
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
  }

  return createSdkMcpServer({
    name: "peerbot",
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
