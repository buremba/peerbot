/**
 * Canonical base shape for messages and interaction events that flow between
 * the gateway and platform renderers.
 *
 * Concrete payload types (posted interactions, thread responses) extend this
 * interface and add their own specialised fields. Keeping the shared primitive
 * identifiers in one place eliminates the drift that happens when each call
 * site re-declares `conversationId`, `channelId`, etc. independently.
 *
 * Note: `userId` is intentionally NOT part of the base because some events
 * (e.g. status messages) are channel-scoped and have no originating user.
 * Types that do carry a user simply add `userId: string` themselves.
 */
export interface BaseMessage {
  /** Stable identifier for this message/event. */
  id: string;
  /** Logical conversation the message belongs to. */
  conversationId: string;
  /** Platform channel the message was delivered to. */
  channelId: string;
  /** Platform team/workspace identifier when the platform exposes one. */
  teamId?: string;
  /** Originating PlatformConnection id, when applicable. */
  connectionId?: string;
}
