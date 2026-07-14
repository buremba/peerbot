import {
  assertPluginManifest,
  type AgentEndEvent,
  type AfterToolCallEvent,
  type BeforeAgentStartEvent,
  type LobuPlugin,
  type PluginHostContext,
  type PluginRuntimeContext,
  type ToolCallEvent,
} from "@lobu/plugin-api";

export class PluginHost<TTool = never, TProvider = never> {
  readonly plugins: readonly LobuPlugin<TTool, TProvider>[];

  constructor(
    plugins: readonly LobuPlugin<TTool, TProvider>[],
    availableCapabilities: ReadonlySet<string>
  ) {
    const names = new Set<string>();
    for (const plugin of plugins) {
      assertPluginManifest(plugin.manifest);
      if (names.has(plugin.manifest.name)) {
        throw new Error(`Duplicate Lobu plugin: ${plugin.manifest.name}`);
      }
      names.add(plugin.manifest.name);
      const missing = (plugin.manifest.capabilities ?? []).filter(
        (capability) => !availableCapabilities.has(capability)
      );
      if (missing.length > 0) {
        throw new Error(
          `Plugin ${plugin.manifest.name} requires unavailable capabilities: ${missing.join(", ")}`
        );
      }
    }
    this.plugins = [...plugins].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name)
    );
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

  providers(): TProvider[] {
    const providers: TProvider[] = [];
    const names = new Set<string>();
    for (const plugin of this.plugins) {
      for (const provider of plugin.providers ?? []) {
        const name = contributionName(provider);
        if (name && names.has(name)) {
          throw new Error(`Duplicate Lobu plugin provider: ${name}`);
        }
        if (name) names.add(name);
        providers.push(provider);
      }
    }
    return providers;
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

  async start(context: PluginHostContext): Promise<void> {
    const started: Array<{
      plugin: LobuPlugin<TTool, TProvider>;
      service: NonNullable<LobuPlugin<TTool, TProvider>["services"]>[number];
    }> = [];
    const serviceIds = new Set<string>();
    try {
      for (const plugin of this.plugins) {
        for (const service of plugin.services ?? []) {
          if (serviceIds.has(service.id)) {
            throw new Error(`Duplicate Lobu plugin service: ${service.id}`);
          }
          serviceIds.add(service.id);
          await service.start(context);
          started.push({ plugin, service });
        }
      }
    } catch (error) {
      for (const { plugin, service } of started.reverse()) {
        try {
          await service.stop(context);
        } catch (stopError) {
          context.logger.error("Plugin service rollback failed", {
            plugin: plugin.manifest.name,
            service: service.id,
            error:
              stopError instanceof Error
                ? stopError.message
                : String(stopError),
          });
        }
      }
      throw error;
    }
  }

  async stop(context: PluginHostContext): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      for (const service of [...(plugin.services ?? [])].reverse()) {
        try {
          await service.stop(context);
        } catch (error) {
          context.logger.error("Plugin service stop failed", {
            plugin: plugin.manifest.name,
            service: service.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
