import { getCustomToolDescription, type McpToolDef } from "@lobu/core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { type TSchema, Type } from "@sinclair/typebox";
import type { GatewayParams, TextResult } from "../shared/tool-implementations";
import {
  askUserQuestion,
  callMcpTool,
  checkMcpLogin,
  generateAudio,
  generateImage,
  getChannelHistory,
  logoutMcp,
  startMcpLogin,
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
  /** Session workspace directory. Required — UploadUserFile resolves relative paths against it. */
  workspaceDir: string;
  onCustomEvent?: (
    name: string,
    data: Record<string, unknown>
  ) => Promise<void> | void;
}): ToolDefinition[] {
  const gw: GatewayParams = {
    gatewayUrl: params.gatewayUrl,
    workerToken: params.workerToken,
    channelId: params.channelId,
    conversationId: params.conversationId,
    platform: params.platform || "slack",
    workspaceDir: params.workspaceDir,
  };

  const tools: ToolDefinition[] = [
    defineTool({
      name: "UploadUserFile",
      description: getCustomToolDescription("UploadUserFile"),
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
      run: (args) =>
        uploadUserFile(gw, args, {
          onUploaded: (data) => params.onCustomEvent?.("file-uploaded", data),
        }),
    }),

    defineTool({
      name: "GenerateImage",
      description: getCustomToolDescription("GenerateImage"),
      parameters: Type.Object({
        prompt: Type.String({
          description: "The image prompt to generate",
        }),
        size: Type.Optional(
          Type.Union(
            [
              Type.Literal("1024x1024"),
              Type.Literal("1024x1536"),
              Type.Literal("1536x1024"),
              Type.Literal("auto"),
            ],
            {
              description: "Output image size (default: 1024x1024)",
            }
          )
        ),
        quality: Type.Optional(
          Type.Union(
            [
              Type.Literal("low"),
              Type.Literal("medium"),
              Type.Literal("high"),
              Type.Literal("auto"),
            ],
            {
              description: "Image quality (default: auto)",
            }
          )
        ),
        background: Type.Optional(
          Type.Union(
            [
              Type.Literal("transparent"),
              Type.Literal("opaque"),
              Type.Literal("auto"),
            ],
            {
              description: "Background style (default: auto)",
            }
          )
        ),
        format: Type.Optional(
          Type.Union(
            [Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")],
            {
              description: "Output image format (default: png)",
            }
          )
        ),
      }),
      run: (args) => generateImage(gw, args),
    }),

    defineTool({
      name: "GenerateAudio",
      description: getCustomToolDescription("GenerateAudio"),
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
      description: getCustomToolDescription("GetChannelHistory"),
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
      description: getCustomToolDescription("AskUserQuestion"),
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

/**
 * Convert MCP tool definitions from session context into first-class
 * OpenClaw ToolDefinition objects that call the MCP proxy directly.
 * Tools are dynamically discovered from each MCP server (e.g. owletto).
 */
export function createMcpToolDefinitions(
  mcpTools: Record<string, McpToolDef[]>,
  gw: GatewayParams,
  mcpContext?: Record<string, string>
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const [mcpId, defs] of Object.entries(mcpTools)) {
    const contextPrefix = mcpContext?.[mcpId];
    for (const def of defs) {
      if (!def.name || typeof def.name !== "string" || !def.name.trim()) {
        continue;
      }
      const schema = def.inputSchema
        ? Type.Unsafe(def.inputSchema)
        : Type.Object({});

      const baseDescription = def.description || `MCP tool from ${mcpId}`;
      const description = contextPrefix
        ? `[${contextPrefix}] ${baseDescription}`
        : baseDescription;

      tools.push({
        name: def.name,
        label: `${mcpId}/${def.name}`,
        description,
        parameters: schema,
        execute: async (_toolCallId, args) =>
          toToolResult(
            await callMcpTool(
              gw,
              mcpId,
              def.name,
              (args || {}) as Record<string, unknown>
            )
          ),
      });
    }
  }

  return tools;
}

export function createMcpAuthToolDefinitions(
  mcpStatus: Array<{
    id: string;
    name: string;
    requiresAuth: boolean;
    requiresInput?: boolean;
    authenticated?: boolean;
    configured?: boolean;
  }>,
  gw: GatewayParams,
  existingToolNames: Set<string> = new Set()
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const mcp of mcpStatus) {
    if (!mcp.requiresAuth) {
      continue;
    }

    const loginToolName = `${mcp.id}_login`;
    if (!existingToolNames.has(loginToolName)) {
      tools.push(
        defineTool({
          name: loginToolName,
          description: `Start the authentication flow for the ${mcp.name} MCP. Use this when ${mcp.name} requires login before its tools can be used.`,
          parameters: Type.Object({}),
          run: () => startMcpLogin(gw, { mcpId: mcp.id }),
        })
      );
      existingToolNames.add(loginToolName);
    }

    const checkToolName = `${mcp.id}_login_check`;
    if (!existingToolNames.has(checkToolName)) {
      tools.push(
        defineTool({
          name: checkToolName,
          description: `Check whether authentication for the ${mcp.name} MCP has completed. Call this after the user finishes login.`,
          parameters: Type.Object({}),
          run: () => checkMcpLogin(gw, { mcpId: mcp.id }),
        })
      );
      existingToolNames.add(checkToolName);
    }

    const logoutToolName = `${mcp.id}_logout`;
    if (!existingToolNames.has(logoutToolName)) {
      tools.push(
        defineTool({
          name: logoutToolName,
          description: `Remove the stored authentication credential for the ${mcp.name} MCP.`,
          parameters: Type.Object({}),
          run: () => logoutMcp(gw, { mcpId: mcp.id }),
        })
      );
      existingToolNames.add(logoutToolName);
    }
  }

  return tools;
}
