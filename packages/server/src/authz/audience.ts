/**
 * The audience read — "WHO can recall this channel?" — the INVERSE of the
 * channel-visibility gate. The gate (`./channel-visibility`) asks "which channels
 * may THIS requester read"; the audience asks "which members are `member_of` THIS
 * channel". Both read the SAME `member_of` edges + resource identities, so the
 * governance view can never drift from what the gate actually enforces.
 *
 * READ-ONLY: Slack is the source of truth for channel membership; this never
 * writes. Resource-generic in shape (keyed on the resource entity), surfaced
 * today for Slack `channel` entities; a `repo` audience slots in with no new
 * query. Pure DB read — safe under N replicas.
 */

import { type DbClient, pgBigintArray, pgTextArray } from "../db/client.js";
import { stripPlatformPrefix } from "../gateway/channels/bound-channels.js";
import { ACL_STALE_AFTER_MINUTES } from "./acl-state.js";
import {
  type GatedChannelRow,
  resolveRequesterMemberEntityId,
} from "./channel-visibility.js";
import { slackChannelKey } from "./slack-channel-graph.js";

/**
 * How a member appears to the requester:
 *  - `you`           — the requester's own `$member` entity.
 *  - `linked-slack`  — signed in to Lobu and collapsed onto their Slack identity
 *                      (their entity carries the `auth:signup` claim).
 *  - `slack-member`  — a channel member who hasn't signed in (Slack identity only).
 */
export type AudienceMemberSource = "you" | "linked-slack" | "slack-member";

export interface AudienceMember {
  entityId: number;
  displayName: string;
  /** Team-scoped Slack user id (`T…:U…`) when the member carries one. */
  slackUserId: string | null;
  email: string | null;
  isYou: boolean;
  source: AudienceMemberSource;
}

/**
 * Per-connection enforcement state:
 *  - `enforced`    — `acl_support='full'` AND `freshness_state='fresh'` AND synced
 *                    within {@link ACL_STALE_AFTER_MINUTES}; recall is membership-gated.
 *  - `stale`       — onboarded (an `authz_source_acl_state` row exists) but not
 *                    currently enforcing (partial/stale/aged-out) → fails closed.
 *  - `not-graphed` — no ACL row at all; legacy per-agent fence, no audience graph.
 */
export type EnforcementStatus = "enforced" | "stale" | "not-graphed";

export interface ChannelEnforcement {
  status: EnforcementStatus;
  aclSupport: string | null;
  freshnessState: string | null;
  lastSyncedAt: string | null;
}

export interface ChannelAudience {
  connectionId: string;
  platform: string;
  /** As stored on the binding (may be platform-prefixed, e.g. `slack:C…`). */
  channelId: string;
  /** Human channel name (e.g. `announcements`) from the synced graph; null if
   * the sync hasn't captured it yet (falls back to the id in the UI). */
  channelName: string | null;
  teamId: string | null;
  /** Human workspace name (e.g. `Lobu`) from the app installation; null if no
   * active install resolves for the team. */
  teamName: string | null;
  enforcement: ChannelEnforcement;
  memberCount: number;
  members: AudienceMember[];
}

const NOT_GRAPHED: ChannelEnforcement = {
  status: "not-graphed",
  aclSupport: null,
  freshnessState: null,
  lastSyncedAt: null,
};

/**
 * For each bound channel, return its audience (members `member_of` the channel)
 * plus the owning connection's enforcement state. Mirrors the gate's
 * `member_of` + resource-identity joins, inverted (members keyed off
 * `from_entity_id`, channel off `to_entity_id`).
 */
export async function getChannelAudiences(
  sql: DbClient,
  params: {
    organizationId: string;
    userId: string | null;
    rows: GatedChannelRow[];
  },
): Promise<ChannelAudience[]> {
  const { organizationId, userId, rows } = params;
  if (rows.length === 0) return [];

  // 1. Team-scoped channel key per row (needs a team id to form). A row without
  //    a team id can't be keyed to a resource entity → empty audience.
  const keyByRow = new Map<GatedChannelRow, string | null>();
  const allKeys: string[] = [];
  for (const r of rows) {
    const key = r.team_id
      ? slackChannelKey(
          r.team_id,
          stripPlatformPrefix(r.platform, r.channel_id),
        )
      : null;
    keyByRow.set(r, key);
    if (key) allKeys.push(key);
  }

  // 2-4. Resolve channels → resource entities, fan out to members + enforcement,
  //      and resolve the requester (web/auth path) for the "you" highlight.
  const [keyToEntity, enforcement, requesterEntityId, teamNames] =
    await Promise.all([
      resolveChannelEntityIds(sql, organizationId, allKeys),
      getConnectionEnforcement(
        sql,
        organizationId,
        rows.map((r) => r.id),
      ),
      resolveRequesterMemberEntityId(sql, organizationId, userId),
      resolveTeamNames(
        sql,
        organizationId,
        rows.map((r) => r.team_id).filter((t): t is string => !!t),
      ),
    ]);
  const resourceIds = [
    ...new Set([...keyToEntity.values()].map((e) => e.id)),
  ];
  const membersByResource = await getAudienceMembers(
    sql,
    organizationId,
    resourceIds,
  );

  return rows.map((r) => {
    const enf = enforcement.get(r.id) ?? NOT_GRAPHED;
    const key = keyByRow.get(r) ?? null;
    const entity = key ? keyToEntity.get(key) : undefined;
    const resourceId = entity?.id;
    // The sync seeds the channel entity name to its id when Slack didn't return
    // a name; surface a real name only when it differs from the bare id.
    const bareChannel = stripPlatformPrefix(r.platform, r.channel_id);
    const channelName =
      entity && entity.name !== bareChannel ? entity.name : null;
    const teamName = r.team_id ? (teamNames.get(r.team_id) ?? null) : null;
    // The audience is the inverse of the recall gate, which only honors
    // membership when the connection is ENFORCED (full+fresh). A `stale` /
    // aged-out connection fails CLOSED — nobody can currently recall — so its
    // (possibly old) `member_of` edges must NOT be reported as "can recall".
    // `not-graphed` keeps the legacy per-agent fence and has no edges anyway.
    const raw =
      enf.status === "enforced" && resourceId
        ? (membersByResource.get(resourceId) ?? [])
        : [];
    const members = raw.map((m) => toAudienceMember(m, requesterEntityId));
    return {
      connectionId: r.id,
      platform: r.platform,
      channelId: r.channel_id,
      channelName,
      teamId: r.team_id,
      teamName,
      enforcement: enf,
      memberCount: members.length,
      members,
    };
  });
}

/** Resolve team-scoped channel keys (`T…:C…`) → their `channel` resource entity
 * (id + the entity's display name, which the sync sets to the Slack channel name). */
async function resolveChannelEntityIds(
  sql: DbClient,
  organizationId: string,
  keys: string[],
): Promise<Map<string, { id: number; name: string }>> {
  const uniq = [...new Set(keys)].filter(Boolean);
  if (uniq.length === 0) return new Map();
  const rows = await sql<{ identifier: string; entity_id: number; name: string }>`
    SELECT ei.identifier, ei.entity_id, e.name
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
      AND ei.identifier = ANY(${pgTextArray(uniq)}::text[])
      AND ei.deleted_at IS NULL
  `;
  const out = new Map<string, { id: number; name: string }>();
  for (const r of rows)
    out.set(String(r.identifier), {
      id: Number(r.entity_id),
      name: String(r.name),
    });
  return out;
}

/** Resolve team ids → workspace display name from the active Slack install. */
async function resolveTeamNames(
  sql: DbClient,
  organizationId: string,
  teamIds: string[],
): Promise<Map<string, string>> {
  const uniq = [...new Set(teamIds)].filter(Boolean);
  if (uniq.length === 0) return new Map();
  const rows = await sql<{ external_tenant_id: string; team_name: string | null }>`
    SELECT external_tenant_id, metadata->>'team_name' AS team_name
    FROM app_installations
    WHERE organization_id = ${organizationId}
      AND provider = 'slack'
      AND status = 'active'
      AND external_tenant_id = ANY(${pgTextArray(uniq)}::text[])
  `;
  const out = new Map<string, string>();
  for (const r of rows)
    if (r.team_name) out.set(String(r.external_tenant_id), String(r.team_name));
  return out;
}

interface RawMember {
  resource_entity_id: number;
  member_entity_id: number;
  display_name: string;
  slack_user_id: string | null;
  email: string | null;
  has_auth: boolean;
}

/** Members `member_of` each resource entity, with the identities the UI renders. */
async function getAudienceMembers(
  sql: DbClient,
  organizationId: string,
  resourceIds: number[],
): Promise<Map<number, RawMember[]>> {
  if (resourceIds.length === 0) return new Map();
  const rows = await sql<RawMember>`
    SELECT
      r.to_entity_id AS resource_entity_id,
      me.id AS member_entity_id,
      me.name AS display_name,
      MAX(CASE WHEN mi.namespace = 'slack_user_id' THEN mi.identifier END) AS slack_user_id,
      MAX(CASE WHEN mi.namespace = 'email' THEN mi.identifier END) AS email,
      bool_or(mi.namespace = 'auth_user_id' AND mi.source_connector = 'auth:signup') AS has_auth
    FROM entity_relationships r
    JOIN entity_relationship_types rt
      ON rt.id = r.relationship_type_id
     AND rt.organization_id = r.organization_id
     AND rt.slug = 'member_of'
    JOIN entities me
      ON me.id = r.from_entity_id
     AND me.organization_id = r.organization_id
     AND me.deleted_at IS NULL
    LEFT JOIN entity_identities mi
      ON mi.entity_id = me.id
     AND mi.organization_id = me.organization_id
     AND mi.deleted_at IS NULL
    WHERE r.organization_id = ${organizationId}
      AND r.to_entity_id = ANY(${pgBigintArray(resourceIds)}::bigint[])
      AND r.deleted_at IS NULL
    GROUP BY r.to_entity_id, me.id, me.name
    ORDER BY me.name ASC
  `;
  const out = new Map<number, RawMember[]>();
  for (const r of rows) {
    const id = Number(r.resource_entity_id);
    const list = out.get(id) ?? [];
    list.push(r);
    out.set(id, list);
  }
  return out;
}

/** Per-connection enforcement detail (status + the columns the detail panel shows). */
async function getConnectionEnforcement(
  sql: DbClient,
  organizationId: string,
  connectionIds: string[],
): Promise<Map<string, ChannelEnforcement>> {
  const ids = [...new Set(connectionIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await sql<{
    connection_id: string;
    acl_support: string | null;
    freshness_state: string | null;
    last_synced_at: Date | null;
    enforce: boolean;
  }>`
    SELECT
      connection_id,
      acl_support,
      freshness_state,
      last_synced_at,
      (
        acl_support = 'full'
        AND freshness_state = 'fresh'
        AND last_synced_at IS NOT NULL
        AND last_synced_at >= current_timestamp - make_interval(mins => ${ACL_STALE_AFTER_MINUTES})
      ) AS enforce
    FROM authz_source_acl_state
    WHERE organization_id = ${organizationId}
      AND connection_id = ANY(${pgTextArray(ids)}::text[])
  `;
  const out = new Map<string, ChannelEnforcement>();
  for (const r of rows) {
    out.set(String(r.connection_id), {
      status: r.enforce === true ? "enforced" : "stale",
      aclSupport: r.acl_support ?? null,
      freshnessState: r.freshness_state ?? null,
      lastSyncedAt: r.last_synced_at
        ? new Date(r.last_synced_at).toISOString()
        : null,
    });
  }
  return out;
}

function toAudienceMember(
  m: RawMember,
  requesterEntityId: number | null,
): AudienceMember {
  const isYou =
    requesterEntityId !== null &&
    Number(m.member_entity_id) === requesterEntityId;
  const source: AudienceMemberSource = isYou
    ? "you"
    : m.has_auth === true
      ? "linked-slack"
      : "slack-member";
  return {
    entityId: Number(m.member_entity_id),
    displayName: m.display_name,
    slackUserId: m.slack_user_id ?? null,
    email: m.email ?? null,
    isYou,
    source,
  };
}
