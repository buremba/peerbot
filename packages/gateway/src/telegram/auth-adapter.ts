/**
 * Telegram Auth Adapter - Platform-specific authentication handling.
 * Sends settings link for authentication and configuration.
 */

import { createLogger } from "@lobu/core";
import type { Bot } from "grammy";
import type { AuthProvider, PlatformAuthAdapter } from "../auth/platform-auth";
import {
  buildSettingsUrl,
  formatSettingsTokenTtl,
  generateSettingsToken,
} from "../auth/settings/token-service";

const logger = createLogger("telegram-auth-adapter");

/**
 * Telegram-specific authentication adapter.
 * Sends a settings link where users can configure Claude auth, MCP, network, etc.
 */
export class TelegramAuthAdapter implements PlatformAuthAdapter {
  constructor(
    private bot: Bot,
    _publicGatewayUrl: string
  ) {}

  async sendAuthPrompt(
    userId: string,
    channelId: string,
    _conversationId: string,
    _providers: AuthProvider[],
    platformMetadata?: Record<string, unknown>
  ): Promise<void> {
    const chatId = Number(
      (platformMetadata?.chatId as string | number) || channelId
    );
    const agentId = (platformMetadata?.agentId as string) || channelId;

    const token = generateSettingsToken(agentId, userId, "telegram");
    const settingsUrl = buildSettingsUrl(token);
    const ttlLabel = formatSettingsTokenTtl();

    const message = [
      "<b>Setup Required</b>",
      "",
      "You need to add a model provider to use this bot.",
      "Configure it using this link:",
      "",
      settingsUrl,
      "",
      `<i>Link expires in ${ttlLabel}.</i>`,
    ].join("\n");

    try {
      await this.bot.api.sendMessage(chatId, message, {
        parse_mode: "HTML",
      });
      logger.info({ chatId, userId, agentId }, "Sent settings link");
    } catch (error) {
      logger.error({ error, chatId }, "Failed to send settings link");
      throw error;
    }
  }

  async sendAuthSuccess(
    userId: string,
    channelId: string,
    provider: AuthProvider
  ): Promise<void> {
    const chatId = Number(channelId);

    const message = [
      `<b>Authentication Successful!</b>`,
      "",
      `You're now connected to ${provider.name}.`,
      "",
      "Send your message again to continue.",
    ].join("\n");

    try {
      await this.bot.api.sendMessage(chatId, message, {
        parse_mode: "HTML",
      });
      logger.info(
        { channelId, userId, provider: provider.id },
        "Sent auth success message"
      );
    } catch (error) {
      logger.error({ error, channelId }, "Failed to send auth success message");
    }
  }

  async handleAuthResponse(
    _channelId: string,
    _userId: string,
    _text: string
  ): Promise<boolean> {
    return false;
  }

  hasPendingAuth(_channelId: string): boolean {
    return false;
  }
}
