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
import {
  type ChannelEnforcement,
  getConnectionEnforcement,
  NOT_GRAPHED,
  rowToChannelKey,
} from "./acl-state.js";
import {
  type GatedChannelRow,
  resolveRequesterMember,
} from "./channel-visibility.js";

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
  isYou: boolean;
  source: AudienceMemberSource;
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
    const key = rowToChannelKey(r);
    keyByRow.set(r, key);
    if (key) allKeys.push(key);
  }

  // 2. Resolve channels → resource entities, the per-connection enforcement
  //    state, and workspace names. (Requester + members come next, once we know
  //    which connections actually enforce — see step 3.)
  const [keyToEntity, enforcement, teamNames] = await Promise.all([
    resolveChannelEntityIds(sql, organizationId, allKeys),
    getConnectionEnforcement(
      sql,
      organizationId,
      rows.map((r) => r.id),
    ),
    resolveTeamNames(
      sql,
      organizationId,
      rows.map((r) => r.team_id).filter((t): t is string => !!t),
    ),
  ]);

  // 3. The audience mirrors the gate: members are only reported for ENFORCED
  //    connections (a stale/aged-out connection fails closed). So only fetch
  //    members for resources whose connection enforces — fetching the rest would
  //    just be discarded — and map each enforced resource to its channel team so
  //    a member's Slack id can be scoped to THIS workspace.
  const enforcedResourceTeam = new Map<number, string>();
  const enforcingTeamIds = new Set<string>();
  for (const r of rows) {
    if (enforcement.get(r.id)?.status !== "enforced") continue;
    if (r.team_id) enforcingTeamIds.add(r.team_id);
    const key = keyByRow.get(r);
    const entity = key ? keyToEntity.get(key) : undefined;
    if (entity && r.team_id) enforcedResourceTeam.set(entity.id, r.team_id);
  }

  // 4. Resolve the requester (auth + in-Slack fallback) for the "you" highlight,
  //    and fetch members for the enforced resources, in parallel.
  const [requesterEntityId, membersByResource] = await Promise.all([
    resolveRequesterMember(sql, organizationId, userId, [...enforcingTeamIds]),
    getAudienceMembers(sql, organizationId, enforcedResourceTeam),
  ]);

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
  has_auth: boolean;
}

/** A member resolved for one resource, with the Slack id scoped to that
 * resource's channel team. */
interface AudienceRow {
  member_entity_id: number;
  display_name: string;
  slack_user_id: string | null;
  has_auth: boolean;
}

/**
 * Members `member_of` each enforced resource entity, with the identities the UI
 * renders. `resourceTeam` maps each resource entity id to its Slack workspace so
 * a member's Slack id is scoped to THIS channel's team — a member who belongs to
 * several workspaces carries one `slack_user_id` identity per team, and the
 * audience for a channel must show the id for that channel's workspace, not an
 * arbitrary one.
 */
async function getAudienceMembers(
  sql: DbClient,
  organizationId: string,
  resourceTeam: Map<number, string>,
): Promise<Map<number, AudienceRow[]>> {
  const resourceIds = [...resourceTeam.keys()];
  if (resourceIds.length === 0) return new Map();
  const rows = await sql<RawMember>`
    SELECT
      r.to_entity_id AS resource_entity_id,
      me.id AS member_entity_id,
      me.name AS display_name,
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

  // Fetch each member's team-scoped Slack ids in a separate scalar query (no
  // array readback, safe under fetch_types:false) and pick the one matching the
  // resource's team at grouping time.
  const memberIds = [...new Set(rows.map((r) => Number(r.member_entity_id)))];
  const slackIdsByMember = new Map<number, string[]>();
  if (memberIds.length > 0) {
    const idRows = await sql<{ entity_id: number; identifier: string }>`
      SELECT entity_id, identifier
      FROM entity_identities
      WHERE organization_id = ${organizationId}
        AND namespace = 'slack_user_id'
        AND entity_id = ANY(${pgBigintArray(memberIds)}::bigint[])
        AND deleted_at IS NULL
    `;
    for (const r of idRows) {
      const id = Number(r.entity_id);
      const list = slackIdsByMember.get(id) ?? [];
      list.push(String(r.identifier));
      slackIdsByMember.set(id, list);
    }
  }

  const out = new Map<number, AudienceRow[]>();
  for (const r of rows) {
    const resourceId = Number(r.resource_entity_id);
    const memberId = Number(r.member_entity_id);
    // `slack_user_id` identities are stored uppercased (`T…:U…`); scope to the
    // resource's team so a multi-workspace member shows this channel's id.
    const teamPrefix = `${resourceTeam.get(resourceId)?.toUpperCase()}:`;
    const slackUserId =
      slackIdsByMember.get(memberId)?.find((i) => i.startsWith(teamPrefix)) ??
      null;
    const list = out.get(resourceId) ?? [];
    list.push({
      member_entity_id: memberId,
      display_name: r.display_name,
      slack_user_id: slackUserId,
      has_auth: r.has_auth,
    });
    out.set(resourceId, list);
  }
  return out;
}

function toAudienceMember(
  m: AudienceRow,
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
    isYou,
    source,
  };
}
