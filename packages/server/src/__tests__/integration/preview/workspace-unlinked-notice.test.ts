/**
 * `workspaceUnlinkedNotice` — the reply from a tenant connection with no owning
 * agent when a chat is not bound to an Automation. Slack gets agent deep links and
 * `/lobu link`; other platforms get generic dashboard and `/link` instructions.
 * The notice must remain available when the Slack agent lookup fails.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceUnlinkedNotice } from "../../../preview/slack";
import { __resetPublicOriginCachesForTests } from "../../../utils/public-origin";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

const ORIGIN_ENV = "PUBLIC_GATEWAY_URL";

// getConfiguredPublicOrigin() memoizes PUBLIC_GATEWAY_URL on first read, so every
// case that changes the env must reset the cache to be observed.
function setOrigin(value: string | undefined) {
	if (value === undefined) delete process.env[ORIGIN_ENV];
	else process.env[ORIGIN_ENV] = value;
	__resetPublicOriginCachesForTests();
}

describe("workspaceUnlinkedNotice", () => {
	let savedOrigin: string | undefined;

	beforeEach(async () => {
		await cleanupTestDatabase();
		savedOrigin = process.env[ORIGIN_ENV];
	});

	afterEach(() => {
		setOrigin(savedOrigin);
	});

	it("returns a generic dashboard+CLI notice for Telegram (#2230)", async () => {
		const org = await createTestOrganization();
		const text = await workspaceUnlinkedNotice("telegram", org.id);
		expect(text).toContain("isn't linked");
		// The platform's own command spelling, not Slack's `/lobu link` wrapper…
		expect(text).toContain("/link <code>");
		expect(text).not.toContain("/lobu link");
		// …and no Slack workspace/team deep links or mrkdwn inline links.
		expect(text).not.toContain("<http");
	});

	it('deep-links each agent to the Automations "new" step with the channel prefilled', async () => {
		setOrigin("https://app.lobu.ai/lobu");
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "planner",
			name: "Planner",
		});
		await createTestAgent({
			organizationId: org.id,
			agentId: "builder",
			name: "Builder",
		});

		const text = await workspaceUnlinkedNotice("slack", org.id, {
			channelId: "slack:C0ABC123",
			teamId: "T0TEAM",
			channelName: "general",
			connectionId: "42",
		});

		// getConfiguredPublicOrigin() returns the URL *origin* (scheme+host), so the
		// /lobu gateway mount is dropped — the SPA lives at the bare origin. The link
		// targets the Automation editor with its connection event prefilled.
		// `slack:C…`, `T0TEAM`, and the `#general` label are URL-encoded. Each agent
		// is a Slack mrkdwn inline link `<url|Name>` so it renders clickable (the
		// notice goes out via chat.postMessage text, which Slack reads as mrkdwn;
		// unfurl_links is off so a bare URL would render as flat text).
		expect(text).toContain(
			"<https://app.lobu.ai/acme/automations/new?agent=planner&listen=slack%3AC0ABC123&platform=slack&team=T0TEAM&connection=42&label=%23general|Planner>",
		);
		expect(text).toContain(
			"<https://app.lobu.ai/acme/automations/new?agent=builder&listen=slack%3AC0ABC123&platform=slack&team=T0TEAM&connection=42&label=%23general|Builder>",
		);
		expect(text).toContain("Planner");
		expect(text).toContain("Builder");
		// The CLI path is always offered too.
		expect(text).toContain("lobu run");
		expect(text).toContain("/lobu link");
	});

	it("escapes mrkdwn control chars in the link label so a name can't break the inline link", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "odd",
			name: "A&B <Co>",
		});

		const text = await workspaceUnlinkedNotice("slack", org.id, {
			channelId: "slack:C0ABC123",
			teamId: "T0TEAM",
			channelName: "general",
		});

		// The label inside `<url|label>` is entity-escaped; the raw name never
		// reaches Slack, so a `>` can't prematurely close the inline link.
		expect(text).toContain("|A&amp;B &lt;Co&gt;>");
		expect(text).not.toContain("|A&B <Co>>");
	});

	it("deep-links to Automation creation with the agent prefilled when no channel context is given", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "planner",
			name: "Planner",
		});

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain(
			"https://app.lobu.ai/acme/automations/new?agent=planner",
		);
	});

	it("lists agents by name (no URLs) when the public origin is not configured", async () => {
		setOrigin(undefined);
		const org = await createTestOrganization({ slug: "acme" });
		await createTestAgent({
			organizationId: org.id,
			agentId: "planner",
			name: "Planner",
		});

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain("Planner");
		expect(text).not.toContain("/agents/planner/automations");
		expect(text).toContain("lobu run"); // CLI path still present
	});

	it("falls back to the CLI-only notice when the org has no agents", async () => {
		setOrigin("https://app.lobu.ai");
		const org = await createTestOrganization();

		const text = await workspaceUnlinkedNotice("slack", org.id);
		expect(text).toContain("lobu run");
		expect(text).toContain("/lobu link");
		// No agent-list section.
		expect(text).not.toContain("Automations page");
	});

	it("never throws / dead-drops for an unknown org (returns the CLI-only notice)", async () => {
		setOrigin("https://app.lobu.ai");
		const text = await workspaceUnlinkedNotice(
			"slack",
			"org_does_not_exist",
		);
		expect(text).toContain("/lobu link");
	});
});
