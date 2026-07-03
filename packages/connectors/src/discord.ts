import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";

export default class DiscordConnector extends IntegrationConnector {
	readonly definition: ConnectorDefinition = {
		key: "discord",
		kind: "integration",
		name: "Discord",
		description:
			"Connect a Discord bot and route server conversations to Lobu agents.",
		version: "1.0.0",
		faviconDomain: "discord.com",
		authSchema: { methods: [{ type: "none", label: "Bot credentials" }] },
		optionsSchema: {
			type: "object",
			"x-lobu-chat-platform": "discord",
			properties: {
				botToken: { type: "string", format: "password", title: "Bot token" },
				applicationId: { type: "string", title: "Application ID" },
				publicKey: {
					type: "string",
					format: "password",
					title: "Application public key",
				},
			},
			required: ["botToken", "applicationId", "publicKey"],
		},
	};
}
