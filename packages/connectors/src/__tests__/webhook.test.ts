import { describe, expect, test } from "bun:test";
import WebhookConnector from "../webhook";

describe("webhook connector", () => {
	test("uses the existing adapterless connection lifecycle", () => {
		const connector = new WebhookConnector();
		expect(connector.definition.optionsSchema).toMatchObject({
			"x-lobu-adapterless-platform": "webhook",
		});
		expect(connector.definition.optionsSchema).not.toHaveProperty(
			"x-lobu-chat-platform",
		);
	});

	test("declares the durable delivery Automation event", () => {
		const connector = new WebhookConnector();
		expect(connector.definition.automationEvents).toContainEqual(
			expect.objectContaining({
				key: "delivery.received",
				defaults: {
					execution: "turn",
					activeRun: "queue",
					output: "silent",
				},
			}),
		);
	});
});
