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
	deliveryId: string;
}): ConnectorTriggerSignal | null {
	if (args.connectionId == null) return null;
	const eventType =
		args.change === "inserted"
			? args.draft.event_type
			: (args.draft.updated_event_type ??
				(args.change === "unchanged" ? args.draft.event_type : undefined));
	if (!eventType) return null;

	return {
		connector_key: args.connectorKey,
		connection_id: args.connectionId,
		resource_type: args.draft.resource_type,
		resource_ref: args.draft.resource_ref,
		event_type: eventType,
		delivery_id: args.deliveryId,
		label: args.draft.label,
		input_text: args.draft.input_text,
		url: args.draft.url,
		occurred_at: args.draft.occurred_at,
		attributes: args.draft.attributes,
		unchanged: args.change === "unchanged" ? true : undefined,
	};
}
