/**
 * Slack channel membership graph — the first ACL source for the authorization
 * program (docs/plans/authz-acl-permission-program.md, the Slack e2e vertical).
 *
 * Now a THIN adapter over the generic `./access-graph` engine: it normalizes a
 * Slack workspace's channels + members into the engine's resource/audience shape
 * and hands them over. All the materialization (resolve entities, identity-first
 * member collapse, idempotent `member_of` edges, departure reconcile, stamping
 * `authz_source_acl_state`) lives in the engine and is shared with every other
 * ACL source (GitHub repos, …). The Slack-specific parts are just:
 *   - each channel → a `channel` entity keyed on its TEAM-SCOPED id
 *     (`slack_channel_id` = `T…:C…`) so two workspaces never collapse onto one;
 *   - each member → resolved on the canonical `slack_user_id` (`T…:U…`) namespace,
 *     so a member who already signed in COLLAPSES onto their `$member` entity.
 *
 * The visibility gate (`./channel-visibility`) reads the `member_of` edges this
 * writes: a requester may recall a channel iff they are `member_of` it. For
 * Slack, channel membership IS the read ACL. (Public-channel read-without-join is
 * a deliberate follow-up; gating on membership only ever UNDER-shares.)
 */

import { normalizeSlackUserId } from '@lobu/connector-sdk/identity-normalize';
import { type AccessResource, buildAccessGraph } from './access-graph.js';
import { SLACK_SOURCE } from './sources.js';

const SLACK_USER_ID_NS = 'slack_user_id';

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

/**
 * Materialize a Slack workspace's channel-membership graph and mark the
 * connection ACL-enforced. Injectable `channels` (with their members) so tests
 * and the live sync both call the same builder.
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

  // Normalize Slack channels → engine resources (team-scoped keys; members
  // resolved on the canonical slack_user_id namespace for cross-source collapse).
  const channelKeyToBareId: Record<string, string> = {};
  const resources: AccessResource[] = [];
  for (const c of channels) {
    const channelKey = slackChannelKey(teamId, c.channelId);
    channelKeyToBareId[channelKey] = c.channelId;
    const members = [];
    for (const u of c.memberSlackUserIds) {
      const combined = normalizeSlackUserId(teamId, u);
      if (!combined) continue;
      members.push({
        key: combined,
        name: combined,
        identities: [{ namespace: SLACK_USER_ID_NS, value: combined }],
      });
    }
    resources.push({ key: channelKey, name: c.name ?? c.channelId, members });
  }

  const result = await buildAccessGraph({
    organizationId,
    connectionId,
    connectorKey: SLACK_SOURCE.key,
    resourceType: SLACK_SOURCE.resourceType,
    memberIdentities: SLACK_SOURCE.memberIdentities,
    resources,
  });

  // Map engine resource keys (T:C) back to the bare channel ids callers expect.
  const channelEntityIds: Record<string, number> = {};
  for (const [channelKey, entityId] of Object.entries(result.resourceEntityIds)) {
    const bareId = channelKeyToBareId[channelKey];
    if (bareId) channelEntityIds[bareId] = entityId;
  }

  return {
    channelEntityIds,
    memberEntityIds: result.memberEntityIds,
    createdEdges: result.createdEdges,
    removedEdges: result.removedEdges,
  };
}
