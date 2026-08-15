import type { BehaviorDeliveryTarget } from '@lobu/core/contracts/tools/manage-behaviors';
import type { DbClient } from '../db/client';
import {
  resolveBoundChannelRows,
  stripPlatformPrefix,
} from '../gateway/channels/bound-channels';
import { ToolUserError } from '../utils/errors';

interface ResolvedBehaviorDeliveryTarget {
  connectionId: string;
  channelId: string;
  teamId: string | null;
}

interface ConfiguredBehaviorDeliveryTarget {
  configured: boolean;
  target: ResolvedBehaviorDeliveryTarget | null;
}

/**
 * Resolve a public Behavior delivery target through the canonical bound-channel
 * resolver. A numeric connection id alone is never authority: the target must
 * be an active channel binding owned by the same organization and agent as the
 * Behavior. Hosted-preview bindings retain the same workspace guard as normal
 * inbound/proactive routing.
 */
async function resolveBehaviorDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  agentId: string | null,
  target: BehaviorDeliveryTarget
): Promise<ResolvedBehaviorDeliveryTarget | null> {
  if (!agentId) return null;

  const rows = await resolveBoundChannelRows(sql, {
    organizationId,
    agentId,
    connectionDbId: target.connection_id,
  });
  const row = rows.find(
    (candidate) =>
      candidate.channel_id === target.channel_id ||
      (!target.channel_id.includes(':') &&
        stripPlatformPrefix(candidate.platform, candidate.channel_id) ===
          target.channel_id)
  );
  if (!row) return null;
  return {
    connectionId: row.id,
    channelId: row.channel_id,
    teamId: row.team_id,
  };
}

export async function assertBehaviorDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  agentId: string | null,
  target: BehaviorDeliveryTarget
): Promise<BehaviorDeliveryTarget> {
  const resolved = await resolveBehaviorDeliveryTarget(
    sql,
    organizationId,
    agentId,
    target
  );
  if (!resolved) {
    throw new ToolUserError(
      'Behavior delivery target must be an active chat channel already bound to the same agent. Link the private channel first, then select it as the delivery channel.',
      422
    );
  }
  return {
    connection_id: target.connection_id,
    channel_id: resolved.channelId,
  };
}

/**
 * Read the server-owned route for a notification emitted by a Behavior.
 * `configured: true, target: null` means the stored target became unavailable;
 * callers must fail closed rather than fall back to another bound channel.
 */
export async function loadConfiguredBehaviorDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  behaviorId: number
): Promise<ConfiguredBehaviorDeliveryTarget> {
  const rows = await sql<{
    agent_id: string | null;
    delivery_target: BehaviorDeliveryTarget | null;
  }>`
    SELECT agent_id, delivery_target
    FROM watchers
    WHERE id = ${behaviorId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.delivery_target) return { configured: false, target: null };
  return {
    configured: true,
    target: await resolveBehaviorDeliveryTarget(
      sql,
      organizationId,
      row.agent_id,
      row.delivery_target
    ),
  };
}
