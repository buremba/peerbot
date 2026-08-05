import { describe, expect, test } from "bun:test";
import { buildAppInstallationSetupError } from "../../../../../tools/admin/helpers/connector-setup-errors";
import { buildSlackSelfInstallDeepLink } from "../../../../../tools/admin/helpers/slack-self-install";

const method = {
	type: "app_installation" as const,
	provider: "slack",
	installShape: "oauth-code-exchange" as const,
	permissions: ["app_mentions:read", "chat:write", "mcp:connect"],
	events: ["app_mention", "message.im"],
};

describe("buildSlackSelfInstallDeepLink", () => {
	test("builds a Slack create-app deep link whose manifest carries the declared scopes + events", () => {
		const link = buildSlackSelfInstallDeepLink({
			method,
			gatewayOrigin: "https://gateway.example.com",
		});
		expect(link).toBeDefined();

		const url = new URL(link!);
		expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
		expect(url.searchParams.get("new_app")).toBe("1");

		const manifest = JSON.parse(url.searchParams.get("manifest_json")!);
		expect(manifest.oauth_config.scopes.bot).toEqual(method.permissions);
		expect(manifest.settings.event_subscriptions.bot_events).toEqual(
			method.events,
		);
		// The gateway's MCP server is wired into the manifest so Slackbot can
		// discover Lobu's MCP server once the app connects.
		expect(manifest.mcp_servers.lobu.url).toBe(
			"https://gateway.example.com/mcp",
		);
		expect(manifest.mcp_servers.lobu.auth_type).toBe(
			"dynamic_client_registration",
		);
	});

	test("omits the mcp_servers block when no gateway origin is known", () => {
		const link = buildSlackSelfInstallDeepLink({ method });
		const url = new URL(link!);
		const manifest = JSON.parse(url.searchParams.get("manifest_json")!);
		expect(manifest.mcp_servers).toBeUndefined();
	});

	test("returns undefined when the method declares no bot scopes (e.g. github app_installation)", () => {
		const link = buildSlackSelfInstallDeepLink({
			method: { type: "app_installation", provider: "github" },
		});
		expect(link).toBeUndefined();
	});
});

describe("buildAppInstallationSetupError — self_install_url gating", () => {
	test("a malformed gateway URL must not turn setup guidance into a tool failure", () => {
		const previous = process.env.SLACK_CLIENT_ID;
		delete process.env.SLACK_CLIENT_ID;
		try {
			const res = buildAppInstallationSetupError({
				connectorKey: "slack",
				method: {
					type: "app_installation",
					provider: "slack",
					clientIdKey: "SLACK_CLIENT_ID",
					permissions: ["chat:write", "mcp:connect"],
					events: ["app_mention"],
				},
				// getGatewayBaseUrl passes unparsable values through (see its
				// try/catch fallback), so the MCP-origin derivation must survive this.
				gatewayBaseUrl: "not-a-valid-url",
				hasByoMethod: true,
			});
			expect(res.install_url).toBeUndefined();
			expect(res.self_install_url).toBeDefined();
			const url = new URL(res.self_install_url!);
			const manifest = JSON.parse(url.searchParams.get("manifest_json")!);
			// No gateway origin → the MCP server block is omitted, not thrown away.
			expect(manifest.mcp_servers).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.SLACK_CLIENT_ID;
			else process.env.SLACK_CLIENT_ID = previous;
		}
	});
});
