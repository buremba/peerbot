import { setManualChannelAboutEdges } from "../../../../authz/channel-about";
import { getDb } from "../../../../db/client";
import { resolveSubscriptionTeam } from "../../../../gateway/channels/subscription-scope-resolver";
import { assertEntityIdsInOrg } from "../../helpers/db-helpers";
import type { ToolContext } from "../../../registry";
import type { ConnectionsArgs, ManageConnectionsResult } from "../schemas";

/** Set manual business-entity links for a chat channel (UI picker). */
export async function handleSetChannelAbout(
	args: Extract<ConnectionsArgs, { action: "set_channel_about" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	const { organizationId, userId } = ctx;
	const sql = getDb();
	const rows = await sql<{
		id: number;
		connector_key: string;
		external_tenant_id: string | null;
	}>`
		SELECT id, connector_key, external_tenant_id
		FROM connections
		WHERE id = ${args.connection_id}
		  AND organization_id = ${organizationId}
		  AND credential_mode IS NOT NULL
		  AND deleted_at IS NULL
		LIMIT 1
	`;
	const connection = rows[0];
	if (!connection) return { error: "Chat connection not found" };

	const subscribedTeam = await sql<{ team_id: string | null }>`
		SELECT team_id
		FROM (
			SELECT COALESCE(
				NULLIF(trigger->'match'->>'team_id', ''),
				c.external_tenant_id,
				c.config->'chatMetadata'->>'teamId'
			) AS team_id
			FROM watchers w
			CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
			JOIN connections c
			  ON c.id = CASE
				WHEN jsonb_typeof(trigger->'connection_id') = 'number'
					THEN (trigger->>'connection_id')::bigint
				ELSE NULL
			  END
			 AND c.connector_key = trigger->>'connector_key'
			 AND c.deleted_at IS NULL
			WHERE w.status = 'active'
			  AND w.organization_id = ${organizationId}
			  AND trigger->>'kind' = 'event'
			  AND jsonb_typeof(trigger->'connection_id') = 'number'
			  AND c.id = ${connection.id}
			  AND trigger->'event_types' ? 'message.created'
			  AND COALESCE(
				NULLIF(trigger->'match'->>'channel_key', ''),
				(trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
			  ) = ${args.channel_id}
		) subscribed
		WHERE team_id IS NOT NULL
		LIMIT 1
	`;
	const teamId =
		subscribedTeam[0]?.team_id ??
		(await resolveSubscriptionTeam({
			connection: {
				connectorKey: connection.connector_key,
				externalTenantId: connection.external_tenant_id,
				connectionId: connection.id,
				organizationId,
			},
			channelId: args.channel_id,
		})) ??
		undefined;

	try {
		await assertEntityIdsInOrg(sql, organizationId, args.about_entity_ids);
		await setManualChannelAboutEdges({
			organizationId,
			connectionId: connection.id,
			connectorKey: connection.connector_key,
			teamId,
			channelId: args.channel_id,
			aboutEntityIds: args.about_entity_ids,
			userId,
			sql,
		});
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: "Failed to set channel about links",
		};
	}

	return {
		action: "set_channel_about",
		success: true,
		connection_id: connection.id,
		channel_id: args.channel_id,
		about_entity_ids: args.about_entity_ids,
	};
}
