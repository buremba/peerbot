/**
 * OpenClaw Plugin Bridge
 *
 * Bridges OpenClaw plugin registrations into the pi-coding-agent runtime:
 * - Tool plugins → ToolDefinition objects injected into createAgentSession
 * - Memory plugins → before_agent_start (recall) and agent_end (save) hooks
 * - Provider plugins → model registration (future)
 *
 * Channel plugins are handled gateway-side (see gateway/src/plugins/channel-adapter.ts).
 */

import {
  createLogger,
  type LoadedPlugin,
  type OpenClawToolDef,
} from "@lobu/core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const logger = createLogger("plugin-bridge");

// ============================================================================
// Tool Plugin Bridge
// ============================================================================

/**
 * Convert an OpenClaw tool definition to pi-coding-agent ToolDefinition format.
 */
function bridgeToolDef(
  pluginId: string,
  tool: OpenClawToolDef
): ToolDefinition {
  // Convert TypeBox schema or pass through
  const parameters = tool.parameters || Type.Object({});

  return {
    name: tool.name,
    label: tool.name,
    description: tool.description || `Tool from plugin ${pluginId}`,
    parameters: parameters as any,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      try {
        logger.info(`[plugin:${pluginId}] Executing tool: ${tool.name}`);
        const result = await tool.execute(toolCallId, params, signal);

        // Normalize result to AgentToolResult format
        const content = (result?.content || []).map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text };
          }
          return { type: "text" as const, text: JSON.stringify(block) };
        });

        if (content.length === 0) {
          content.push({
            type: "text" as const,
            text: "Tool executed successfully",
          });
        }

        return { content, details: {} };
      } catch (error) {
        logger.error(`[plugin:${pluginId}] Tool ${tool.name} failed:`, {
          error,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {},
        };
      }
    },
  };
}

/**
 * Extract all tool definitions from loaded plugins.
 * Returns ToolDefinition[] ready for createAgentSession({ customTools }).
 */
export function bridgePluginTools(plugins: LoadedPlugin[]): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const plugin of plugins) {
    for (const toolDef of plugin.registrations.tools) {
      tools.push(bridgeToolDef(plugin.manifest.id, toolDef));
    }
  }

  if (tools.length > 0) {
    logger.info(
      `Bridged ${tools.length} plugin tools: ${tools.map((t) => t.name).join(", ")}`
    );
  }

  return tools;
}

// ============================================================================
// Memory Plugin Bridge
// ============================================================================

/**
 * Memory plugin lifecycle hooks that integrate with the agent session.
 * Call recall() before prompting and save() after the agent responds.
 */
export interface MemoryHooks {
  /** Recall relevant memories before agent processes a message */
  recall(query: string): Promise<string>;
  /** Save conversation context after agent responds */
  save(content: string, metadata?: Record<string, unknown>): Promise<void>;
}

/**
 * Create memory hooks from a loaded memory plugin.
 * Returns null if no memory plugin is active.
 */
export function bridgeMemoryPlugin(
  plugins: LoadedPlugin[]
): MemoryHooks | null {
  const memoryPlugin = plugins.find((p) => p.registrations.slot === "memory");
  if (!memoryPlugin || !memoryPlugin.registrations.memory) {
    return null;
  }

  const pluginId = memoryPlugin.manifest.id;
  const memory = memoryPlugin.registrations.memory;

  logger.info(`Memory plugin active: ${pluginId}`);

  return {
    async recall(query: string): Promise<string> {
      try {
        // Try the recall method first (simple API)
        if (memory.recall) {
          const result = await memory.recall(query);
          logger.info(
            `[memory:${pluginId}] Recalled ${result.length} chars for query`
          );
          return result;
        }

        // Fall back to search method (full API)
        if (memory.search) {
          const results = await memory.search(query, {
            maxResults: 6,
            minScore: 0.35,
          });
          if (!results || results.length === 0) {
            return "";
          }

          const formatted = results
            .map((r, i) => {
              const score = r.score ? ` (${(r.score * 100).toFixed(0)}%)` : "";
              const source = r.path ? ` [${r.path}]` : "";
              return `${i + 1}. ${r.text}${score}${source}`;
            })
            .join("\n\n");

          logger.info(
            `[memory:${pluginId}] Found ${results.length} memories for query`
          );

          return `## Recalled Memories\n\n${formatted}`;
        }

        return "";
      } catch (error) {
        logger.error(`[memory:${pluginId}] Recall failed:`, { error });
        return "";
      }
    },

    async save(
      content: string,
      metadata?: Record<string, unknown>
    ): Promise<void> {
      try {
        if (memory.save) {
          await memory.save(content, metadata);
          logger.info(`[memory:${pluginId}] Saved ${content.length} chars`);
          return;
        }

        if (memory.indexChunk) {
          const timestamp = new Date().toISOString();
          await memory.indexChunk(
            `memory/${timestamp.split("T")[0]}.md`,
            content,
            metadata
          );
          logger.info(`[memory:${pluginId}] Indexed ${content.length} chars`);
        }
      } catch (error) {
        logger.error(`[memory:${pluginId}] Save failed:`, { error });
      }
    },
  };
}

// ============================================================================
// Provider Plugin Bridge
// ============================================================================

/**
 * Extract provider information from loaded plugins.
 * Returns model metadata that can be used for model selection.
 */
export function bridgeProviderPlugins(plugins: LoadedPlugin[]): Array<{
  pluginId: string;
  models: Array<{ id: string; name: string; api?: string }>;
}> {
  const providers: Array<{
    pluginId: string;
    models: Array<{ id: string; name: string; api?: string }>;
  }> = [];

  for (const plugin of plugins) {
    if (
      plugin.registrations.slot !== "provider" ||
      !plugin.registrations.provider
    ) {
      continue;
    }

    const provider = plugin.registrations.provider;
    if (provider.models && provider.models.length > 0) {
      providers.push({
        pluginId: plugin.manifest.id,
        models: provider.models,
      });
      logger.info(
        `Provider plugin ${plugin.manifest.id}: ${provider.models.length} models available`
      );
    }
  }

  return providers;
}

// ============================================================================
// Unified Bridge
// ============================================================================

/**
 * Bridge result containing all adapted plugin components.
 */
export interface PluginBridgeResult {
  /** Tool definitions for createAgentSession({ customTools }) */
  tools: ToolDefinition[];
  /** Memory hooks for recall/save lifecycle */
  memory: MemoryHooks | null;
  /** Provider model info */
  providers: Array<{
    pluginId: string;
    models: Array<{ id: string; name: string; api?: string }>;
  }>;
}

/**
 * Bridge all loaded plugins into worker-consumable components.
 */
export function bridgePlugins(plugins: LoadedPlugin[]): PluginBridgeResult {
  return {
    tools: bridgePluginTools(plugins),
    memory: bridgeMemoryPlugin(plugins),
    providers: bridgeProviderPlugins(plugins),
  };
}
