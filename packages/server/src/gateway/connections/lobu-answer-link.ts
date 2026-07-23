/**
 * Chat→Lobu answer footer: a `View in Lobu ↗` link appended to a completed
 * answer, pointing at the conversation's read-only transcript page in the web
 * app (`/{ownerSlug}/agents/{agentId}/conversations/{conversationId}`).
 *
 * The conversation page is keyed by `conversationId` — already present on every
 * `ThreadResponsePayload` — so the footer needs no run/feed id plumbing. It
 * fails soft: any missing piece (org slug, agent id, conversation id, public
 * origin) yields `undefined` and the answer is delivered without a footer.
 */

import {
  buildAgentConversationUrl,
  getOrganizationSlug,
} from "../../utils/url-builder.js";

const LOBU_FOOTER_LABEL = "View in Lobu ↗";

/**
 * Resolve the conversation-page URL for the footer, or `undefined` when any
 * required piece is missing. Never throws.
 */
export async function buildConversationFooterUrl(args: {
  organizationId: string | undefined;
  agentId: string | undefined;
  conversationId: string | undefined;
  publicGatewayUrl: string | undefined;
}): Promise<string | undefined> {
  const { organizationId, agentId, conversationId, publicGatewayUrl } = args;
  if (!organizationId || !agentId || !conversationId || !publicGatewayUrl) {
    return undefined;
  }

  const ownerSlug = await getOrganizationSlug(organizationId).catch(() => null);
  if (!ownerSlug) return undefined;

  return buildAgentConversationUrl(
    ownerSlug,
    agentId,
    conversationId,
    publicGatewayUrl
  );
}

/**
 * Append the footer markdown link to a body exactly once. A body that already
 * carries the exact link is returned unchanged, guarding against double-append
 * on a redelivered completion.
 */
export function appendMarkdownFooter(body: string, url: string): string {
  const trimmed = body.replace(/\s+$/, "");
  const link = `[${LOBU_FOOTER_LABEL}](${url})`;
  if (trimmed.includes(link)) return trimmed;
  return trimmed ? `${trimmed}\n\n${link}` : link;
}
