import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { type TSchema, Type } from "@sinclair/typebox";
import type { GatewayParams, TextResult } from "../shared/tool-implementations";
import {
  askUserQuestion,
  cancelReminder,
  generateAudio,
  getChannelHistory,
  getSettingsLink,
  installExtension,
  listReminders,
  scheduleReminder,
  searchExtensions,
  uploadUserFile,
} from "../shared/tool-implementations";

type ToolResult = AgentToolResult<Record<string, unknown>>;

/** Adapt shared TextResult to OpenClaw's ToolResult (adds details field) */
function toToolResult(result: TextResult): ToolResult {
  return { content: result.content, details: {} };
}

/**
 * Create a ToolDefinition with proper type bridging between TypeBox schemas
 * and the shared tool implementation functions. Eliminates per-tool `as` casts
 * by casting once at the boundary.
 */
function defineTool<T extends TSchema>(config: {
  name: string;
  description: string;
  parameters: T;
  run: (args: Static<T>) => Promise<TextResult>;
}): ToolDefinition {
  return {
    name: config.name,
    label: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: async (_toolCallId, args) =>
      toToolResult(await config.run(args as Static<T>)),
  };
}

export function createOpenClawCustomTools(params: {
  gatewayUrl: string;
  workerToken: string;
  channelId: string;
  conversationId: string;
  platform?: string;
}): ToolDefinition[] {
  const gw: GatewayParams = {
    gatewayUrl: params.gatewayUrl,
    workerToken: params.workerToken,
    channelId: params.channelId,
    conversationId: params.conversationId,
    platform: params.platform || "slack",
  };

  const tools: ToolDefinition[] = [
    defineTool({
      name: "UploadUserFile",
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
      run: (args) => uploadUserFile(gw, args),
    }),

    defineTool({
      name: "ScheduleReminder",
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
      run: (args) => scheduleReminder(gw, args),
    }),

    defineTool({
      name: "CancelReminder",
      description:
        "Cancel a previously scheduled reminder. Use the scheduleId returned from ScheduleReminder.",
      parameters: Type.Object({
        scheduleId: Type.String({
          description: "The schedule ID returned from ScheduleReminder",
        }),
      }),
      run: (args) => cancelReminder(gw, args),
    }),

    defineTool({
      name: "ListReminders",
      description:
        "List all pending reminders you have scheduled. Shows upcoming reminders with their schedule IDs and remaining time.",
      parameters: Type.Object({}),
      run: () => listReminders(gw),
    }),

    defineTool({
      name: "SearchExtensions",
      description:
        "Search for installable extensions (skills, MCP servers, or both). Returns candidates from ClawHub (skills) and MCP registry. Use this to help users find and discover new capabilities.",
      parameters: Type.Object({
        query: Type.String({
          description:
            "What to search for (e.g., 'gmail', 'pdf', 'github', 'browser')",
        }),
        type: Type.Optional(
          Type.Union([Type.Literal("skill"), Type.Literal("mcp")], {
            description:
              'Filter by type: "skill" for ClawHub skills only, "mcp" for MCP servers only. Omit to search both.',
          })
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Maximum results to return (default 5, max 10)",
          })
        ),
      }),
      run: (args) => searchExtensions(gw, args),
    }),

    defineTool({
      name: "InstallExtension",
      description:
        "Generate a settings link that pre-fills one selected extension (skill or MCP server) for explicit user confirmation. Supports bundling extra env vars or nix packages into the same link.",
      parameters: Type.Object({
        id: Type.String({
          description:
            "Extension ID from SearchExtensions results (skill slug or MCP ID)",
        }),
        type: Type.Union([Type.Literal("skill"), Type.Literal("mcp")], {
          description: 'Extension type: "skill" or "mcp"',
        }),
        reason: Type.Optional(
          Type.String({
            description: "Optional user-facing reason for this installation",
          })
        ),
        envVars: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional environment variable names to bundle into the install link",
          })
        ),
        nixPackages: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional nix packages to bundle into the install link",
          })
        ),
      }),
      run: (args) => installExtension(gw, args),
    }),

    defineTool({
      name: "GetSettingsLink",
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
                Type.String({
                  description: "Display name for the MCP server",
                })
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
        prefillGrants: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional list of domain patterns to pre-fill as grants",
          })
        ),
      }),
      run: (args) => getSettingsLink(gw, args),
    }),

    defineTool({
      name: "GetSettingsLinkForDomain",
      description:
        "Shortcut to generate a settings link with domains pre-filled as grants. Use when a network request fails with 'Domain not allowed' to help the user approve the blocked domain.",
      parameters: Type.Object({
        reason: Type.String({
          description:
            "Brief explanation of why this domain is needed (e.g., 'access api.example.com to fetch data')",
        }),
        prefillGrants: Type.Array(Type.String(), {
          description: "Domain patterns to pre-fill as grants",
        }),
      }),
      run: (args) => getSettingsLink(gw, args),
    }),

    defineTool({
      name: "GenerateAudio",
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
      run: (args) => generateAudio(gw, args),
    }),

    defineTool({
      name: "GetChannelHistory",
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
      run: (args) => getChannelHistory(gw, args),
    }),

    defineTool({
      name: "AskUserQuestion",
      description:
        "Posts a question with button options to the user. Session ends after posting. The user's response will arrive as a new message in the next session.",
      parameters: Type.Object({
        question: Type.String({
          description: "The question to ask the user",
        }),
        options: Type.Array(Type.String(), {
          description: "Array of button labels for the user to choose from",
        }),
      }),
      run: (args) => askUserQuestion(gw, args),
    }),
  ];

  return tools;
}
