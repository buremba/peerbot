import { describe, expect, it } from "vitest";

import SlackConnector from "../slack.js";

describe("Slack connector declaration", () => {
	it("requests the Slackbot MCP scope during app installation", () => {
		const connector = new SlackConnector();
		const installMethod = connector.definition.authSchema?.methods.find(
			(method) => method.type === "app_installation",
		);

		expect(installMethod?.permissions).toContain("mcp:connect");
	});
});
