/**
 * Resolve a chat channel's ACL resource entity from a save/read context so a
 * write (e.g. `save_memory` distilling channel knowhow) can be STAMPED with the
 * channel entity in `events.entity_ids`. That stamp is what makes the derived
 * memory inherit the SAME per-channel visibility gate that protects the raw
 * transcript (`resource-visibility` / `channel-messages-visibility`): a member
 * of the channel recalls it, a non-member never does. Without the stamp,
 * distilled channel knowhow would be org-visible and leak across channels.
 *
 * Keyed on the platform's team-scoped channel identity (Slack: `slack_channel_id`
 * = `T…:C…` upper-cased — the exact identity the ACL sync writes), so two
 * workspaces never collapse onto one channel entity. The platform's key model is
 * looked up in the channel-read-identity registry; this file names no connector.
 */

import { type DbClient, getDb } from '../db/client.js';
import { stripPlatformPrefix } from '../gateway/channels/bound-channels.js';
import { channelReadIdentityFor } from './sources.js';

/**
 * Resolve the `channel` resource-entity id for a (platform, team, channel) in an
 * org, or null when the platform has no enforced channel gate or the channel has
 * no graphed entity (never synced). Returns null rather than throwing — a missing
 * entity must NOT block the save; the memory is saved without the channel stamp
 * (falls back to the caller's existing org/$member scoping).
 */
export async function resolveChannelEntityId(
  organizationId: string,
  platform: string | null | undefined,
  teamId: string | null | undefined,
  channelId: string | null | undefined,
  sql: DbClient = getDb(),
): Promise<number | null> {
  if (!platform || !teamId || !channelId) return null;
  const identity = channelReadIdentityFor(platform);
  if (!identity) return null;
  // The worker-token / sourceContext channelId arrives platform-PREFIXED
  // (`slack:C0ENG`) — the Chat SDK's canonical form — while the graphed channel
  // identity is the BARE team-scoped id (`T…:C…`). Strip the prefix so the key
  // matches; without this the lookup always misses and the stamp silently never
  // fires (channel memory would leak org-wide).
  const bareChannelId = stripPlatformPrefix(platform, channelId);
  const key = identity.buildChannelKey(teamId, bareChannelId);
  if (!key) return null;
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
      AND ei.namespace = ${identity.channelNamespace}
      AND ei.identifier = ${key}
      AND ei.deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ? Number(rows[0].entity_id) : null;
}
