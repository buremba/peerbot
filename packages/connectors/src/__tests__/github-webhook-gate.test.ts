/**
 * GitHub connector webhook registration gate (regression).
 *
 * Bug: the connector no-op'd registerWebhook/unregisterWebhook whenever its
 * STATIC `definition.webhook.delivery === 'app_installation'` — which is true for
 * EVERY github connection. That disabled per-connection webhook registration for
 * OAuth/PAT connections (which still need their own hook). The fix gates the
 * no-op on the CONNECTION's resolved auth (`config.installation_ref` /
 * `ctx.installation`), not the static delivery mode.
 *
 * This proves both branches:
 *   - an app_installation connection (config.installation_ref set) → register is
 *     a no-op (the HTTP layer is never reached),
 *   - an OAuth/PAT connection (org target + token, no installation_ref) → register
 *     DOES create a hook (the HTTP layer IS reached), and unregister DOES delete.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let GitHubConnector: any;

beforeAll(async () => {
	const mod = await import("../github");
	GitHubConnector = mod.default;
});

/**
 * Build a connector with `requestJson` (POST hook create) and `http.request`
 * (DELETE hook) replaced by spies, so we can assert whether the per-connection
 * provider call was reached without touching the network.
 */
function buildConnector() {
	const connector = new GitHubConnector();
	const requestJsonCalls: Array<Record<string, unknown>> = [];
	const httpRequestCalls: Array<{ url: string }> = [];
	// requestJson is the POST that creates the hook (returns { id }).
	connector.requestJson = async (params: Record<string, unknown>) => {
		requestJsonCalls.push(params);
		return { id: 998877 };
	};
	// http.request is the DELETE that tears the hook down.
	connector.http = {
		request: async (url: string) => {
			httpRequestCalls.push({ url });
			return new Response(null, { status: 204 });
		},
	};
	return { connector, requestJsonCalls, httpRequestCalls };
}

describe("GitHub webhook registration gate", () => {
	test("app_installation connection (installation_ref set) → register is a no-op, no HTTP call", async () => {
		const { connector, requestJsonCalls } = buildConnector();

		const result = await connector.registerWebhook({
			config: { installation_ref: 4242 },
			credentials: null,
			callbackUrl: "https://gw.test/api/v1/webhooks/1",
		});

		expect(result.externalId).toBe("");
		expect(result.metadata?.delivery).toBe("app_installation");
		expect(result.metadata?.noop).toBe(true);
		// CRITICAL: the per-connection provider hook-create was NEVER reached.
		expect(requestJsonCalls.length).toBe(0);
	});

	test("app_installation connection → unregister is a no-op, no HTTP call", async () => {
		const { connector, httpRequestCalls } = buildConnector();

		await connector.unregisterWebhook({
			config: { installation_ref: "4242" },
			credentials: null,
			callbackUrl: "https://gw.test/api/v1/webhooks/1",
			externalId: "should-be-ignored",
		});

		expect(httpRequestCalls.length).toBe(0);
	});

	test("OAuth/PAT connection (org target + token, no installation_ref) → register DOES create a hook", async () => {
		const { connector, requestJsonCalls } = buildConnector();

		const result = await connector.registerWebhook({
			config: { org: "acme-co" },
			credentials: { provider: "github", accessToken: "gho_oauth_token" },
			callbackUrl: "https://gw.test/api/v1/webhooks/2",
		});

		// A real per-connection hook id came back from the (spied) provider call.
		expect(result.externalId).toBe("998877");
		expect(result.metadata?.scope).toBe("org");
		// CRITICAL: the per-connection provider hook-create WAS reached exactly once,
		// against the org hooks endpoint.
		expect(requestJsonCalls.length).toBe(1);
		expect(requestJsonCalls[0].url).toBe("https://api.github.com/orgs/acme-co/hooks");
	});

	test("OAuth/PAT connection → unregister DOES delete the per-connection hook", async () => {
		const { connector, httpRequestCalls } = buildConnector();

		await connector.unregisterWebhook({
			config: { org: "acme-co" },
			credentials: { provider: "github", accessToken: "gho_oauth_token" },
			callbackUrl: "https://gw.test/api/v1/webhooks/2",
			externalId: "55501",
		});

		// CRITICAL: the per-connection hook DELETE WAS reached, targeting the hook id.
		expect(httpRequestCalls.length).toBe(1);
		expect(httpRequestCalls[0].url).toBe(
			"https://api.github.com/orgs/acme-co/hooks/55501",
		);
	});
});
