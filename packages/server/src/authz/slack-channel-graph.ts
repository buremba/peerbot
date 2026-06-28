/**
 * Slack channel membership graph — the first ACL source for the authorization
 * program (docs/plans/authz-acl-permission-program.md, the Slack e2e vertical).
 *
 * Mirrors `buildGithubTeamGraph`: it REUSES the existing entity graph rather
 * than introducing any new principal/edge/identity tables.
 *
 *   - each Slack channel becomes a `channel` entity, identified by its
 *     team-scoped id (`slack_channel_id` = `T…:C…`) so two workspaces never
 *     collapse onto one channel entity;
 *   - each channel member becomes a `person` resolved through the SAME
 *     entity-identity machinery (`slack_user_id` = `T…:U…`), so a member who
 *     already signed in (their `$member` carries a promoted `slack_user_id`
 *     claim) COLLAPSES onto that one entity instead of forking a second person;
 *   - a `member_of` edge (person → channel) is written per (member, channel).
 *
 * The visibility gate (`./channel-visibility`) reads exactly these `member_of`
 * edges: a requester may recall a channel's transcript iff they are `member_of`
 * that channel. For Slack, channel membership IS the read ACL — so this graph
 * needs no separate `can_read`/`deny_read` edges. (Public-channel "any
 * workspace member can read without joining" is a deliberate follow-up; gating
 * on membership only ever UNDER-shares, never over-shares — the safe direction.)
 *
 * Completing the build stamps `authz_source_acl_state` ('full','fresh') for the
 * connection, which is the switch the gate consults to start enforcing. Until a
 * connection has a fresh row here, the gate leaves its rows on the existing
 * per-agent fence (no half-built graph ever silently enforces).
 *
 * Tenant-scoped + idempotent + best-effort, exactly like the GitHub builder:
 * everything filters on `organizationId`; `member_of` dedupes on the live-triple
 * unique index; failures are logged and surfaced, never thrown.
 */

import { normalizeSlackUserId } from '@lobu/connector-sdk';
import { createLogger } from '@lobu/core';
import { getDb, pgBigintArray, pgTextArray } from '../db/client.js';
import { resolveEntityLinksForItems } from '../utils/entity-link-upsert.js';

const logger = createLogger('slack-channel-graph');

const SLACK_CONNECTOR_KEY = 'slack';
const MEMBER_OF_TYPE_SLUG = 'member_of';
const CHANNEL_ENTITY_TYPE_SLUG = 'channel';

/** Identity namespaces. Channels/teams use custom (trim-only) namespaces; the
 * user id reuses the canonical `slack_user_id` namespace so it collapses with
 * login-promoted claims. */
const SLACK_CHANNEL_ID_NS = 'slack_channel_id';

/** A Slack channel and the (bare `U…`) ids of its members. */
export interface SlackChannelInput {
  /** Bare Slack channel id (`C…` / `G…`). */
  channelId: string;
  name?: string;
  isPrivate?: boolean;
  /** Bare Slack user ids (`U…`) of the channel's members. */
  memberSlackUserIds: string[];
}

export interface SlackChannelGraphResult {
  /** Bare channel id → the `channel` entity id that now represents it. */
  channelEntityIds: Record<string, number>;
  /** Distinct member person/`$member` entity ids that gained a `member_of` edge. */
  memberEntityIds: number[];
  /** How many `member_of` edges were newly created (vs already present). */
  createdEdges: number;
  /** How many stale `member_of` edges were soft-deleted (members who left). */
  removedEdges: number;
}

const EMPTY_RESULT: SlackChannelGraphResult = {
  channelEntityIds: {},
  memberEntityIds: [],
  createdEdges: 0,
  removedEdges: 0,
};

/** The team-scoped channel key the gate matches on (`T…:C…`, upper-cased). */
export function slackChannelKey(teamId: string, channelId: string): string {
  return `${teamId.trim()}:${channelId.trim()}`.toUpperCase();
}

/** Resolve an org owner/admin as `entities.created_by` / edge `created_by`
 * (NOT NULL on entities). Same query the GitHub builder uses. */
async function resolveOrgCreator(orgId: string): Promise<string | null> {
  const sql = getDb();
  const rows = await sql<{ userId: string }>`
		SELECT "userId"
		FROM "member"
		WHERE "organizationId" = ${orgId}
		ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
		         "createdAt" ASC
		LIMIT 1
	`;
  return rows.length > 0 ? rows[0].userId : null;
}

/** Find-or-create the org-scoped `channel` entity type (reuse, no migration). */
async function ensureChannelEntityType(orgId: string): Promise<void> {
  const sql = getDb();
  await sql`
		INSERT INTO entity_types (slug, name, description, icon, organization_id, created_at, updated_at)
		VALUES (
			${CHANNEL_ENTITY_TYPE_SLUG}, 'Channel',
			'A chat channel (Slack channel, etc.) — the unit of conversation access control',
			'hash', ${orgId}, current_timestamp, current_timestamp
		)
		ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
		DO NOTHING
	`;
}

/** Find-or-create the org-scoped `member_of` relationship type. */
async function ensureMemberOfType(orgId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
		INSERT INTO entity_relationship_types
			(slug, name, description, organization_id, is_symmetric, created_by, created_at, updated_at)
		VALUES
			(${MEMBER_OF_TYPE_SLUG}, 'Member of', 'A person is a member of an organization or channel', ${orgId},
			 false, NULL, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, slug) WHERE status = 'active'
		DO UPDATE SET updated_at = EXCLUDED.updated_at
		RETURNING id
	`;
  return Number(rows[0].id);
}

/** Stamp the connection's ACL state so the gate begins enforcing it. */
async function markAclEnforced(orgId: string, connectionId: string): Promise<void> {
  const sql = getDb();
  await sql`
		INSERT INTO authz_source_acl_state
			(organization_id, connection_id, acl_support, freshness_state, last_synced_at, created_at, updated_at)
		VALUES (${orgId}, ${connectionId}, 'full', 'fresh', current_timestamp, current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, connection_id)
		DO UPDATE SET acl_support = 'full', freshness_state = 'fresh',
		              last_synced_at = current_timestamp, updated_at = current_timestamp
	`;
}

/**
 * Materialize a Slack workspace's channel-membership graph and mark the
 * connection ACL-enforced. Injectable `channels` (with their members) so tests
 * and the live sync both call the same builder — exactly like the GitHub team
 * graph takes `members` directly.
 *
 * @returns the channel entity ids, the member entity ids, and how many edges
 *          were newly created. Empty when there is nothing to build.
 */
export async function buildSlackChannelGraph(params: {
  organizationId: string;
  connectionId: string;
  /** The workspace/team id (`T…`); used to team-scope every channel + member key. */
  teamId: string;
  channels: SlackChannelInput[];
}): Promise<SlackChannelGraphResult> {
  const { organizationId, connectionId, teamId } = params;
  const channels = params.channels.filter((c) => c.channelId);
  if (!teamId || channels.length === 0) return EMPTY_RESULT;

  const creatorUserId = await resolveOrgCreator(organizationId);
  if (!creatorUserId) {
    logger.warn(
      { organization_id: organizationId },
      'Slack channel graph skipped: org has no member to attribute as entity creator',
    );
    return EMPTY_RESULT;
  }

  await ensureChannelEntityType(organizationId);

  // 1) Resolve every channel to a `channel` entity, keyed on its team-scoped id.
  const channelItems = channels.map((c) => ({
    origin_type: 'slack_channel',
    metadata: {
      channel_key: slackChannelKey(teamId, c.channelId),
      channel_name: c.name ?? c.channelId,
    },
  }));
  const resolvedChannels = await resolveEntityLinksForItems({
    connectorKey: SLACK_CONNECTOR_KEY,
    orgId: organizationId,
    items: channelItems,
    rules: {
      slack_channel: [
        {
          entityType: CHANNEL_ENTITY_TYPE_SLUG,
          autoCreate: true,
          titlePath: 'metadata.channel_name',
          identities: [
            {
              namespace: SLACK_CHANNEL_ID_NS,
              eventPath: 'metadata.channel_key',
              primary: true,
            },
          ],
        },
      ],
    },
  });

  const channelEntityIds: Record<string, number> = {};
  const channelEntityIdByIndex = new Map<number, number>();
  for (let i = 0; i < channels.length; i++) {
    const ids = resolvedChannels.get(i);
    if (ids && ids.length > 0) {
      channelEntityIds[channels[i].channelId] = ids[0];
      channelEntityIdByIndex.set(i, ids[0]);
    }
  }

  // 2) Resolve every DISTINCT member (team-scoped `T:U`) to an entity.
  // Identity-first, TYPE-AGNOSTIC: a member who already signed in owns their
  // `slack_user_id` claim on a `$member` entity, so we must collapse onto THAT
  // entity — but `resolveEntityLinksForItems` matches only within the rule's
  // own entity type ('person'), so it would never find the `$member` and would
  // fork a duplicate. So we resolve existing owners ourselves (any type) and
  // only auto-create a `person` for genuinely-new Slack users.
  const memberKeys = new Map<string, string>(); // bare U… → combined T:U
  for (const c of channels) {
    for (const u of c.memberSlackUserIds) {
      const combined = normalizeSlackUserId(teamId, u);
      if (combined) memberKeys.set(u, combined);
    }
  }
  const combinedKeys = [...new Set([...memberKeys.values()])];
  const memberEntityByCombined = new Map<string, number>();
  const sqlMembers = getDb();
  if (combinedKeys.length > 0) {
    // Existing owners of these slack_user_ids — ANY entity type ($member,
    // person, …). This is the collapse seam.
    const existing = await sqlMembers<{
      identifier: string;
      entity_id: number;
    }>`
			SELECT identifier, entity_id
			FROM entity_identities
			WHERE organization_id = ${organizationId}
			  AND namespace = 'slack_user_id'
			  AND identifier = ANY(${pgTextArray(combinedKeys)}::text[])
			  AND deleted_at IS NULL
		`;
    for (const row of existing) {
      memberEntityByCombined.set(String(row.identifier), Number(row.entity_id));
    }

    // Whoever is left has no entity yet → auto-create a `person` for each.
    const toCreate = combinedKeys.filter((k) => !memberEntityByCombined.has(k));
    if (toCreate.length > 0) {
      const memberItems = toCreate.map((combined) => ({
        origin_type: 'slack_member',
        metadata: { slack_user: combined },
      }));
      const resolvedMembers = await resolveEntityLinksForItems({
        connectorKey: SLACK_CONNECTOR_KEY,
        orgId: organizationId,
        items: memberItems,
        rules: {
          slack_member: [
            {
              entityType: 'person',
              autoCreate: true,
              titlePath: 'metadata.slack_user',
              identities: [
                {
                  namespace: 'slack_user_id',
                  eventPath: 'metadata.slack_user',
                  primary: true,
                },
              ],
            },
          ],
        },
      });
      for (let i = 0; i < toCreate.length; i++) {
        const ids = resolvedMembers.get(i);
        if (ids && ids.length > 0) memberEntityByCombined.set(toCreate[i], ids[0]);
      }
    }
  }

  // 3) Write person -> channel `member_of` edges, idempotent on the live-triple
  // unique index. Accumulate the CURRENT member set per channel entity so we can
  // reconcile departures below.
  const typeId = await ensureMemberOfType(organizationId);
  const sql = getDb();
  const memberEntityIds = new Set<number>();
  const currentMembersByChannel = new Map<number, Set<number>>();
  let createdEdges = 0;
  for (let i = 0; i < channels.length; i++) {
    const channelEntityId = channelEntityIdByIndex.get(i);
    if (channelEntityId === undefined) continue;
    const channelMembers =
      currentMembersByChannel.get(channelEntityId) ?? new Set<number>();
    currentMembersByChannel.set(channelEntityId, channelMembers);
    for (const u of channels[i].memberSlackUserIds) {
      const combined = memberKeys.get(u);
      if (!combined) continue;
      const memberEntityId = memberEntityByCombined.get(combined);
      if (memberEntityId === undefined) continue;
      memberEntityIds.add(memberEntityId);
      channelMembers.add(memberEntityId);
      const inserted = await sql<{ id: number }[]>`
				INSERT INTO entity_relationships (
					organization_id, from_entity_id, to_entity_id, relationship_type_id,
					confidence, source, created_by, updated_by, created_at, updated_at
				) VALUES (
					${organizationId}, ${memberEntityId}, ${channelEntityId}, ${typeId},
					1.0, 'feed', ${creatorUserId}, ${creatorUserId},
					current_timestamp, current_timestamp
				)
				ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
					WHERE deleted_at IS NULL
				DO NOTHING
				RETURNING id
			`;
      if (inserted.length > 0) createdEdges += 1;
    }
  }

  // 4) Reconcile DEPARTURES — the build is a full re-sync of each channel's
  // membership, so a `member_of` edge to a synced channel whose member is NOT in
  // the current set means that person left: soft-delete it so they immediately
  // lose recall access. WITHOUT this, leavers keep visibility forever (the gate
  // only reads live edges). Scoped to `to_entity_id` = a channel we just synced,
  // so person→company edges (GitHub team graph) are never touched. An empty
  // member set deletes all of that channel's edges (the channel was synced with
  // zero members) — the live caller must not pass empty-on-fetch-error, exactly
  // like the identity emitter's null guard.
  let removedEdges = 0;
  for (const [channelEntityId, channelMembers] of currentMembersByChannel) {
    const keep = [...channelMembers];
    const removed = await sql<{ id: number }[]>`
			UPDATE entity_relationships
			SET deleted_at = current_timestamp, updated_at = current_timestamp
			WHERE organization_id = ${organizationId}
			  AND relationship_type_id = ${typeId}
			  AND to_entity_id = ${channelEntityId}
			  AND deleted_at IS NULL
			  AND from_entity_id <> ALL(${pgBigintArray(keep)}::bigint[])
			RETURNING id
		`;
    removedEdges += removed.length;
  }

  await markAclEnforced(organizationId, connectionId);

  logger.info(
    {
      organization_id: organizationId,
      connection_id: connectionId,
      team_id: teamId,
      channels: Object.keys(channelEntityIds).length,
      members: memberEntityIds.size,
      created_edges: createdEdges,
      removed_edges: removedEdges,
    },
    'Built Slack channel graph',
  );

  return {
    channelEntityIds,
    memberEntityIds: [...memberEntityIds],
    createdEdges,
    removedEdges,
  };
}
