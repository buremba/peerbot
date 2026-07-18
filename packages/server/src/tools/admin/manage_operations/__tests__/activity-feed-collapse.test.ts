import { describe, expect, it } from "bun:test";
import { collapseAdjacentActivityCards } from "../activity-feed";

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
