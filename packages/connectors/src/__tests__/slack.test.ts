import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after shared SDK mock
let SlackConnector: any;

beforeAll(async () => {
	const module = await import("../slack");
	SlackConnector = module.default;
});

describe("Slack connector declaration", () => {
	test("keeps install scopes aligned with the manifest and includes Slackbot MCP", () => {
		const manifest = JSON.parse(
			readFileSync(
				new URL(
					"../../../../config/slack-app-manifest.self-install.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const connector = new SlackConnector();
		const installMethod = connector.definition.authSchema?.methods.find(
			(method: { type: string }) => method.type === "app_installation",
		);

		expect(installMethod?.permissions).toContain("mcp:connect");
		expect(installMethod?.permissions).toEqual(manifest.oauth_config.scopes.bot);
	});
});
