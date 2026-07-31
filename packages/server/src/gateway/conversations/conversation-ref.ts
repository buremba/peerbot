/**
 * Structural identity for a conversation reference.
 *
 * A conversation is addressed two different ways in this codebase and they
 * cannot be compared as strings:
 *
 *  - Inbound dispatch stamps a flat `conversationId` on the turn — either the
 *    channel id (`slack:D0123`) or the SDK thread id (`slack:C0123:1700.123`).
 *    A top-level DM can also arrive as `slack:D0123:` with an EMPTY trailing
 *    thread segment (see `message-handler-bridge`'s `isThreadReply` check),
 *    which denotes the channel, not a thread.
 *  - The conversation tools address a `channelKey` (`${platform}:${channelId}`)
 *    plus an optional resolved `threadId`, because the model only ever holds an
 *    opaque handle that the server re-resolves per call.
 *
 * Comparing the flat forms with `===` therefore reports a false mismatch for
 * the trailing-colon DM, and cannot compare the tool form at all. Parse both
 * into components and compare those.
 */

export interface ConversationRef {
  /** `${platform}:${channelId}` — the conversation's channel. */
  channelKey: string;
  /** Thread root within the channel; absent for a channel-level conversation. */
  threadId?: string;
}

/**
 * Parse a flat `conversationId` into its components.
 *
 * Returns `null` for anything without at least `platform:channelId`, so a
 * malformed or empty id can never accidentally compare equal to a real one.
 * An empty third segment (`slack:D0123:`) yields no `threadId` — that form
 * denotes the channel itself.
 */
export function parseConversationRef(
  conversationId: string | undefined
): ConversationRef | null {
  if (!conversationId) return null;
  const [platform, channelId, ...rest] = conversationId.split(":");
  if (!platform || !channelId) return null;
  const threadId = rest.join(":");
  return {
    channelKey: `${platform}:${channelId}`,
    ...(threadId ? { threadId } : {}),
  };
}

/** True when both references name the same channel AND the same thread scope. */
export function conversationRefsMatch(
  a: ConversationRef | null,
  b: ConversationRef | null
): boolean {
  if (!a || !b) return false;
  return a.channelKey === b.channelKey && a.threadId === b.threadId;
}
