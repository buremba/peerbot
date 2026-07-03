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
		version: "1.0.0",
		authSchema: { methods: [{ type: "none", label: "Webhook token" }] },
		optionsSchema: {
			type: "object",
			properties: {
				token: { type: "string", format: "password", title: "Bearer token" },
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
	};
}
