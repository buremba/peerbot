import type { AutomationDeliveryTarget } from '@lobu/core/contracts/tools/manage-automations';
import type { DbClient } from '../db/client';
import {
  resolveBoundChannelRows,
  stripPlatformPrefix,
} from '../gateway/channels/bound-channels';
import { ToolUserError } from '../utils/errors';

interface ResolvedAutomationDeliveryTarget {
  connectionId: string;
  channelId: string;
  teamId: string | null;
}

interface ConfiguredAutomationDeliveryTarget {
  configured: boolean;
  target: ResolvedAutomationDeliveryTarget | null;
}

/**
 * Resolve a public Automation delivery target through the canonical bound-channel
 * resolver. A numeric connection id alone is never authority: the target must
 * be an active channel binding owned by the same organization and agent as the
 * Automation. Hosted-preview bindings retain the same workspace guard as normal
 * inbound/proactive routing.
 */
async function resolveAutomationDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  agentId: string | null,
  target: AutomationDeliveryTarget
): Promise<ResolvedAutomationDeliveryTarget | null> {
  if (!agentId) return null;

  const rows = await resolveBoundChannelRows(sql, {
    organizationId,
    agentId,
    connectionDbId: target.connection_id,
  });
  const row = rows.find((candidate) => {
    const candidateNativeId = stripPlatformPrefix(
      candidate.platform,
      candidate.channel_id
    );
    const targetNativeId = stripPlatformPrefix(
      candidate.platform,
      target.channel_id
    );
    return candidateNativeId === targetNativeId;
  });
  if (!row) return null;
  return {
    connectionId: row.id,
    channelId: `${row.platform}:${stripPlatformPrefix(
      row.platform,
      row.channel_id
    )}`,
    teamId: row.team_id,
  };
}

export async function assertAutomationDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  agentId: string | null,
  target: AutomationDeliveryTarget
): Promise<AutomationDeliveryTarget> {
  const resolved = await resolveAutomationDeliveryTarget(
    sql,
    organizationId,
    agentId,
    target
  );
  if (!resolved) {
    throw new ToolUserError(
      'Automation delivery target must be an active chat channel already bound to the same agent. Link the private channel first, then select it as the delivery channel.',
      422
    );
  }
  return {
    connection_id: target.connection_id,
    channel_id: resolved.channelId,
  };
}

/**
 * Read the server-owned route for a notification emitted by an Automation.
 * `configured: true, target: null` means the stored target became unavailable;
 * callers must fail closed rather than fall back to another bound channel.
 */
export async function loadConfiguredAutomationDeliveryTarget(
  sql: DbClient,
  organizationId: string,
  automationId: number
): Promise<ConfiguredAutomationDeliveryTarget> {
  const rows = await sql<{
    agent_id: string | null;
    delivery_target: AutomationDeliveryTarget | null;
  }>`
    SELECT agent_id, delivery_target
    FROM automations
    WHERE id = ${automationId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.delivery_target) return { configured: false, target: null };
  return {
    configured: true,
    target: await resolveAutomationDeliveryTarget(
      sql,
      organizationId,
      row.agent_id,
      row.delivery_target
    ),
  };
}
