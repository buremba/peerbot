import type { BehaviorTrigger } from "@lobu/core/contracts/tools/manage-behaviors";
import type { DbClient } from "../db/client";
import {
	resolveStreamingChannelFeedId,
	softDeleteStreamingChannelFeed,
} from "../gateway/channels/channel-feed";

interface ChannelSubscriptionRef {
	connectionId: number;
	connectorKey: string;
	channelKey: string;
}

function channelSubscriptions(
	triggers: BehaviorTrigger[],
): ChannelSubscriptionRef[] {
	const refs: ChannelSubscriptionRef[] = [];
	for (const trigger of triggers) {
		if (
			trigger.kind !== "event" ||
			trigger.connection_id == null ||
			!trigger.event_types.includes("message.created")
		) {
			continue;
		}
		const nativeChannelId = trigger.match?.channel_id;
		if (typeof nativeChannelId !== "string" || !nativeChannelId.trim()) continue;
		refs.push({
			connectionId: trigger.connection_id,
			connectorKey: trigger.connector_key,
			channelKey: `${trigger.connector_key}:${nativeChannelId.trim()}`,
		});
	}
	return refs;
}

function key(ref: ChannelSubscriptionRef): string {
	return `${ref.connectionId}:${ref.channelKey}`;
}

/** Keep streaming-feed projections aligned with canonical Behavior triggers. */
export async function syncBehaviorChannelFeeds(args: {
	organizationId: string;
	before?: BehaviorTrigger[];
	after?: BehaviorTrigger[];
	sql: DbClient;
}): Promise<void> {
	const before = channelSubscriptions(args.before ?? []);
	const after = channelSubscriptions(args.after ?? []);
	const beforeKeys = new Set(before.map(key));
	const afterKeys = new Set(after.map(key));

	for (const ref of after) {
		if (beforeKeys.has(key(ref))) continue;
		await resolveStreamingChannelFeedId({
			connectionId: String(ref.connectionId),
			organizationId: args.organizationId,
			channelKey: ref.channelKey,
			sql: args.sql,
		});
	}

	for (const ref of before) {
		if (afterKeys.has(key(ref))) continue;
		const remaining = await args.sql`
			SELECT 1
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
			  AND trigger->>'kind' = 'event'
			  AND jsonb_typeof(trigger->'connection_id') = 'number'
			  AND trigger->'event_types' ? 'message.created'
			  AND jsonb_typeof(trigger->'match') = 'object'
			  AND c.id = ${ref.connectionId}
			  AND COALESCE(
				NULLIF(trigger->'match'->>'channel_key', ''),
				(trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
			  ) = ${ref.channelKey}
			LIMIT 1
		`;
		if (remaining.length > 0) continue;
		await softDeleteStreamingChannelFeed({
			connectionId: String(ref.connectionId),
			channelKey: ref.channelKey,
			sql: args.sql,
		});
	}
}
