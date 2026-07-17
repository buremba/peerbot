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
				eventId: 91,
				draftIndex: 2,
			}),
		).toMatchObject({
			connector_key: "example",
			connection_id: 17,
			event_type: "item.created",
			delivery_id: "event:91:2",
		});
	});

	test("uses the update event only for a superseding row", () => {
		expect(
			materializeConnectorBehaviorSignal({
				draft,
				change: "superseded",
				connectorKey: "example",
				connectionId: 17,
				eventId: 92,
				draftIndex: 0,
			})?.event_type,
		).toBe("item.updated");
	});

	test("skips unchanged rows and updates without an update event", () => {
		expect(
			materializeConnectorBehaviorSignal({
				draft,
				change: "unchanged",
				connectorKey: "example",
				connectionId: 17,
				eventId: 92,
				draftIndex: 0,
			}),
		).toBeNull();
		expect(
			materializeConnectorBehaviorSignal({
				draft: { ...draft, updated_event_type: undefined },
				change: "superseded",
				connectorKey: "example",
				connectionId: 17,
				eventId: 92,
				draftIndex: 0,
			}),
		).toBeNull();
	});
});
