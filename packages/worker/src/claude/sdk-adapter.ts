#!/usr/bin/env bun

import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  createLogger,
  sanitizeForLogging,
  type ToolsConfig,
} from "@peerbot/core";
import type { InteractionClient } from "../common/interaction-client";
import type { ProgressCallback } from "../core/types";
import { ensureBaseUrl } from "../core/url-utils";
import { createCustomToolsServer } from "./custom-tools";
import { getSessionContext } from "./session-manager";

const logger = createLogger("claude-sdk");

/**
 * Type guard to check if object has setPermissionMode method
 */
function hasSetPermissionMode(
  obj: unknown
): obj is { setPermissionMode: (mode: string) => Promise<void> } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "setPermissionMode" in obj &&
    typeof (obj as any).setPermissionMode === "function"
  );
}

// ============================================================================
// TYPES
// ============================================================================

// Claude-specific execution options
export interface ClaudeExecutionOptions {
  allowedTools?: string | string[];
  disallowedTools?: string | string[];
  maxTurns?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  claudeEnv?: string;
  fallbackModel?: string;
  timeoutMinutes?: string | number;
  model?: string;
  continue?: boolean;
  /** Tool permission config from agent settings */
  toolsConfig?: ToolsConfig;
}

interface ClaudeExecutionResult {
  success: boolean;
  exitCode: number;
  output: string;
  error?: string;
}

const PLAN_APPROVAL_OPTIONS = [
  "Yes, bypass permissions",
  "Yes, approve each tool",
  "No, keep planning",
] as const;

const TOOL_APPROVAL_OPTIONS = [
  "Allow once",
  "Always allow this call",
  "Deny",
] as const;

// Auto-allow non-destructive tools and Task (for autonomous subagent delegation)
// Also auto-allow AskUserQuestion since it's specifically for asking the user questions
// File operations (Write, Edit) are safe in sandboxed environment
const DEFAULT_AUTO_ALLOW_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "BashOutput",
  "Task",
  "mcp__peerbot__AskUserQuestion",
  "mcp__peerbot__UploadUserFile",
  "mcp__peerbot__GetChannelHistory",
  "mcp__peerbot__ScheduleReminder",
];

/**
 * Check if a tool name matches a pattern (Claude Code compatible).
 * Supports:
 * - Exact match: "Read"
 * - Wildcard: "*" (matches all)
 * - Prefix wildcard: "mcp__github__*" (matches mcp__github__list_repos, etc.)
 * - Bash filter: "Bash(git:*)" (matches Bash with git commands)
 */
function matchesToolPattern(
  toolName: string,
  pattern: string,
  toolInput?: any
): boolean {
  // Exact match
  if (pattern === toolName) {
    return true;
  }

  // Wildcard - matches everything
  if (pattern === "*") {
    return true;
  }

  // Prefix wildcard: "mcp__github__*" matches "mcp__github__list_repos"
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    if (toolName.startsWith(prefix)) {
      return true;
    }
  }

  // Bash command filter: "Bash(git:*)" matches Bash tool with git commands
  const bashFilterMatch = pattern.match(/^Bash\(([^:]+):\*\)$/);
  if (bashFilterMatch && toolName === "Bash") {
    const commandPrefix = bashFilterMatch[1];
    // Check if the command starts with the prefix
    if (toolInput?.command && typeof toolInput.command === "string") {
      const command = toolInput.command.trim();
      return command.startsWith(commandPrefix);
    }
  }

  return false;
}

/**
 * Check if a tool is allowed by the given patterns.
 */
function isToolInPatterns(
  toolName: string,
  patterns: string[],
  toolInput?: any
): boolean {
  return patterns.some((pattern) =>
    matchesToolPattern(toolName, pattern, toolInput)
  );
}

// ============================================================================
// SDK EXECUTION
// ============================================================================

/**
 * Execute Claude session using the SDK
 */
export async function runClaudeWithSDK(
  userPrompt: string,
  options: ClaudeExecutionOptions,
  onProgress?: ProgressCallback,
  workingDirectory?: string,
  customToolsConfig?: {
    channelId: string;
    threadId: string;
    platform?: string;
    historyEnabled?: boolean;
  },
  interactionClient?: InteractionClient
): Promise<ClaudeExecutionResult> {
  logger.info("Starting Claude SDK execution");

  try {
    // Fetch session context (MCP config + gateway instructions) in a single request
    const { mcpServers, gatewayInstructions } = await getSessionContext();

    const normalizeToolList = (
      value?: string | string[]
    ): string[] | undefined => {
      if (!value) {
        return undefined;
      }

      const rawList = Array.isArray(value) ? value : value.split(/[,\n]/);

      const cleaned = rawList
        .map((entry) =>
          typeof entry === "string" ? entry.trim() : String(entry).trim()
        )
        .filter((entry) => entry.length > 0);

      if (cleaned.length === 0) {
        return undefined;
      }

      return Array.from(new Set(cleaned));
    };

    // Authentication flow:
    // 1. Worker sets ANTHROPIC_API_KEY to its worker token (not a real API key)
    // 2. Claude SDK sends worker token in x-api-key header to gateway
    // 3. Gateway proxy validates token, extracts userId, and swaps with real API key
    // 4. Gateway forwards request to Anthropic with real credentials
    const workerToken = process.env.WORKER_TOKEN;
    const dispatcherUrl = process.env.DISPATCHER_URL;

    if (!workerToken) {
      throw new Error("WORKER_TOKEN is required for Claude SDK authentication");
    }

    // Track errors from stderr
    let stderrError: Error | null = null;

    // Store query reference for dynamic permission mode changes
    // Type as unknown and use type guards for safety
    let queryReference: unknown = null;

    // Track when we're waiting for user interaction to suppress heartbeat
    let isWaitingForInteraction = false;

    const sdkOptions: SDKOptions = {
      model: options.model,
      cwd: workingDirectory || process.cwd(),
      permissionMode: "default", // Normal execution mode - tools run with canUseTool callback
      strictMcpConfig: false, // Allow MCP failures without stopping execution
      env: {
        ...process.env,
        DEBUG: "0", // Disable debug mode for Claude CLI (reduces noise in logs)
        // Use worker token as API key - SDK will send this in x-api-key header
        ANTHROPIC_API_KEY: workerToken,
        // Proxy all Anthropic API requests through gateway
        ...(dispatcherUrl
          ? {
              ANTHROPIC_BASE_URL: `${ensureBaseUrl(dispatcherUrl)}/api/anthropic`,
            }
          : {}),
      },
      stderr: (message: string) => {
        logger.error(`[Claude CLI stderr] ${message}`);
      },
    };

    // Add session management
    if (options.continue) {
      sdkOptions.continue = true;
      logger.info("Continuing most recent Claude session");
    }

    // Add system prompts
    // Merge gateway instructions (platform + MCP) with worker instructions
    const instructionParts = [
      gatewayInstructions, // From gateway (platform + MCP built from status)
      options.appendSystemPrompt, // From worker (core + projects + process manager)
    ];

    // Add history hint if enabled
    if (customToolsConfig?.historyEnabled) {
      instructionParts.push(`## Conversation History

You have access to GetChannelHistory to view previous messages in this thread.
Use it when the user references past discussions or you need context.`);
    }

    const mergedInstructions = instructionParts.filter(Boolean).join("\n\n");

    if (mergedInstructions) {
      // Always use merged instructions if available (gateway + worker custom instructions)
      sdkOptions.systemPrompt = mergedInstructions;
      logger.info(
        `Using merged instructions: gateway (${gatewayInstructions.length} chars) + worker (${options.appendSystemPrompt?.length || 0} chars)`
      );
    } else if (options.systemPrompt) {
      // Fallback to options.systemPrompt if no merged instructions
      sdkOptions.systemPrompt = options.systemPrompt;
    }

    // Add MCP servers (merge gateway MCP servers with custom tools)
    const allMcpServers = { ...mcpServers };

    // Add custom tools server if config provided
    if (customToolsConfig && dispatcherUrl && workerToken) {
      const customTools = createCustomToolsServer(
        dispatcherUrl,
        workerToken,
        customToolsConfig.channelId,
        customToolsConfig.threadId,
        interactionClient,
        {
          platform: customToolsConfig.platform,
          historyEnabled: customToolsConfig.historyEnabled,
        }
      );
      allMcpServers.peerbot = customTools;
      const tools = ["UploadUserFile", "AskUserQuestion"];
      if (customToolsConfig.historyEnabled) {
        tools.push("GetChannelHistory");
      }
      logger.info(
        `Added custom tools server: peerbot (tools: ${tools.join(", ")})`
      );

      // Note: We don't add interaction tools MCP server anymore
      // Interactions are handled via canUseTool callback below
    }

    if (Object.keys(allMcpServers).length > 0) {
      sdkOptions.mcpServers = allMcpServers;
      logger.info(
        `MCP servers configured: ${Object.keys(allMcpServers).join(", ")}`
      );
    }

    // Implement canUseTool callback to integrate with SDK permission system
    if (
      customToolsConfig &&
      dispatcherUrl &&
      workerToken &&
      interactionClient
    ) {
      const client = interactionClient;

      // Track if user approved plan with bypass permissions
      let bypassToolApprovals = false;

      sdkOptions.canUseTool = async (toolName: string, input: any) => {
        logger.info(`Permission check for tool: ${toolName}`);

        // Handle ExitPlanMode specially - this means Claude wants to exit plan mode and start executing
        if (toolName === "ExitPlanMode") {
          logger.info(
            "Claude wants to exit plan mode - asking user for approval"
          );

          try {
            isWaitingForInteraction = true;
            const planResponse = await client.askUser({
              interactionType: "plan_approval",
              question: `Claude has finished planning and wants to start executing. Would you like to proceed?\n\n${input?.plan || "Claude is ready to execute the plan."}`,
              options: PLAN_APPROVAL_OPTIONS as any,
              metadata: {
                plan: input?.plan,
              },
            });

            if (planResponse.answer === PLAN_APPROVAL_OPTIONS[0]) {
              logger.info(
                "✅ User approved plan with bypass permissions - exiting plan mode"
              );
              // Set flag to bypass all subsequent tool approvals
              bypassToolApprovals = true;
              // Change permission mode to default to exit plan mode
              if (hasSetPermissionMode(queryReference)) {
                await queryReference.setPermissionMode("default");
                logger.info(
                  "🔓 Exited plan mode - tools will execute without approval (bypass enabled)"
                );
              } else {
                logger.warn(
                  "Query reference does not support setPermissionMode"
                );
              }
              return {
                behavior: "allow" as const,
                updatedInput: input,
              };
            } else if (planResponse.answer === PLAN_APPROVAL_OPTIONS[1]) {
              logger.info(
                "✅ User approved plan with manual approvals - exiting plan mode"
              );
              // Change permission mode to default (will use canUseTool for each tool)
              if (hasSetPermissionMode(queryReference)) {
                await queryReference.setPermissionMode("default");
                logger.info(
                  "🔐 Permission mode changed to default - will prompt for each tool"
                );
              } else {
                logger.warn(
                  "Query reference does not support setPermissionMode"
                );
              }
              return {
                behavior: "allow" as const,
                updatedInput: input,
              };
            } else {
              logger.info("❌ User rejected plan - staying in plan mode");
              return {
                behavior: "deny" as const,
                message: "User chose to stay in plan mode",
                interrupt: false, // Don't interrupt, just stay in plan mode
              };
            }
          } catch (error) {
            logger.error(`Error getting plan approval: ${error}`);
            return {
              behavior: "deny" as const,
              message: `Failed to get plan approval: ${error instanceof Error ? error.message : String(error)}`,
              interrupt: true,
            };
          } finally {
            isWaitingForInteraction = false;
          }
        }

        // If user approved with bypass permissions, auto-allow all tools
        if (bypassToolApprovals) {
          logger.info(
            `Auto-allowing tool ${toolName} (bypass permissions enabled)`
          );
          return {
            behavior: "allow" as const,
            updatedInput: input,
          };
        }

        // Tool permission check with toolsConfig support
        const toolsConfig = options.toolsConfig;

        // 1. Check deniedTools first (takes precedence)
        if (
          toolsConfig?.deniedTools &&
          isToolInPatterns(toolName, toolsConfig.deniedTools, input)
        ) {
          logger.info(`Tool ${toolName} denied by toolsConfig.deniedTools`);
          return {
            behavior: "deny" as const,
            message: "Tool is blocked by agent settings",
            interrupt: false, // Don't interrupt, just deny this specific call
          };
        }

        // 2. Check allowedTools
        if (
          toolsConfig?.allowedTools &&
          isToolInPatterns(toolName, toolsConfig.allowedTools, input)
        ) {
          logger.info(
            `Auto-allowing tool ${toolName} by toolsConfig.allowedTools`
          );
          return {
            behavior: "allow" as const,
            updatedInput: input,
          };
        }

        // 3. If strictMode, only allowedTools are permitted (skip defaults)
        if (toolsConfig?.strictMode) {
          logger.info(
            `Tool ${toolName} not in allowedTools (strictMode enabled)`
          );
          return {
            behavior: "deny" as const,
            message: "Tool not in allowed list (strict mode)",
            interrupt: false,
          };
        }

        // 4. Fall back to default auto-allow list
        if (isToolInPatterns(toolName, DEFAULT_AUTO_ALLOW_TOOLS, input)) {
          logger.info(`Auto-allowing non-destructive tool: ${toolName}`);
          return {
            behavior: "allow" as const,
            updatedInput: input,
          };
        }

        // For other tools, ask the user via our interaction system
        logger.info(`Tool ${toolName} requires user approval`);

        try {
          isWaitingForInteraction = true;

          // Format tool input for display
          let inputSummary = "";
          if (input) {
            if (typeof input === "string") {
              inputSummary = input;
            } else if (input.command) {
              // Bash tool
              inputSummary = `\`${input.command}\``;
            } else if (input.file_path) {
              // File operations
              inputSummary = input.file_path;
            } else {
              // Generic JSON display
              inputSummary = JSON.stringify(input, null, 2);
            }
          }

          const toolResponse = await client.askUser({
            interactionType: "tool_approval",
            question: `Claude wants to execute \`${toolName}\`:\n${inputSummary}\n\nAllow this?`,
            options: TOOL_APPROVAL_OPTIONS as any,
            metadata: {
              toolName,
              toolInput: input,
            },
          });

          const approved =
            toolResponse.answer === TOOL_APPROVAL_OPTIONS[0] ||
            toolResponse.answer === TOOL_APPROVAL_OPTIONS[1];

          if (approved) {
            logger.info(`User approved ${toolName}`);
            return {
              behavior: "allow" as const,
              updatedInput: input,
            };
          } else {
            logger.info(`User denied ${toolName}`);
            return {
              behavior: "deny" as const,
              message: "User denied permission to execute this tool",
              interrupt: true,
            };
          }
        } catch (error) {
          logger.error(`Error getting user permission: ${error}`);
          return {
            behavior: "deny" as const,
            message: `Failed to get user permission: ${error instanceof Error ? error.message : String(error)}`,
            interrupt: true,
          };
        } finally {
          isWaitingForInteraction = false;
        }
      };
      logger.info("canUseTool callback configured");
    }

    // Add tool restrictions
    const allowedTools = normalizeToolList(options.allowedTools);
    if (allowedTools) {
      sdkOptions.allowedTools = allowedTools;
    }

    const disallowedTools = normalizeToolList(options.disallowedTools);
    if (disallowedTools) {
      sdkOptions.disallowedTools = disallowedTools;
    }

    // Add max turns
    if (options.maxTurns) {
      const maxTurnsNum = parseInt(options.maxTurns, 10);
      if (!Number.isNaN(maxTurnsNum) && maxTurnsNum > 0) {
        sdkOptions.maxTurns = maxTurnsNum;
      }
    }

    logger.info(
      `SDK options: ${JSON.stringify(sanitizeForLogging(sdkOptions), null, 2)}`
    );

    // Log query start with key parameters for troubleshooting
    const queryStartTime = Date.now();
    logger.info(
      `🚀 Starting Claude query - model: ${options.model}, permissionMode: ${sdkOptions.permissionMode}, promptLength: ${userPrompt.length} chars`
    );

    // Execute query
    const queryResult = query({
      prompt: userPrompt,
      options: sdkOptions,
    });

    // Store query reference for dynamic permission mode changes
    queryReference = queryResult;
    const response = queryResult;

    let output = "";
    let capturedSessionId: string | undefined;
    let messageCount = 0;
    let lastMessageTime = Date.now();
    let hasSuccessfulResult = false;
    let firstMessageTime: number | null = null;

    // Setup heartbeat to keep connection alive during long API calls
    const HEARTBEAT_INTERVAL_MS = 20000; // Send heartbeat every 20 seconds
    let heartbeatTimer: Timer | null = null;
    let elapsedTime = 0;
    let lastHeartbeatTime = Date.now();

    const sendHeartbeat = async () => {
      // Don't send heartbeat if we're waiting for user interaction
      if (isWaitingForInteraction) {
        logger.debug("Suppressing heartbeat - waiting for user interaction");
        return;
      }

      const now = Date.now();
      elapsedTime += now - lastHeartbeatTime;
      lastHeartbeatTime = now;
      const seconds = Math.floor(elapsedTime / 1000);

      logger.warn(
        `⏳ Still is running after ${seconds}s - no response from Claude API yet (messageCount: ${messageCount}, lastType: ${messageCount > 0 ? "message" : "none"})`
      );

      // Send status update to gateway to update the "is running" indicator with elapsed time
      if (onProgress) {
        await onProgress({
          type: "status_update",
          data: {
            elapsedSeconds: seconds,
            state: "is running..",
          } as any,
          timestamp: Date.now(),
        });
      }
    };

    // Process streaming responses with timeout check
    const messageIterator = response[Symbol.asyncIterator]();
    let iteratorDone = false;

    try {
      // Start heartbeat timer once for the entire query
      heartbeatTimer = setInterval(() => {
        sendHeartbeat().catch((err) => {
          logger.error("Failed to send heartbeat:", err);
        });
      }, HEARTBEAT_INTERVAL_MS);

      while (!iteratorDone) {
        // Don't check for stderr errors here - we need to process all messages first
        // Errors will be checked after the loop completes

        const messagePromise = messageIterator.next();
        const result = await messagePromise;

        if (result.done) {
          iteratorDone = true;
          break;
        }

        const message = result.value;

        messageCount++;
        const now = Date.now();
        const timeSinceLastMessage = now - lastMessageTime;
        lastMessageTime = now;

        // Track first message timing to measure API response time
        if (!firstMessageTime) {
          firstMessageTime = now;
          const timeToFirstMessage = now - queryStartTime;
          logger.info(
            `⚡ First message received after ${timeToFirstMessage}ms - type: ${message.type}`
          );
        }

        logger.info(
          `SDK message #${messageCount} (${timeSinceLastMessage}ms since last): ${message.type}`,
          {
            messageType: message.type,
            subtype: "subtype" in message ? message.subtype : undefined,
            timeSinceLastMessage,
          }
        );

        // Send progress updates
        if (onProgress) {
          await onProgress({
            type: "output",
            data: message,
            timestamp: Date.now(),
          });
        }

        // Handle different message types
        switch (message.type) {
          case "system":
            if (message.subtype === "init") {
              capturedSessionId = message.session_id;
              logger.info(`SDK session started: ${capturedSessionId}`);
            }
            logger.info(`System message subtype: ${message.subtype}`, {
              subtype: message.subtype,
              sessionId: message.session_id,
            });
            break;

          case "assistant": {
            const assistantMsg = message.message;
            if (assistantMsg && Array.isArray(assistantMsg.content)) {
              logger.info(
                `Assistant message (${assistantMsg.content.length} blocks)`
              );

              for (const block of assistantMsg.content) {
                if (block.type === "text" && block.text) {
                  logger.info(`  Text block: ${block.text.substring(0, 100)}`);
                  output += `${block.text}\n`;
                } else if (block.type === "tool_use") {
                  logger.info(
                    `🔧 Tool use: ${block.name} with params: ${JSON.stringify(block.input)}`
                  );
                }
              }
            } else {
              logger.warn(`Unexpected assistant message structure`, {
                hasMessage: "message" in message,
                messageType: typeof message.message,
              });
            }
            break;
          }

          case "result": {
            if (message.subtype === "success" && "result" in message) {
              const resultStr = String(message.result);
              logger.info(
                `SDK result received (${resultStr.length} chars): ${resultStr.substring(0, 200)}`
              );
              output = resultStr;
              hasSuccessfulResult = true;
              // Clear any stderr errors since we got a successful result
              // (Claude CLI may log post-completion errors like metrics opt-out checks)
              stderrError = null;
            } else {
              logger.warn(
                `Result message without success: ${message.subtype}`,
                {
                  subtype: message.subtype,
                  isError: message.is_error,
                }
              );
            }
            break;
          }

          case "stream_event":
            logger.debug(`Stream event received`);
            break;

          case "user": {
            const userMsg = message.message;
            if (userMsg?.content?.[0]?.type === "tool_result") {
              logger.debug(`Tool result returned to Claude`);
            }
            break;
          }
        }
      }
    } finally {
      // Always clear heartbeat timer when query completes or errors
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        logger.debug("Heartbeat timer cleared");
      }
    }

    // Final check for stderr errors after loop completes
    // Skip if we already received a successful result (post-completion errors are benign)
    if (stderrError && !hasSuccessfulResult) {
      logger.error("Error detected in stderr after message loop completed");
      throw stderrError;
    } else if (stderrError && hasSuccessfulResult) {
      logger.info(
        "Ignoring post-completion stderr error (session completed successfully)"
      );
    }

    logger.info(
      `Claude SDK execution completed successfully (${messageCount} messages received, final output: ${output.length} chars)`
    );

    // Call completion callback
    if (onProgress) {
      await onProgress({
        type: "completion",
        data: { success: true, sessionId: capturedSessionId },
        timestamp: Date.now(),
      });
    }

    return {
      success: true,
      exitCode: 0,
      output: output.trim(),
    };
  } catch (error) {
    logger.error("Claude SDK execution failed:", {
      error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      errorType: error?.constructor?.name,
      errorKeys:
        error && typeof error === "object" ? Object.keys(error) : undefined,
    });

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Call error callback
    if (onProgress) {
      await onProgress({
        type: "error",
        data: { error: errorMessage },
        timestamp: Date.now(),
      });
    }

    return {
      success: false,
      exitCode: 1,
      output: "",
      error: errorMessage,
    };
  }
}
