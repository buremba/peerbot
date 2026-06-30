/**
 * Slack channel-membership SYNC — the production path that populates the authz
 * graph the visibility gate reads. Without this, `buildSlackChannelGraph` would
 * only ever run from tests and the gate would never enforce a real connection.
 *
 * Per Slack connection: resolve the channels it actually captures
 * (`resolveBoundChannelRows` — the same source of truth the gate filters), fetch
 * each channel's current membership from Slack (`conversations.members`), and
 * hand the whole set to `buildSlackChannelGraph`, which materializes the
 * `member_of` edges, reconciles departures, and stamps the connection
 * `full`/`fresh`. A periodic tick (`runSlackAclSyncTick`, wired in
 * `scheduled/jobs.ts`) re-runs this so membership changes (joins/leaves) converge
 * within the sync cadence, and the gate's freshness window fails the connection
 * closed if the tick ever stops.
 *
 * Fail-closed on error: the sync is ATOMIC per connection. If ANY channel's
 * membership fetch throws (Slack outage, bot removed, missing token), we do NOT
 * build a half-synced graph — we mark the connection's ACL state `failed` so the
 * gate drops all its channels until a later tick succeeds. We only DOWNGRADE an
 * existing row; a connection that has never been graphed stays on the legacy
 * fence (a brand-new connection whose first sync fails must not suddenly hide
 * every channel).
 */

import { createLogger } from '@lobu/core';
import { getDb } from '../db/client.js';
import {
  resolveBoundChannelRows,
  stripPlatformPrefix,
} from '../gateway/channels/bound-channels.js';
import { createSlackWebApi, type SlackWebApi } from '../gateway/connections/slack-web.js';
import { resolveSecretValue } from '../gateway/secrets/index.js';
import type { CoreServices } from '../gateway/services/core-services.js';
import {
  runtimeConnectionIdToSlug,
  slugToRuntimeConnectionId,
} from '../lobu/stores/connections-projection.js';
import { getSlackInstallByTeamId } from '../lobu/stores/slack-installations.js';
import { orgContext } from '../lobu/stores/org-context.js';
import { buildSlackChannelGraph, type SlackChannelInput } from './slack-channel-graph.js';

const logger = createLogger('slack-acl-sync');

/** Injectable seams so tests drive the real graph build + gate with a stubbed
 * Slack API and token resolver, and the live tick wires the real ones. */
export interface SlackAclSyncDeps {
  slackWeb: Pick<SlackWebApi, 'conversationMembers' | 'conversationInfo'>;
  /**
   * Resolve the bot IDENTITY for a workspace — its token plus the bot's own
   * Slack user id — from the app installation, or null if none is available (no
   * active install / unresolvable secret), which is treated fail-closed. The bot
   * id is sourced from the install (stamped at install time), NOT from the
   * connection metadata, whose `botUserId` is only backfilled lazily at adapter
   * init: in the window before the adapter first runs it is null, which would let
   * the bot slip into the `member_of` graph and the audience.
   */
  resolveBotIdentity: (params: {
    organizationId: string;
    teamId: string;
  }) => Promise<{ token: string; botUserId: string | null } | null>;
}

export interface SlackAclSyncResult {
  /** True when every bound Slack channel was fetched and graphed. */
  ok: boolean;
  teamsSynced: number;
  channelsSynced: number;
}

/** Downgrade an EXISTING ACL row to `failed` so the gate fails closed. A no-op
 * when the connection was never graphed (no row) — it stays on the legacy
 * fence rather than flipping to drop-everything on its first failure. */
async function markConnectionAclFailed(
  organizationId: string,
  connectionId: string,
): Promise<void> {
  const sql = getDb();
  await sql`
		UPDATE authz_source_acl_state
		SET freshness_state = 'failed', updated_at = current_timestamp
		WHERE organization_id = ${organizationId}
		  AND connection_id = ${connectionId}
	`;
}

/**
 * Sync ONE Slack connection's channel-membership graph. Resolves its captured
 * channels, fetches members per channel, and builds the graph (per team). See
 * the file header for the fail-closed contract.
 */
export async function syncSlackConnectionAcl(
  deps: SlackAclSyncDeps,
  params: { connectionId: string; organizationId: string },
): Promise<SlackAclSyncResult> {
  const { connectionId, organizationId } = params;
  const sql = getDb();

  const bound = await resolveBoundChannelRows(sql, {
    organizationId,
    connectionId,
  });

  // `resolveBoundChannelRows` joins bindings on (org, agent, platform) — NOT on
  // workspace — so an agent with a SECOND Slack connection (another workspace)
  // would pull that workspace's channels in here too. A real workspace
  // connection carries `metadata.teamId`; scope to it so we only ever fetch
  // members with THIS connection's token and stamp THIS connection's ACL state.
  // A preview connection (no teamId, the hosted-bot invariant) serves cross-org
  // bindings by design, so it stays unscoped.
  const [conn] = await sql<{ team_id: string | null }>`
		SELECT COALESCE(external_tenant_id, config->'chatMetadata'->>'teamId') AS team_id
		FROM connections
		WHERE slug = ${runtimeConnectionIdToSlug(connectionId)}
		  AND organization_id = ${organizationId}
		  AND credential_mode IS NOT NULL
		  AND deleted_at IS NULL
		LIMIT 1
	`;
  const connTeamId = conn?.team_id ?? null;

  // Only Slack rows that carry a team id can be team-scoped into the graph; a
  // channel with no team id is dropped fail-closed by the gate anyway.
  const slackRows = bound.filter(
    (r) =>
      r.platform.startsWith('slack') &&
      r.team_id &&
      (connTeamId === null || r.team_id === connTeamId),
  );
  if (slackRows.length === 0) {
    return { ok: true, teamsSynced: 0, channelsSynced: 0 };
  }

  // Group channels by workspace/team — one graph build per team.
  const byTeam = new Map<string, string[]>();
  for (const r of slackRows) {
    const channelId = stripPlatformPrefix(r.platform, r.channel_id);
    const list = byTeam.get(r.team_id as string) ?? [];
    list.push(channelId);
    byTeam.set(r.team_id as string, list);
  }

  let teamsSynced = 0;
  let channelsSynced = 0;
  try {
    for (const [teamId, channelIds] of byTeam) {
      const identity = await deps.resolveBotIdentity({ organizationId, teamId });
      if (!identity) {
        throw new Error(`No bot token for team ${teamId}`);
      }
      const { token, botUserId } = identity;
      const channels: SlackChannelInput[] = [];
      for (const channelId of channelIds) {
        const rawMembers = await deps.slackWeb.conversationMembers(
          token,
          channelId,
        );
        // The bot is itself a member of every channel it's in, so
        // `conversations.members` includes it. Drop it: a bot is not an audience
        // and must never gain a `member_of` edge (it would inflate "who can
        // recall" AND, via the gate, count as a member). The bot id is the
        // install's, scoped to THIS team. Absent it, we don't filter (no regression).
        const memberSlackUserIds = botUserId
          ? rawMembers.filter((u) => u !== botUserId)
          : rawMembers;
        // Channel name + privacy are BEST-EFFORT display metadata — a failure
        // here must NOT fail-close the whole sync (membership is the contract),
        // so swallow and fall back to the id-as-name in buildSlackChannelGraph.
        let name: string | undefined;
        let isPrivate: boolean | undefined;
        try {
          const info = await deps.slackWeb.conversationInfo(token, channelId);
          name = info.name ?? undefined;
          isPrivate = info.isPrivate;
        } catch (error) {
          logger.warn(
            { organization_id: organizationId, channel_id: channelId, error: String(error) },
            'Slack conversations.info failed — syncing channel without a name',
          );
        }
        channels.push({ channelId, name, isPrivate, memberSlackUserIds });
      }
      await buildSlackChannelGraph({
        organizationId,
        connectionId,
        teamId,
        channels,
      });
      teamsSynced += 1;
      channelsSynced += channels.length;
    }
    return { ok: true, teamsSynced, channelsSynced };
  } catch (error) {
    logger.error(
      {
        organization_id: organizationId,
        connection_id: connectionId,
        error: String(error),
      },
      'Slack ACL sync failed — marking connection fail-closed',
    );
    await markConnectionAclFailed(organizationId, connectionId);
    return { ok: false, teamsSynced, channelsSynced };
  }
}

/**
 * The periodic production caller (registered in `scheduled/jobs.ts`). Re-syncs
 * every active Slack connection's channel-membership graph so joins/leaves
 * converge within the tick cadence and the gate's freshness window keeps a
 * stalled connection fail-closed. Runs on one replica per tick (the TaskScheduler
 * runs-queue claim), iterating connections sequentially — membership sync is not
 * latency-critical.
 *
 * Token resolution keys on the workspace install (`getSlackInstallByTeamId`), so
 * it covers the prod OAuth-install path; a connection whose team has no active
 * install is skipped (its sync throws → fail-closed via {@link syncSlackConnectionAcl}).
 */
export async function runSlackAclSyncTick(coreServices: CoreServices): Promise<void> {
  const sql = getDb();
  const connRows = await sql<{ slug: string; organization_id: string }>`
		SELECT slug, organization_id
		FROM connections
		WHERE connector_key = 'slack'
		  AND status = 'active'
		  AND credential_mode IS NOT NULL
		  AND deleted_at IS NULL
	`;
  const connections = connRows.map((r) => ({
    id: slugToRuntimeConnectionId(r.slug),
    organization_id: r.organization_id,
  }));
  if (connections.length === 0) return;

  const installStore = coreServices.getAppInstallationStore();
  const secretStore = coreServices.getSecretStore();
  const slackWeb = createSlackWebApi();

  const deps: SlackAclSyncDeps = {
    slackWeb,
    resolveBotIdentity: async ({ teamId }) => {
      const install = await getSlackInstallByTeamId(installStore, teamId);
      if (!install || install.status !== 'active') return null;
      const tokenRef = (install.config as { botToken?: string }).botToken;
      const token = await orgContext.run({ organizationId: install.organizationId }, () =>
        resolveSecretValue(secretStore, tokenRef),
      );
      if (!token) return null;
      return { token, botUserId: install.botUserId ?? null };
    },
  };

  let ok = 0;
  let failed = 0;
  for (const conn of connections) {
    const result = await syncSlackConnectionAcl(deps, {
      connectionId: conn.id,
      organizationId: conn.organization_id,
    });
    if (result.ok) ok += 1;
    else failed += 1;
  }
  logger.info({ connections: connections.length, ok, failed }, 'Slack ACL sync tick complete');
}
