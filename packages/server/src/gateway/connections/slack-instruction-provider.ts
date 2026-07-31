import {
  type ChatBotIdentity,
  ChatIdentityInstructionProvider,
} from "./chat-identity-instruction-provider.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";

/** Adds Slack's mention encoding to the shared chat identity block. */
export class SlackInstructionProvider extends ChatIdentityInstructionProvider {
  override readonly name = "slack-identity";

  constructor(manager: ChatInstanceManager) {
    super(manager, "slack");
  }

  protected override renderIdentity(identity: ChatBotIdentity): string {
    const base = super.renderIdentity(identity);
    if (!identity.botUserId) return base;
    return `${base}\n- Mentions of \`<@${identity.botUserId}>\` (or the bare \`@${identity.botUserId}\`) refer to *you*; the gateway strips them before delivery, so anything you still see is incidental — do not treat your own ID as a stranger.`;
  }
}
