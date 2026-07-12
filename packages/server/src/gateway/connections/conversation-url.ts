/**
 * Build a link back to the originating conversation/message on the source
 * platform, for the inbound `platformMetadata.conversationUrl` the agent sees
 * in its per-run context.
 *
 * Only returns a URL when one can be constructed *correctly* from data already
 * in scope at inbound dispatch — never a best-guess URL that might 404. A
 * platform with no addressable per-message URL (or missing inputs) returns
 * undefined, and the agent simply omits the link line.
 */

import { stripPlatformPrefix } from "../channels/bound-channels.js";

export interface ConversationUrlInput {
  /** Chat platform id (e.g. "slack", "telegram"). */
  platform: string;
  /** Platform-prefixed channel/chat id (e.g. "slack:C0123", "telegram:-100…"). */
  channelId: string;
  /** Source message id (Slack `ts`, Telegram numeric message id). */
  messageId: string;
}

/**
 * @returns a permalink, or undefined when one isn't constructible for this
 * platform / with the inputs available.
 */
export function buildConversationUrl(
  input: ConversationUrlInput
): string | undefined {
  const rawChannel = stripPlatformPrefix(input.platform, input.channelId);
  if (!rawChannel || !input.messageId) return undefined;

  switch (input.platform) {
    case "telegram": {
      // Supergroups/channels use the -100-prefixed id; the public t.me link
      // drops that prefix. Private/basic chats have no shareable web URL.
      // Only numeric telegram message ids yield a valid link (synthetic ids
      // like "click-…" do not).
      if (/^-100\d+$/.test(rawChannel) && /^\d+$/.test(input.messageId)) {
        return `https://t.me/c/${rawChannel.slice(4)}/${input.messageId}`;
      }
      return undefined;
    }
    // Slack is intentionally NOT handled: a correct archives permalink is
    // subdomain-scoped (the team id `Txxx` is not the subdomain), and the
    // workspace domain is not resolved at inbound dispatch. Rather than emit a
    // guessed URL that 404s, we omit it. Add a `slack` case here once the
    // workspace domain (via team.info at connect time) is plumbed through.
    default:
      // slack/discord/whatsapp/teams/gchat/api: no stable inbound permalink.
      return undefined;
  }
}
