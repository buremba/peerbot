import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";

export default class WebhookConnector extends IntegrationConnector {
	readonly definition: ConnectorDefinition = {
		key: "webhook",
		kind: "integration",
		name: "Inbound webhook",
		description: "Receive authenticated JSON deliveries as Lobu events.",
		version: "1.0.1",
		authSchema: { methods: [{ type: "none", label: "Webhook token" }] },
		optionsSchema: {
			type: "object",
			"x-lobu-adapterless-platform": "webhook",
			required: ["token"],
			properties: {
				token: {
					type: "string",
					format: "password",
					title: "Bearer token",
					minLength: 32,
				},
				allowQueryAuth: {
					type: "boolean",
					title: "Allow query-string authentication",
				},
				dedupeHeader: { type: "string", title: "Dedupe header" },
				semanticType: { type: "string", title: "Semantic type" },
				titlePath: { type: "string", title: "Title JSON pointer" },
				searchable: { type: "boolean", title: "Searchable" },
			},
		},
		automationEvents: [
			{
				key: "delivery.received",
				label: "Delivery received",
				description:
					"A new authenticated JSON delivery was persisted by this webhook connection.",
				filterSchema: {
					type: "object",
					properties: {
						semantic_type: { type: "string", title: "Semantic type" },
					},
				},
				defaults: {
					execution: "turn",
					activeRun: "queue",
					output: "silent",
				},
			},
		],
	};
}
