import { describe, expect, test } from "bun:test";
import { buildWebhookAutomationSignal } from "../../gateway/connections/webhook-ingest";

describe("generic webhook Automation signal", () => {
	test("carries exact durable identity and only trusted routing metadata", () => {
		const signal = buildWebhookAutomationSignal({
			connectionId: 7,
			eventId: 42,
			originId: "provider-delivery-42",
			semanticType: "alert",
			title: "Production alert",
			payload: {
				severity: "critical",
				attempt: 3,
				semantic_type: "sender-controlled",
				nested: { ignored: true },
			},
			occurredAt: new Date("2026-08-30T12:00:00.000Z"),
		});

		expect(signal).toMatchObject({
			connector_key: "webhook",
			connection_id: 7,
			resource_type: "alert",
			resource_ref: "provider-delivery-42",
			event_type: "delivery.received",
			delivery_id: "webhook:event:42",
			label: "Production alert",
			occurred_at: "2026-08-30T12:00:00.000Z",
			attributes: { semantic_type: "alert" },
		});
		expect(signal.input_text).toContain("severity: critical");
		expect(signal.attributes).toEqual({ semantic_type: "alert" });
	});

	test("bounds deeply nested payloads without recursive stack overflow", () => {
		const payload: Record<string, unknown> = {};
		let cursor = payload;
		for (let depth = 0; depth < 10_000; depth += 1) {
			const child: Record<string, unknown> = {};
			cursor.child = child;
			cursor = child;
		}

		const signal = buildWebhookAutomationSignal({
			connectionId: 7,
			eventId: 43,
			originId: "deep-delivery",
			semanticType: "content",
			payload,
			occurredAt: new Date("2026-08-30T12:00:00.000Z"),
		});

		expect(signal.input_text).toContain("[nested value]");
		expect(signal.input_text.length).toBeLessThanOrEqual(8 * 1024);
	});

	test("bounds traversal of a request-sized wide array", () => {
		const signal = buildWebhookAutomationSignal({
			connectionId: 7,
			eventId: 44,
			originId: "wide-delivery",
			semanticType: "content",
			payload: { values: Array.from({ length: 100_000 }, () => 0) },
			occurredAt: new Date("2026-08-30T12:00:00.000Z"),
		});

		expect(signal.input_text).toStartWith("values.0: 0");
		expect(signal.input_text.length).toBeLessThanOrEqual(8 * 1024);
	});
});
