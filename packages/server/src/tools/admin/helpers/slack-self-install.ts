import type { ConnectorAuthAppInstallation } from "@lobu/connector-sdk";

const SLACK_APP_CREATE_URL = "https://api.slack.com/apps";

/**
 * Build the Slack "create an app from a manifest" deep link
 * (`https://api.slack.com/apps?new_app=1&manifest_json=…`) for a BYO /
 * self-install Slack app.
 *
 * The manifest is populated from the connector's `app_installation` method —
 * the single source of truth for bot scopes + events — plus the gateway's MCP
 * server when an origin is known, so the created app carries the right scopes,
 * events, and Slackbot MCP wiring from the start.
 *
 * Deliberately OMITS webhook request_urls and slash-command URLs: those need a
 * per-connection id that does not exist until the app has been installed and
 * its bot token returned, and a bootstrap manifest must pass Slack's
 * create-time validation without them. After the connection exists, the
 * connection settings surface shows the full manifest (with the real webhook
 * URL) to paste back into the app.
 *
 * Returns `undefined` for connectors that don't declare app-install bot scopes
 * (e.g. github's app_installation has no `permissions`), so the deep link is
 * only advertised for connectors where a self-created app is actually viable.
 */
export function buildSlackSelfInstallDeepLink(params: {
	method: ConnectorAuthAppInstallation;
	gatewayOrigin?: string;
}): string | undefined {
	const permissions = params.method.permissions;
	if (!permissions || permissions.length === 0) return undefined;

	const manifest: Record<string, unknown> = {
		display_information: {
			name: "Lobu Agent",
			description:
				"Sandboxed agent connected to a Lobu gateway. Scopes and events match what the gateway needs for mentions, threads, slash commands, and DM assistant chat.",
			background_color: "#4a154b",
		},
		features: {
			app_home: {
				home_tab_enabled: true,
				messages_tab_enabled: true,
				messages_tab_read_only_enabled: false,
			},
			bot_user: {
				display_name: "Lobu",
				always_online: true,
			},
		},
		oauth_config: {
			scopes: { bot: permissions },
		},
		settings: {
			event_subscriptions: {
				bot_events: params.method.events ?? [],
			},
			org_deploy_enabled: true,
			socket_mode_enabled: false,
			token_rotation_enabled: false,
		},
	};

	if (params.gatewayOrigin) {
		manifest.mcp_servers = {
			lobu: {
				url: `${params.gatewayOrigin}/mcp`,
				auth_type: "dynamic_client_registration",
			},
		};
	}

	return `${SLACK_APP_CREATE_URL}?new_app=1&manifest_json=${encodeURIComponent(
		JSON.stringify(manifest),
	)}`;
}
