import { describe, expect, test } from "bun:test";
import { materializeConnectorBehaviorSignal } from "../../behaviors/connector-signal";

describe("materializeConnectorBehaviorSignal", () => {
	const draft = {
		event_type: "item.created",
		updated_event_type: "item.updated",
		resource_type: "item",
		resource_ref: "example:item:42",
		label: "Item 42",
		input_text: "Item 42 changed",
	};

	test("fills platform-owned fields for any connector", () => {
		expect(
			materializeConnectorBehaviorSignal({
				draft,
				change: "inserted",
				connectorKey: "example",
				connectionId: 17,
				deliveryId: "sync:7:event:91:2",
			}),
		).toMatchObject({
			connector_key: "example",
			connection_id: 17,
			event_type: "item.created",
			delivery_id: "sync:7:event:91:2",
		});
	});

	test("uses the update event for an existing row", () => {
		expect(
			materializeConnectorBehaviorSignal({
				draft,
				change: "superseded",
				connectorKey: "example",
				connectionId: 17,
				deliveryId: "sync:8:event:92:0",
			})?.event_type,
		).toBe("item.updated");
	});

	test("marks unchanged rows and skips superseding rows without an update event", () => {
		expect(
			materializeConnectorBehaviorSignal({
				draft,
				change: "unchanged",
				connectorKey: "example",
				connectionId: 17,
				deliveryId: "sync:9:event:92:0",
			}),
		).toMatchObject({
			event_type: "item.updated",
			delivery_id: "sync:9:event:92:0",
			unchanged: true,
		});
		expect(
			materializeConnectorBehaviorSignal({
				draft: { ...draft, updated_event_type: undefined },
				change: "superseded",
				connectorKey: "example",
				connectionId: 17,
				deliveryId: "sync:10:event:92:0",
			}),
		).toBeNull();
	});
});
