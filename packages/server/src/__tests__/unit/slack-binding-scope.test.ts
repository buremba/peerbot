import { describe, expect, it } from "vitest";
import type { BindingConnection } from "../../gateway/channels/binding-scope-resolver";
import { resolveBindingTeam } from "../../gateway/channels/binding-scope-resolver";
import { resolveSlackBindingTeam } from "../../gateway/connections/slack-binding-scope";

/**
 * The binding-team invariant: `agent_channel_bindings.team_id` is ALWAYS the
 * concrete WORKSPACE (`T…`), never a Grid ENTERPRISE id (`E…`). These cover the
 * connector resolver's non-DB branches (hint priority, `T…`-stored fast path)
 * and the generic default dispatch. The `E…` → conversations.info branch (which
 * loads a bot token from the DB) is covered end-to-end in the integration suite.
 */

const ENTERPRISE = "E0BDSKL1KJL";
const WORKSPACE = "T0BF8TKGW79";

function conn(externalTenantId: string | null): BindingConnection {
	return {
		connectorKey: "slack",
		externalTenantId,
		connectionId: 1,
		organizationId: "org-1",
	};
}

// Stub: any conversations.info call would throw — proves the non-DB branches
// resolve WITHOUT ever hitting Slack.
const throwingWeb = {
	conversationInfo: async () => {
		throw new Error("conversations.info must not be called on these branches");
	},
};
const unusedSecretStore = {
	get: async () => {
		throw new Error("secret store must not be used on these branches");
	},
};

describe("resolveSlackBindingTeam", () => {
	it("prefers a trusted workspace (T…) hint over everything, no round-trip", async () => {
		const team = await resolveSlackBindingTeam(
			{ slackWeb: throwingWeb, secretStore: unusedSecretStore },
			{ connection: conn(ENTERPRISE), channelId: "slack:C1", workspaceHint: WORKSPACE },
		);
		expect(team).toBe(WORKSPACE);
	});

	it("uses the connection's stored tenant id when it is already a workspace (T…)", async () => {
		const team = await resolveSlackBindingTeam(
			{ slackWeb: throwingWeb, secretStore: unusedSecretStore },
			{ connection: conn(WORKSPACE), channelId: "slack:C1" },
		);
		expect(team).toBe(WORKSPACE);
	});

});

describe("resolveBindingTeam (generic dispatch)", () => {
	it("defaults a non-Slack connector to the connection's stored tenant id", async () => {
		const team = await resolveBindingTeam({
			connection: {
				connectorKey: "telegram",
				externalTenantId: "chat-999",
				connectionId: 2,
				organizationId: "org-1",
			},
			channelId: "telegram:998877",
		});
		expect(team).toBe("chat-999");
	});

	it("a trusted hint wins for the default connector too", async () => {
		const team = await resolveBindingTeam({
			connection: {
				connectorKey: "telegram",
				externalTenantId: "chat-999",
				connectionId: 2,
				organizationId: "org-1",
			},
			channelId: "telegram:998877",
			workspaceHint: "chat-hint",
		});
		expect(team).toBe("chat-hint");
	});
});
