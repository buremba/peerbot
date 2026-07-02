/**
 * Resolve a chat channel's ACL resource entity from a save/read context so a
 * write (e.g. `save_memory` distilling channel knowhow) can be STAMPED with the
 * channel entity in `events.entity_ids`. That stamp is what makes the derived
 * memory inherit the SAME per-channel visibility gate that protects the raw
 * transcript (`resource-visibility` / `channel-messages-visibility`): a member
 * of the channel recalls it, a non-member never does. Without the stamp,
 * distilled channel knowhow would be org-visible and leak across channels.
 *
 * Keyed on the TEAM-SCOPED `slack_channel_id` (`T…:C…`, upper-cased — the exact
 * identity `slack-channel-graph` writes), so two workspaces never collapse onto
 * one channel entity.
 */

import { type DbClient, getDb } from '../db/client.js';
import { stripPlatformPrefix } from '../gateway/channels/bound-channels.js';
import { slackChannelKey } from './slack-channel-graph.js';

/**
 * Resolve the `channel` resource-entity id for a (team, channel) pair in an org,
 * or null when the channel has no graphed entity (never synced / not a Slack
 * channel). Returns null rather than throwing — a missing entity must NOT block
 * the save; it just means the memory is saved without the channel stamp (falls
 * back to the caller's existing org/$member scoping).
 */
export async function resolveChannelEntityId(
  organizationId: string,
  teamId: string | null | undefined,
  channelId: string | null | undefined,
  sql: DbClient = getDb(),
): Promise<number | null> {
  if (!teamId || !channelId) return null;
  // The worker-token / sourceContext channelId arrives platform-PREFIXED
  // (`slack:C0ENG`) — the Chat SDK's canonical form — while the graphed
  // `slack_channel_id` identity is the BARE team-scoped id (`T…:C…`). Strip
  // the prefix so the key matches; without this the lookup always misses and
  // the stamp silently never fires (channel memory would leak org-wide).
  const bareChannelId = stripPlatformPrefix('slack', channelId);
  const key = slackChannelKey(teamId, bareChannelId);
  const rows = await sql<{ entity_id: number }>`
    SELECT ei.entity_id
    FROM entity_identities ei
    JOIN entities e
      ON e.id = ei.entity_id
     AND e.organization_id = ei.organization_id
     AND e.deleted_at IS NULL
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
     AND et.slug = 'channel'
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = 'slack_channel_id'
      AND ei.identifier = ${key}
      AND ei.deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ? Number(rows[0].entity_id) : null;
}
