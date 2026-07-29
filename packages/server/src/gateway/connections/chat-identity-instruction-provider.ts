/**
 * Shared identity and participant framing for chat platforms.
 *
 * This is part of the cached gateway prefix. Keep it connection-scoped; sender,
 * channel, message, and session details belong in the per-turn run context.
 */
import { BaseInstructionProvider, type InstructionContext } from "@lobu/core";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";

const PLATFORM_LABELS: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  discord: "Discord",
  teams: "Microsoft Teams",
  gchat: "Google Chat",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export interface ChatBotIdentity {
  botUsername?: string;
  botUserId?: string;
}

export class ChatIdentityInstructionProvider extends BaseInstructionProvider {
  // Widened to `string` deliberately: an inferred literal type would make the
  // property invariant and block a subclass from naming itself.
  readonly name: string = "chat-identity";
  readonly priority = 20;

  constructor(
    protected readonly manager: ChatInstanceManager,
    protected readonly platform: string
  ) {
    super();
  }

  protected async resolveIdentity(
    context: InstructionContext
  ): Promise<ChatBotIdentity | null> {
    const { organizationId, connectionId } = context;
    if (!organizationId || !connectionId) return null;
    const connection = await orgContext.run(
      { organizationId },
      () => this.manager.getConnection(connectionId)
    );
    if (!connection) return null;

    const botUsername = connection.metadata?.botUsername;
    const botUserId = connection.metadata?.botUserId;
    return {
      ...(typeof botUsername === "string" && botUsername
        ? { botUsername }
        : {}),
      ...(typeof botUserId === "string" && botUserId ? { botUserId } : {}),
    };
  }

  protected async buildInstructions(
    context: InstructionContext
  ): Promise<string> {
    const identity = await this.resolveIdentity(context);
    return this.renderIdentity(identity ?? {});
  }

  protected renderIdentity(identity: ChatBotIdentity): string {
    const label = platformLabel(this.platform);
    const lines: string[] = [`**${label} identity:**`];

    if (identity.botUsername && identity.botUserId) {
      lines.push(
        `- You are reachable in ${label} as \`@${identity.botUsername}\` (user ID \`${identity.botUserId}\`).`
      );
    } else if (identity.botUsername) {
      lines.push(
        `- You are reachable in ${label} as \`@${identity.botUsername}\`.`
      );
    } else if (identity.botUserId) {
      lines.push(`- Your ${label} user ID is \`${identity.botUserId}\`.`);
    } else {
      lines.push(`- You are reachable in this ${label} conversation.`);
    }

    lines.push(
      "- You are a participant in this conversation, not an outside observer.",
      '- Reply directly to the people in this conversation. Address them as "you" rather than describing them in the third person, and do not ask an unseen operator how to respond.'
    );

    return lines.join("\n");
  }
}
