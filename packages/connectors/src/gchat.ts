import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";

export default class GoogleChatConnector extends IntegrationConnector {
	readonly definition: ConnectorDefinition = {
		key: "gchat",
		kind: "integration",
		name: "Google Chat",
		description: "Connect a Google Chat app to Lobu.",
		version: "1.0.0",
		faviconDomain: "chat.google.com",
		authSchema: { methods: [{ type: "none", label: "Service account" }] },
		optionsSchema: {
			type: "object",
			"x-lobu-chat-platform": "gchat",
			properties: {
				credentials: {
					type: "string",
					format: "password",
					title: "Service account JSON",
				},
				googleChatProjectNumber: { type: "string", title: "Project number" },
				endpointUrl: { type: "string", title: "Endpoint URL" },
			},
			required: ["credentials", "googleChatProjectNumber"],
		},
	};
}
