/**
 * OpenClaw Channel Plugin → Lobu PlatformAdapter
 *
 * Wraps an OpenClaw channel plugin as a Lobu PlatformAdapter so it can
 * be registered with the gateway and participate in message routing.
 */

import {
  createLogger,
  type LoadedPlugin,
  type OpenClawChannelDef,
  type ThreadResponsePayload,
} from "@lobu/core";
import type { CoreServices, PlatformAdapter } from "../platform";
import type { ResponseRenderer } from "../platform/response-renderer";

const logger = createLogger("channel-adapter");

/**
 * ResponseRenderer for OpenClaw channel plugins.
 * Converts Lobu ThreadResponsePayload into channel outbound calls.
 */
class PluginChannelResponseRenderer implements ResponseRenderer {
  private channelDef: OpenClawChannelDef;
  private messageBuffers = new Map<string, string>();

  constructor(channelDef: OpenClawChannelDef) {
    this.channelDef = channelDef;
  }

  async handleDelta(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<string | null> {
    const key = `${payload.channelId}:${payload.conversationId}`;

    if (payload.isFullReplacement) {
      this.messageBuffers.set(key, payload.delta || "");
    } else {
      const existing = this.messageBuffers.get(key) || "";
      this.messageBuffers.set(key, existing + (payload.delta || ""));
    }

    // Deliver current buffer
    const text = this.messageBuffers.get(key) || "";
    try {
      await this.channelDef.outbound.sendText({
        text,
        channelId: payload.channelId,
        conversationId: payload.conversationId,
      });
    } catch (error) {
      logger.error(`[channel:${this.channelDef.id}] Failed to send delta:`, {
        error,
      });
    }

    return null;
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const key = `${payload.channelId}:${payload.conversationId}`;
    const finalText = this.messageBuffers.get(key);

    if (finalText) {
      try {
        await this.channelDef.outbound.sendText({
          text: finalText,
          channelId: payload.channelId,
          conversationId: payload.conversationId,
          isFinal: true,
        });
      } catch (error) {
        logger.error(
          `[channel:${this.channelDef.id}] Failed to send completion:`,
          { error }
        );
      }
    }

    this.messageBuffers.delete(key);
  }

  async handleError(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    try {
      await this.channelDef.outbound.sendText({
        text: `Error: ${payload.error || "Unknown error"}`,
        channelId: payload.channelId,
        conversationId: payload.conversationId,
      });
    } catch (error) {
      logger.error(`[channel:${this.channelDef.id}] Failed to send error:`, {
        error,
      });
    }

    const key = `${payload.channelId}:${payload.conversationId}`;
    this.messageBuffers.delete(key);
  }

  async handleStatusUpdate(_payload: ThreadResponsePayload): Promise<void> {
    // Status updates (heartbeats) -- plugins can show typing indicators here
    logger.debug(`[channel:${this.channelDef.id}] Status update (no-op)`);
  }

  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    try {
      await this.channelDef.outbound.sendText({
        text: payload.content || "",
        channelId: payload.channelId,
        conversationId: payload.conversationId,
        ephemeral: true,
      });
    } catch (error) {
      logger.error(
        `[channel:${this.channelDef.id}] Failed to send ephemeral:`,
        { error }
      );
    }
  }
}

/**
 * Wraps an OpenClaw channel plugin as a Lobu PlatformAdapter.
 */
export class PluginChannelAdapter implements PlatformAdapter {
  readonly name: string;
  private channelDef: OpenClawChannelDef;
  private plugin: LoadedPlugin;
  private responseRenderer: PluginChannelResponseRenderer;
  private running = false;

  constructor(plugin: LoadedPlugin, channelDef: OpenClawChannelDef) {
    this.plugin = plugin;
    this.channelDef = channelDef;
    this.name = channelDef.id;
    this.responseRenderer = new PluginChannelResponseRenderer(channelDef);
  }

  async initialize(_services: CoreServices): Promise<void> {
    logger.info(`[channel:${this.name}] Initialized with core services`);
  }

  async start(): Promise<void> {
    if (this.channelDef.startAccount) {
      const accountIds = this.channelDef.config.listAccountIds(
        this.plugin.config.config || {}
      );
      for (const accountId of accountIds) {
        try {
          await this.channelDef.startAccount(accountId);
          logger.info(`[channel:${this.name}] Started account: ${accountId}`);
        } catch (error) {
          logger.error(
            `[channel:${this.name}] Failed to start account ${accountId}:`,
            { error }
          );
        }
      }
    }
    this.running = true;
    logger.info(`[channel:${this.name}] Platform started`);
  }

  async stop(): Promise<void> {
    if (this.channelDef.stopAccount) {
      const accountIds = this.channelDef.config.listAccountIds(
        this.plugin.config.config || {}
      );
      for (const accountId of accountIds) {
        try {
          await this.channelDef.stopAccount(accountId);
        } catch (error) {
          logger.error(
            `[channel:${this.name}] Failed to stop account ${accountId}:`,
            { error }
          );
        }
      }
    }
    this.running = false;
    logger.info(`[channel:${this.name}] Platform stopped`);
  }

  isHealthy(): boolean {
    return this.running;
  }

  getResponseRenderer(): ResponseRenderer | undefined {
    return this.responseRenderer;
  }

  buildDeploymentMetadata(
    conversationId: string,
    channelId: string,
    _platformMetadata: Record<string, any>
  ): Record<string, string> {
    return {
      platform: this.name,
      channelId,
      conversationId,
    };
  }

  getDisplayInfo() {
    return {
      name: this.channelDef.meta.label,
      icon: "🔌",
    };
  }

  async sendMessage(
    _token: string,
    message: string,
    options: {
      agentId: string;
      channelId: string;
      conversationId?: string;
      teamId: string;
    }
  ): Promise<{ messageId: string }> {
    await this.channelDef.outbound.sendText({
      text: message,
      channelId: options.channelId,
      conversationId: options.conversationId,
    });
    return { messageId: `plugin-${Date.now()}` };
  }
}

/**
 * Create PlatformAdapters for all channel plugins.
 */
export function createChannelAdapters(
  plugins: LoadedPlugin[]
): PluginChannelAdapter[] {
  const adapters: PluginChannelAdapter[] = [];

  for (const plugin of plugins) {
    for (const channelDef of plugin.registrations.channels) {
      adapters.push(new PluginChannelAdapter(plugin, channelDef));
      logger.info(
        `Created channel adapter: ${channelDef.id} (${channelDef.meta.label})`
      );
    }
  }

  return adapters;
}
