import {
  assertPluginManifest,
  type AgentEndEvent,
  type AfterToolCallEvent,
  type BeforeAgentStartEvent,
  type LobuPlugin,
  type PluginRuntimeContext,
  type ToolCallEvent,
} from "@lobu/plugin-api";

export class PluginHost<TTool = never> {
  readonly plugins: readonly LobuPlugin<TTool>[];

  constructor(plugins: readonly LobuPlugin<TTool>[]) {
    const names = new Set<string>();
    for (const plugin of plugins) {
      assertPluginManifest(plugin.manifest);
      if (names.has(plugin.manifest.name)) {
        throw new Error(`Duplicate Lobu plugin: ${plugin.manifest.name}`);
      }
      names.add(plugin.manifest.name);
    }
    this.plugins = [...plugins];
  }

  async tools(context: PluginRuntimeContext): Promise<TTool[]> {
    const tools: TTool[] = [];
    const names = new Set<string>();
    for (const plugin of this.plugins) {
      if (!plugin.tools) continue;
      for (const tool of await plugin.tools(context)) {
        const name = contributionName(tool);
        if (name && names.has(name)) {
          throw new Error(`Duplicate Lobu plugin tool: ${name}`);
        }
        if (name) names.add(name);
        tools.push(tool);
      }
    }
    return tools;
  }

  async beforeAgentStart(
    event: BeforeAgentStartEvent,
    context: PluginRuntimeContext
  ): Promise<string[]> {
    const prependContext: string[] = [];
    for (const plugin of this.plugins) {
      const result = await plugin.hooks?.beforeAgentStart?.(event, context);
      const value = result?.prependContext?.trim();
      if (value) prependContext.push(value);
    }
    return prependContext;
  }

  async beforeToolCall(
    event: ToolCallEvent,
    context: PluginRuntimeContext
  ): Promise<{ params: Record<string, unknown>; blockReason?: string }> {
    let params = { ...event.params };
    for (const plugin of this.plugins) {
      const hook = plugin.hooks?.beforeToolCall;
      if (!hook) continue;
      let result;
      try {
        result = await hook({ ...event, params }, context);
      } catch (error) {
        return {
          params,
          blockReason: `Plugin ${plugin.manifest.name} failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (result?.params) params = { ...params, ...result.params };
      if (result?.block) {
        return {
          params,
          blockReason:
            result.blockReason?.trim() ||
            `Blocked by plugin ${plugin.manifest.name}`,
        };
      }
    }
    return { params };
  }

  async afterToolCall(
    event: AfterToolCallEvent,
    context: PluginRuntimeContext
  ): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.hooks?.afterToolCall?.(event, context);
      } catch (error) {
        context.logger.error("Plugin afterToolCall hook failed", {
          plugin: plugin.manifest.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async agentEnd(
    event: AgentEndEvent,
    context: PluginRuntimeContext
  ): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.hooks?.agentEnd?.(event, context);
      } catch (error) {
        context.logger.error("Plugin agentEnd hook failed", {
          plugin: plugin.manifest.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function contributionName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const contribution = value as { id?: unknown; name?: unknown };
  if (typeof contribution.name === "string" && contribution.name) {
    return contribution.name;
  }
  return typeof contribution.id === "string" && contribution.id
    ? contribution.id
    : undefined;
}
