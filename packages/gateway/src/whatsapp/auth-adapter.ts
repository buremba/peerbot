/**
 * WhatsApp Auth Adapter - Platform-specific authentication handling.
 * Sends settings link for authentication and configuration.
 */

import { createLogger } from "@peerbot/core";
import type { AuthProvider, PlatformAuthAdapter } from "../auth/platform-auth";
import {
  buildSettingsUrl,
  generateSettingsToken,
} from "../auth/settings/token-service";
import type { BaileysClient } from "./connection/baileys-client";

const logger = createLogger("whatsapp-auth-adapter");

/**
 * WhatsApp-specific authentication adapter.
 * Sends a settings link where users can configure Claude auth, MCP, network, git, etc.
 */
export class WhatsAppAuthAdapter implements PlatformAuthAdapter {
  constructor(
    private client: BaileysClient,
    _publicGatewayUrl: string
  ) {}

  /**
   * Send authentication required prompt with settings link.
   * The settings page handles Claude OAuth, MCP config, network access, git, etc.
   */
  async sendAuthPrompt(
    userId: string,
    channelId: string,
    _threadId: string,
    _providers: AuthProvider[],
    platformMetadata?: Record<string, unknown>
  ): Promise<void> {
    const chatJid = (platformMetadata?.jid as string) || channelId;
    const agentId = (platformMetadata?.agentId as string) || channelId;

    // Generate settings token (1 hour TTL)
    const token = generateSettingsToken(agentId, userId, "whatsapp");
    const settingsUrl = buildSettingsUrl(token);

    const message = [
      "*Setup Required*",
      "",
      "Configure your bot using this link:",
      "",
      settingsUrl,
      "",
      "You can set up:",
      "- Claude authentication",
      "- MCP servers",
      "- Network access",
      "- Git repository",
      "- And more...",
      "",
      "_Link expires in 1 hour._",
    ].join("\n");

    try {
      await this.client.sendMessage(chatJid, { text: message });
      logger.info({ chatJid, userId, agentId }, "Sent settings link");
    } catch (error) {
      logger.error({ error, chatJid }, "Failed to send settings link");
      throw error;
    }
  }

  /**
   * Send authentication success message.
   */
  async sendAuthSuccess(
    userId: string,
    channelId: string,
    provider: AuthProvider
  ): Promise<void> {
    const message = [
      `*Authentication Successful!*`,
      "",
      `You're now connected to ${provider.name}.`,
      "",
      "Send your message again to continue.",
    ].join("\n");

    try {
      await this.client.sendMessage(channelId, { text: message });
      logger.info(
        { channelId, userId, provider: provider.id },
        "Sent auth success message"
      );
    } catch (error) {
      logger.error({ error, channelId }, "Failed to send auth success message");
    }
  }

  /**
   * No longer handling auth responses - settings page handles everything.
   */
  async handleAuthResponse(
    _channelId: string,
    _userId: string,
    _text: string
  ): Promise<boolean> {
    return false;
  }

  /**
   * No pending auth sessions anymore.
   */
  hasPendingAuth(_channelId: string): boolean {
    return false;
  }
}
