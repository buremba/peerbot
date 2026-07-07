/**
 * Platform → sender-identity mapping for chat-transcript attribution.
 *
 * The connector-agnostic core resolver (`resolveSenderIdentity` in
 * entity-link-upsert) names no platform: it takes an already-normalized
 * identity spec + the entity type to mint on a miss. THIS module is the
 * connector-facing edge that turns a raw inbound chat author (platform, team,
 * author id, bot flag) into that spec — the ONE place a platform's identity
 * shape is known on the transcript path.
 *
 * A platform with no entry here (or a bot / malformed author) yields `null`:
 * the message is still captured, just without `author_entity_id`.
 */
import { normalizeSlackUserId, SLACK_IDENTITY } from '@lobu/connectors/slack-identity';
import type { ResolvedIdentity } from '../../utils/entity-link-upsert.js';

export interface SenderIdentitySpec {
  /** Normalized identity keys the sender is looked up / minted under. */
  identities: ResolvedIdentity[];
  /** Entity type to mint when no existing entity owns the identity. */
  mintEntityType: string;
}

export interface RawChatSender {
  platform: string;
  teamId?: string | null;
  authorId?: string | null;
  isBot: boolean;
}

/**
 * Build the normalized identity spec for a chat sender, or `null` when it
 * shouldn't be attributed (a bot, an unknown platform, or a malformed id that
 * would poison cross-workspace matching).
 */
export function buildSenderIdentity(sender: RawChatSender): SenderIdentitySpec | null {
  // A bot post never attributes to a human entity.
  if (sender.isBot) return null;

  switch (sender.platform) {
    case 'slack': {
      // Team-scoped `T…:U…`; a bare `U…` with no team is dropped so a malformed,
      // non-workspace-scoped key never poisons cross-workspace matching.
      const slackId = normalizeSlackUserId(sender.teamId, sender.authorId);
      if (!slackId) return null;
      return {
        identities: [
          {
            namespace: SLACK_IDENTITY.USER_ID,
            identifier: slackId,
            matchOnly: false,
            primary: false,
          },
        ],
        mintEntityType: 'person',
      };
    }
    default:
      return null;
  }
}
