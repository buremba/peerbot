import type {
	ConnectorBehaviorSignalDraft,
	ConnectorTriggerSignal,
} from "@lobu/connector-sdk";
import type { InsertedEvent } from "../utils/insert-event";

/**
 * Fill platform-owned routing and idempotency fields after the source event has
 * committed. Connector code owns provider interpretation; this function is
 * intentionally connector-neutral.
 */
export function materializeConnectorBehaviorSignal(args: {
	draft: ConnectorBehaviorSignalDraft;
	change: InsertedEvent["change"];
	connectorKey: string;
	connectionId: number | null;
	eventId: number;
	draftIndex: number;
}): ConnectorTriggerSignal | null {
	if (args.change === "unchanged" || args.connectionId == null) return null;
	const eventType =
		args.change === "superseded"
			? args.draft.updated_event_type
			: args.draft.event_type;
	if (!eventType) return null;

	return {
		connector_key: args.connectorKey,
		connection_id: args.connectionId,
		resource_type: args.draft.resource_type,
		resource_ref: args.draft.resource_ref,
		event_type: eventType,
		delivery_id: `event:${args.eventId}:${args.draftIndex}`,
		label: args.draft.label,
		input_text: args.draft.input_text,
		url: args.draft.url,
		occurred_at: args.draft.occurred_at,
		attributes: args.draft.attributes,
	};
}
