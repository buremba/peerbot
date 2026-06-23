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
  listConversations,
  logoutMcp,
  maybePostApprovalCard,
  readConversation,
  sendMessage,
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

/**
 * Declare a built-in gateway tool as `{ name, parameters, run }`. The shared
 * boilerplate — description lookup via getCustomToolDescription and the
 * defineTool result/type bridging — happens here, once.
 */
function createGatewayTool<T extends TSchema>(config: {
  name: string;
  parameters: T;
  run: (args: Static<T>) => Promise<TextResult>;
}): ToolDefinition {
  return defineTool({
    name: config.name,
    description: getCustomToolDescription(config.name),
    parameters: config.parameters,
    run: config.run,
  });
}

export function createOpenClawCustomTools(params: {
  gatewayUrl: string;
  workerToken: string;
  channelId: string;
  conversationId: string;
  platform?: string;
  /** Session workspace directory. Required — upload_file resolves relative paths against it. */
  workspaceDir: string;
  onCustomEvent?: (
    name: string,
    data: Record<string, unknown>
  ) => Promise<void> | void;
  /**
   * Invoked after ask_user successfully posts its question. The worker
   * wires this to force the agent turn to end immediately so a weak model can't
   * re-post the same question in a loop. Optional so non-worker callers (tests)
   * can omit it.
   */
  onAskUserPosted?: () => void;
}): ToolDefinition[] {
  const gw: GatewayParams = {
    gatewayUrl: params.gatewayUrl,
    workerToken: params.workerToken,
    channelId: params.channelId,
    conversationId: params.conversationId,
    // No silent default — tools that need the platform (get_channel_history)
    // fail loudly at the point of use instead of behaving as if on Slack.
    platform: params.platform,
    workspaceDir: params.workspaceDir,
  };

  const tools: ToolDefinition[] = [
    createGatewayTool({
      name: "upload_file",
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

    createGatewayTool({
      name: "generate_image",
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

    createGatewayTool({
      name: "generate_audio",
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

    createGatewayTool({
      name: "get_channel_history",
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

    createGatewayTool({
      name: "list_conversations",
      parameters: Type.Object({}),
      run: () => listConversations(gw),
    }),

    createGatewayTool({
      name: "read_conversation",
      parameters: Type.Object({
        target: Type.String({
          description:
            "Conversation handle from list_conversations (the channel to read)",
        }),
        limit: Type.Optional(
          Type.Number({
            description:
              "Number of most-recent messages to fetch (default 50, max 100)",
          })
        ),
      }),
      run: (args) => readConversation(gw, args),
    }),

    createGatewayTool({
      name: "send_message",
      parameters: Type.Object({
        target: Type.String({
          description:
            "Where to post: a conversation handle from list_conversations (posts to that channel), OR a thread handle returned by a previous send_message (replies in that thread)",
        }),
        text: Type.String({
          description: "The message text to post (markdown)",
        }),
      }),
      run: (args) => sendMessage(gw, args),
    }),

    createGatewayTool({
      name: "ask_user",
      parameters: Type.Object({
        question: Type.String({
          description: "The question to ask the user",
        }),
        options: Type.Array(Type.String(), {
          description: "Array of button labels for the user to choose from",
        }),
      }),
      run: (args) =>
        askUserQuestion(gw, args, { onPosted: params.onAskUserPosted }),
    }),
  ];

  return tools;
}

/**
 * Convert MCP tool definitions from session context into first-class
 * OpenClaw ToolDefinition objects that call the MCP proxy directly.
 * Tools are dynamically discovered from each MCP server (e.g. lobu).
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
        execute: async (_toolCallId, args) => {
          const result = await callMcpTool(
            gw,
            mcpId,
            def.name,
            (args || {}) as Record<string, unknown>
          );
          // Builder-gate bridge: a manage_agents write returns a
          // `pending_approval` result; forward it as a chat approval card so
          // the SPA renders the interactive diff. maybePostApprovalCard
          // swallows its own errors (returns false), so this never blocks or
          // alters the tool result the agent sees.
          const text = result.content?.[0]?.text;
          if (typeof text === "string") {
            await maybePostApprovalCard(gw, def.name, text);
          }
          return toToolResult(result);
        },
      });
    }
  }

  return tools;
}

/**
 * Spec table for the per-MCP auth tool trio (`<id>_login`, `<id>_login_check`,
 * `<id>_logout`). Order matters: tests and tool listings expect
 * login → login_check → logout.
 */
const MCP_AUTH_TOOL_SPECS: Array<{
  suffix: string;
  description: (mcpName: string) => string;
  run: (gw: GatewayParams, mcpId: string) => Promise<TextResult>;
}> = [
  {
    suffix: "_login",
    description: (mcpName) =>
      `Start the authentication flow for the ${mcpName} MCP. Use this when ${mcpName} requires login before its tools can be used.`,
    run: (gw, mcpId) => startMcpLogin(gw, { mcpId }),
  },
  {
    suffix: "_login_check",
    description: (mcpName) =>
      `Check whether authentication for the ${mcpName} MCP has completed. Call this after the user finishes login.`,
    run: (gw, mcpId) => checkMcpLogin(gw, { mcpId }),
  },
  {
    suffix: "_logout",
    description: (mcpName) =>
      `Remove the stored authentication credential for the ${mcpName} MCP.`,
    run: (gw, mcpId) => logoutMcp(gw, { mcpId }),
  },
];

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

    for (const spec of MCP_AUTH_TOOL_SPECS) {
      const toolName = `${mcp.id}${spec.suffix}`;
      if (existingToolNames.has(toolName)) {
        continue;
      }
      tools.push(
        defineTool({
          name: toolName,
          description: spec.description(mcp.name),
          parameters: Type.Object({}),
          run: () => spec.run(gw, mcp.id),
        })
      );
      existingToolNames.add(toolName);
    }
  }

  return tools;
}
