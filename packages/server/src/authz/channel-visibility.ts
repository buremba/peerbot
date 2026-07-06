/**
 * The Slack channel visibility gate — "which channels may THIS requester read?"
 *
 * Reads the `member_of` edges that `./slack-channel-graph` materializes: a
 * requester may recall a channel's transcript iff their `$member` entity is
 * `member_of` that channel. This is the two-sided, fail-closed gate from the
 * authz program (docs/plans/authz-acl-permission-program.md §4) applied to chat
 * recall: the existing per-agent channel fence is one side (the agent only sees
 * its bound channels); this is the other (the user only sees channels they
 * belong to). The two INTERSECT — an agent acting for a user never widens past
 * either bound.
 *
 * Enforcement is per-connection and OFF by default: a connection's rows are
 * gated only once it has a fresh `authz_source_acl_state` row (`acl_support
 * = 'full'` AND `freshness_state = 'fresh'`). A connection that was NEVER graphed
 * (no `authz_source_acl_state` row) keeps the existing per-agent behavior, so an
 * absent graph never silently hides a channel. But once a row exists, anything
 * short of full+fresh — partial/none support, stale/failed freshness, or a fresh
 * row aged past the window — fails CLOSED rather than passing through, so a
 * half-built or stalled graph can never mis-enforce.
 *
 * Fail-closed: for an ENFORCED connection, a channel is dropped unless the
 * requester is provably a member. An unresolved requester (anonymous/headless,
 * or no `$member` in this org) sees NONE of an enforced connection's channels.
 */

import { normalizeSlackUserId } from '@lobu/connector-sdk/identity-normalize';
import { type DbClient, pgTextArray } from '../db/client.js';
import { getConnectionEnforcement, rowToChannelKey } from './acl-state.js';

/** A bound channel the gate decides on. Mirrors the fields `resolveBoundChannelRows`
 * returns (`id` is the connection id). */
export interface GatedChannelRow {
  /** Connection id that owns the channel binding. */
  id: string;
  platform: string;
  /** As stored on the binding — may be platform-prefixed (`slack:C…`) or bare. */
  channel_id: string;
  /** Slack workspace id (`T…`); required to form the team-scoped channel key. */
  team_id: string | null;
}

/**
 * Resolve the requester's `$member` entity id in a SPECIFIC org. Restricted to
 * the auth-server signup claim (`namespace='auth_user_id'`,
 * `source_connector='auth:signup'`) so a user-supplied identity row can't hijack
 * the lookup — the same guard `resolveTenantMember` uses, but scoped to the org
 * the read happens in rather than the user's personal org. Returns null when the
 * user has no `$member` here (→ fail closed for enforced connections).
 */
export async function resolveRequesterMemberEntityId(
  sql: DbClient,
  organizationId: string,
  userId: string | null,
): Promise<number | null> {
  if (!userId) return null;
  const rows = await sql<{ entity_id: number }>`
		SELECT e.id AS entity_id
		FROM entity_identities ei
		JOIN entities e
		  ON e.id = ei.entity_id
		 AND e.organization_id = ei.organization_id
		 AND e.deleted_at IS NULL
		JOIN entity_types et
		  ON et.id = e.entity_type_id
		 AND et.organization_id = e.organization_id
		 AND et.slug = '$member'
		WHERE ei.organization_id = ${organizationId}
		  AND ei.namespace = 'auth_user_id'
		  AND ei.identifier = ${userId}
		  AND ei.deleted_at IS NULL
		  AND ei.source_connector = 'auth:signup'
		LIMIT 1
	`;
  return rows.length > 0 ? Number(rows[0].entity_id) : null;
}

/**
 * Fallback requester resolution for someone talking to the bot INSIDE Slack,
 * where the only id we have is their Slack user id (the message author), not an
 * `auth_user_id`. Tries the team-scoped `slack_user_id` claim for each candidate
 * team (the enforcing connections' teams). Without this, an in-Slack requester
 * always misses the auth lookup and fails closed even on channels they belong to.
 *
 * Safe against hijack the same way the auth path is: the `slack_user_id` claim is
 * only ever written server-side (by the graph builder / login promotion), never
 * from user-supplied input, so resolving on it can't be forged. Returns the first
 * entity that owns the claim, or null.
 */
async function resolveRequesterBySlackUserId(
  sql: DbClient,
  organizationId: string,
  userId: string | null,
  teamIds: string[],
): Promise<number | null> {
  if (!userId || teamIds.length === 0) return null;
  const keys = [
    ...new Set(teamIds.map((t) => normalizeSlackUserId(t, userId)).filter((k): k is string => !!k)),
  ];
  if (keys.length === 0) return null;
  const rows = await sql<{ entity_id: number }>`
		SELECT ei.entity_id
		FROM entity_identities ei
		JOIN entities e
		  ON e.id = ei.entity_id
		 AND e.organization_id = ei.organization_id
		 AND e.deleted_at IS NULL
		WHERE ei.organization_id = ${organizationId}
		  AND ei.namespace = 'slack_user_id'
		  AND ei.identifier = ANY(${pgTextArray(keys)}::text[])
		  AND ei.deleted_at IS NULL
		LIMIT 1
	`;
  return rows.length > 0 ? Number(rows[0].entity_id) : null;
}

/**
 * Resolve the requester to a `$member` entity id, combining BOTH paths the
 * authz program supports: prefer the auth-server signup claim (web/app sign-in),
 * then fall back to the team-scoped `slack_user_id` claim for someone talking to
 * the bot INSIDE Slack (whose only id is a Slack user id). `enforcingTeamIds`
 * scopes the Slack fallback to the teams whose connections are actually
 * enforcing. Returns null when neither resolves (→ fail closed).
 *
 * The single resolver shared by the gate ({@link filterChannelsForRequester})
 * and the audience read's "you" highlight, so the two never disagree on who the
 * requester is.
 */
export async function resolveRequesterMember(
  sql: DbClient,
  organizationId: string,
  userId: string | null,
  enforcingTeamIds: string[],
): Promise<number | null> {
  if (!userId) return null;
  const byAuth = await resolveRequesterMemberEntityId(sql, organizationId, userId);
  if (byAuth !== null) return byAuth;
  return resolveRequesterBySlackUserId(sql, organizationId, userId, enforcingTeamIds);
}

/**
 * The team-scoped channel keys (`T…:C…`) the member can read, via `member_of`
 * edges to `channel` entities carrying a `slack_channel_id` identity.
 */
export async function getVisibleChannelKeysForMember(
  sql: DbClient,
  organizationId: string,
  memberEntityId: number,
): Promise<Set<string>> {
  const rows = await sql<{ channel_key: string }>`
		SELECT ei.identifier AS channel_key
		FROM entity_relationships r
		JOIN entity_relationship_types rt
		  ON rt.id = r.relationship_type_id
		 AND rt.organization_id = r.organization_id
		 AND rt.slug = 'member_of'
		JOIN entity_identities ei
		  ON ei.entity_id = r.to_entity_id
		 AND ei.organization_id = r.organization_id
		 AND ei.namespace = 'slack_channel_id'
		 AND ei.deleted_at IS NULL
		WHERE r.organization_id = ${organizationId}
		  AND r.from_entity_id = ${memberEntityId}
		  AND r.deleted_at IS NULL
	`;
  return new Set(rows.map((r) => String(r.channel_key)));
}

/**
 * Filter bound channels down to what the requester may actually read. Channels
 * on NON-enforced connections pass through unchanged; channels on enforced
 * connections survive only when the requester is provably `member_of` them.
 * Fail-closed throughout: an enforced channel with no team id, or an
 * unresolvable requester, is dropped.
 *
 * Returns the surviving rows (same objects, filtered) — the caller keeps its
 * existing per-channel query shape, just over a possibly-smaller set.
 */
export async function filterChannelsForRequester<T extends GatedChannelRow>(
  sql: DbClient,
  params: { organizationId: string; userId: string | null; rows: T[] },
): Promise<T[]> {
  const { organizationId, userId, rows } = params;
  if (rows.length === 0) return rows;

  const states = await getConnectionEnforcement(
    sql,
    organizationId,
    rows.map((r) => r.id),
  );
  // No connection onboarded into authz → no per-user gating to apply; preserve
  // legacy behavior without paying for member resolution.
  if (states.size === 0) return rows;

  // Only resolve the requester's membership when at least one connection is
  // actively enforcing (full+fresh). Onboarded-but-stale connections fail closed
  // regardless of who is asking, so they need no membership lookup.
  const anyEnforcing = [...states.values()].some((s) => s.status === "enforced");
  const enforcingTeamIds = [
    ...new Set(
      rows
        .filter((r) => states.get(r.id)?.status === "enforced" && r.team_id)
        .map((r) => r.team_id as string),
    ),
  ];
  const memberEntityId = anyEnforcing
    ? await resolveRequesterMember(sql, organizationId, userId, enforcingTeamIds)
    : null;
  const visibleKeys =
    memberEntityId === null
      ? new Set<string>()
      : await getVisibleChannelKeysForMember(sql, organizationId, memberEntityId);

  return rows.filter((r) => {
    const state = states.get(r.id);
    if (!state) return true; // never graphed → legacy fence still applies
    if (state.status !== "enforced") return false; // stale/unsupported → fail closed
    const key = rowToChannelKey(r);
    if (key === null) return false; // no team id → can't form the key → fail closed
    return visibleKeys.has(key);
  });
}
