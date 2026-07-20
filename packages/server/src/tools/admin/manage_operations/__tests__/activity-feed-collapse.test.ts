import { describe, expect, it } from "bun:test";
import type { ActivityCard } from "../activity-feed";
import {
	collapseAdjacentActivityCards,
	formatActivityAttentionBlock,
	runHref,
} from "../activity-feed";

function card(
	partial: Partial<Parameters<typeof collapseAdjacentActivityCards>[0][number]> & {
		id: string;
	},
) {
	return {
		kind: "sync",
		title: "Chrome downloads",
		body: "completed · 0 items",
		at: new Date().toISOString(),
		atMs: 0,
		status: "completed",
		count: 1,
		href: "/acme/connectors/chrome.downloads/1",
		collapseKey: "conn:1",
		itemsCollected: 0,
		run_id: 1,
		...partial,
	};
}

describe("collapseAdjacentActivityCards", () => {
	it("merges adjacent same-connection completed syncs and keeps latest href", () => {
		const out = collapseAdjacentActivityCards([
			card({ id: "r:1", atMs: 1, run_id: 1, itemsCollected: 0 }),
			card({ id: "r:2", atMs: 2, run_id: 2, itemsCollected: 0 }),
			card({ id: "r:3", atMs: 3, run_id: 3, itemsCollected: 2 }),
		]);
		expect(out).toHaveLength(1);
		expect(out[0]?.count).toBe(3);
		expect(out[0]?.body).toContain("3×");
		expect(out[0]?.member_run_ids).toEqual([1, 2, 3]);
		expect(out[0]?.href).toBe("/acme/connectors/chrome.downloads/1");
	});

	it("does not merge failed with completed", () => {
		const out = collapseAdjacentActivityCards([
			card({ id: "r:1", status: "completed" }),
			card({ id: "r:2", status: "failed" }),
		]);
		expect(out).toHaveLength(2);
	});
});

describe("runHref", () => {
	it("links watcher runs to the canonical Behavior route", () => {
		expect(
			runHref("acme", {
				id: 42,
				run_type: "watcher",
				watcher_id: 7,
				connection_id: null,
				connector_key: null,
				approval_status: null,
				agent_id: "agent-1",
			}),
		).toBe("/acme/agents/agent-1/behaviors/7");
	});
});

describe("formatActivityAttentionBlock (worker-safe projection)", () => {
	const notif = (partial: Partial<ActivityCard> & { id: string }): ActivityCard => ({
		kind: "notification",
		title: "Notification",
		body: null,
		at: new Date().toISOString(),
		status: "generic",
		count: 1,
		href: null,
		...partial,
	});

	it("strips query params and fragments from deep-links", () => {
		const block = formatActivityAttentionBlock([
			notif({
				id: "n:1",
				title: "Reconnect Chrome",
				href: "/auth/accept-invitation?invitationId=secret-token#frag",
			}),
		]);
		expect(block).toContain("/auth/accept-invitation");
		expect(block).not.toContain("secret-token");
		expect(block).not.toContain("invitationId");
	});

	it("redacts query strings from URLs embedded in notification bodies", () => {
		const block = formatActivityAttentionBlock([
			notif({
				id: "n:2",
				title: "Re-authorize",
				body: "Re-auth here: https://provider.example/oauth/authorize?code=abc123&state=xyz",
			}),
		]);
		expect(block).toContain("https://provider.example/oauth/authorize");
		expect(block).not.toContain("abc123");
		expect(block).not.toContain("code=");
	});
});
