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
  /** Slack workspace subdomain, when known (e.g. "acme" for acme.slack.com). */
  slackDomain?: string;
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
      if (/^-100\d+$/.test(rawChannel)) {
        return `https://t.me/c/${rawChannel.slice(4)}/${input.messageId}`;
      }
      return undefined;
    }
    case "slack": {
      // Slack archive URLs are subdomain-scoped: without the workspace domain
      // the link can't be built correctly (the team id `Txxx` is not the
      // subdomain). Only emit when the domain is known.
      if (!input.slackDomain) return undefined;
      const ts = input.messageId.replace(".", "");
      return `https://${input.slackDomain}.slack.com/archives/${rawChannel}/p${ts}`;
    }
    default:
      // discord/whatsapp/teams/gchat/api: no stable inbound permalink here.
      return undefined;
  }
}
