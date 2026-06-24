import type { ConnectorAuthAppInstallation } from "@lobu/connector-sdk";
import { describe, expect, it } from "bun:test";
import {
	renderAppInstallUrl,
	resolveAppInstallCredentials,
} from "../app-install-credentials.js";

const method: ConnectorAuthAppInstallation = {
	type: "app_installation",
	provider: "github",
	providerInstance: "cloud",
	appIdKey: "GITHUB_APP_ID",
	privateKeyKey: "GITHUB_APP_PRIVATE_KEY",
	appSlugKey: "GITHUB_APP_SLUG",
	clientIdKey: "GITHUB_APP_CLIENT_ID",
	clientSecretKey: "GITHUB_APP_CLIENT_SECRET",
	webhookSecretKey: "GITHUB_APP_WEBHOOK_SECRET",
	installUrlTemplate: "https://github.com/apps/{{app_slug}}/installations/new",
};

describe("resolveAppInstallCredentials", () => {
	it("reads each credential from the env var NAME the connector declares", () => {
		const env = {
			GITHUB_APP_ID: "4112538",
			GITHUB_APP_PRIVATE_KEY: "pk",
			GITHUB_APP_SLUG: "lobu-ai",
			GITHUB_APP_CLIENT_ID: "Iv23xxx",
			GITHUB_APP_CLIENT_SECRET: "shh",
			GITHUB_APP_WEBHOOK_SECRET: "whsec",
		} as unknown as NodeJS.ProcessEnv;
		const creds = resolveAppInstallCredentials(method, env);
		expect(creds).toMatchObject({
			appId: "4112538",
			privateKey: "pk",
			appSlug: "lobu-ai",
			clientId: "Iv23xxx",
			clientSecret: "shh",
			webhookSecret: "whsec",
			appIdKey: "GITHUB_APP_ID",
			privateKeyKey: "GITHUB_APP_PRIVATE_KEY",
		});
	});

	it("leaves values undefined when the declared env var is unset (no literal fallback)", () => {
		const creds = resolveAppInstallCredentials(method, {} as NodeJS.ProcessEnv);
		expect(creds.appId).toBeUndefined();
		expect(creds.clientId).toBeUndefined();
		expect(creds.webhookSecret).toBeUndefined();
		// declared key NAMES are still surfaced for stamping onto the install row
		expect(creds.appIdKey).toBe("GITHUB_APP_ID");
	});

	it("ignores credentials whose key the connector does not declare", () => {
		const partial: ConnectorAuthAppInstallation = {
			type: "app_installation",
			provider: "x",
			appIdKey: "X_APP_ID",
		};
		const creds = resolveAppInstallCredentials(partial, {
			X_APP_ID: "1",
			X_APP_CLIENT_ID: "should-be-ignored",
		} as unknown as NodeJS.ProcessEnv);
		expect(creds.appId).toBe("1");
		expect(creds.clientId).toBeUndefined();
	});
});

describe("renderAppInstallUrl", () => {
	it("substitutes {{app_slug}} and appends state", () => {
		const url = renderAppInstallUrl(
			method.installUrlTemplate,
			"lobu-ai",
			"state-123",
		);
		expect(url).toBe(
			"https://github.com/apps/lobu-ai/installations/new?state=state-123",
		);
	});

	it("url-encodes the slug", () => {
		const url = renderAppInstallUrl(
			"https://github.com/apps/{{app_slug}}/installations/new",
			"a b/c",
			"s",
		);
		expect(url).toContain("apps/a%20b%2Fc/installations/new");
	});

	it("returns null when no template is declared", () => {
		expect(renderAppInstallUrl(undefined, "lobu-ai", "s")).toBeNull();
	});
});
