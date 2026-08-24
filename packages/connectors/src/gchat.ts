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
		version: "1.0.1",
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
				helpCommandId: {
					type: "string",
					pattern: "^(?:[1-9][0-9]{0,2}|1000)$",
					title: "Help command ID",
					description:
						"Command ID (1-1000) configured for Lobu help in this Google Cloud project.",
				},
				endpointUrl: { type: "string", title: "Endpoint URL" },
			},
			required: ["credentials", "googleChatProjectNumber"],
		},
	};
}
