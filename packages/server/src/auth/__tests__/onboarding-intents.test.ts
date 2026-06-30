import { describe, expect, test } from "bun:test";
import {
	installUrlFor,
	resolveAppInstallOnboardingCandidate,
} from "../onboarding-intent-decision";

const slackAuthSchema = {
	methods: [
		{
			type: "app_installation",
			provider: "slack",
			installShape: "oauth-code-exchange",
		},
		{
			type: "oauth",
			provider: "slack",
			requiredScopes: ["openid"],
			loginScopes: ["openid", "email", "profile"],
		},
	],
};

describe("auth onboarding intent decisions", () => {
	test("creates an app install candidate for new social signups", () => {
		expect(
			resolveAppInstallOnboardingCandidate({
				hasNewUserMarker: true,
				providerId: "slack",
				connectors: [{ key: "slack", auth_schema: slackAuthSchema }],
			}),
		).toEqual({
			connectorKey: "slack",
			provider: "slack",
			installShape: "oauth-code-exchange",
		});
	});

	test("does not create a candidate for returning users or account links", () => {
		expect(
			resolveAppInstallOnboardingCandidate({
				hasNewUserMarker: false,
				providerId: "slack",
				connectors: [{ key: "slack", auth_schema: slackAuthSchema }],
			}),
		).toBeNull();
	});

	test("requires the login provider to also have an app installation method", () => {
		expect(
			resolveAppInstallOnboardingCandidate({
				hasNewUserMarker: true,
				providerId: "slack",
				connectors: [
					{
						key: "generic_oauth",
						auth_schema: {
							methods: [
								{
									type: "oauth",
									provider: "slack",
									requiredScopes: ["openid"],
									loginScopes: ["openid"],
								},
							],
						},
					},
				],
			}),
		).toBeNull();
	});

	test("builds provider install URLs from install shape", () => {
		expect(installUrlFor("slack", "oauth-code-exchange")).toBe(
			"/lobu/slack/install",
		);
		expect(installUrlFor("github", "github-app")).toBe(
			"/lobu/github/app/install",
		);
	});
});
