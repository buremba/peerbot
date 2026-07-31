import { describe, expect, it } from "vitest";
import {
	mergeConnectorInstalledWithCatalog,
	mergeSkillInstalledWithCatalog,
	parseIncludeCatalog,
} from "../merge";

describe("catalog/merge", () => {
	it("parseIncludeCatalog recognizes catalog", () => {
		expect(parseIncludeCatalog(undefined)).toBe(false);
		expect(parseIncludeCatalog("catalog")).toBe(true);
		expect(parseIncludeCatalog("foo,catalog,bar")).toBe(true);
	});

	it("mergeConnectorInstalledWithCatalog prefers installed rows", () => {
		const merged = mergeConnectorInstalledWithCatalog(
			[
				{
					id: "slack",
					name: "Slack",
					detail: { version: "1.0.0", has_operations: true },
				},
			],
			[
				{
					id: "slack",
					name: "Slack (catalog)",
					detail: {
						actions_schema: { ping: {} },
						behavior_events: [
							{ key: "message.created", label: "A message is sent" },
						],
					},
				},
				{
					id: "github",
					name: "GitHub",
					detail: { actions_schema: { sync: {} } },
				},
			],
		);

		expect(merged.map((item) => item.id)).toEqual(["slack", "github"]);
		expect(merged[0]?.detail.installed).toBe(true);
		expect(merged[0]?.detail.catalog_origin).toBe("org");
		expect(merged[0]?.detail.behavior_events).toEqual([
			{ key: "message.created", label: "A message is sent" },
		]);
		expect(merged[1]?.detail.installed).toBe(false);
		expect(merged[1]?.detail.installable).toBe(true);
	});

	it("counts explicitly read-only catalog actions as reads", () => {
		const [item] = mergeConnectorInstalledWithCatalog([], [
			{
				id: "example",
				name: "Example",
				detail: {
					actions_schema: {
						search: { kind: "read" },
						create: { kind: "write" },
					},
				},
			},
		]);
		expect(item?.detail.operations_summary).toMatchObject({
			total: 2,
			reads: 1,
			writes: 1,
		});
	});

	it("mergeSkillInstalledWithCatalog skips hidden catalog skills", () => {
		const merged = mergeSkillInstalledWithCatalog(
			[
				{
					id: "bundled/research",
					name: "Research",
					detail: { enabled: true },
				},
			],
			[
				{
					id: "bundled/research",
					name: "Research",
					detail: { hidden: true },
				},
				{
					id: "bundled/lobu-operator",
					name: "Operator",
					detail: { hidden: true, instructions: "secret" },
				},
				{
					id: "bundled/writer",
					name: "Writer",
					detail: { instructions: "write" },
				},
			],
		);

		expect(merged.map((item) => item.id)).toEqual([
			"bundled/research",
			"bundled/writer",
		]);
		expect(merged[0]?.detail.installed).toBe(true);
		expect(merged[1]?.detail.installed).toBe(false);
	});
});

// Platform event injection for the installed-connector UI is owned by
// listOrgInstalled (withPlatformBehaviorEvents). Unit coverage for the pure
// merge helper lives next to platform-event-catalog.
import {
	PLATFORM_EVENT_FEED_AUTO_PAUSED,
	withPlatformBehaviorEvents,
} from "../../behaviors/platform-event-catalog";

describe("withPlatformBehaviorEvents (installed UI surface)", () => {
	it("exposes feed.auto_paused alongside connector-declared events", () => {
		const merged = withPlatformBehaviorEvents([
			{ key: "message.created", label: "A message is sent" },
		]);
		expect(merged.map((e) => e.key)).toEqual([
			"message.created",
			PLATFORM_EVENT_FEED_AUTO_PAUSED,
		]);
	});

	it("does not duplicate when the connector already declares the platform event", () => {
		const merged = withPlatformBehaviorEvents([
			{ key: PLATFORM_EVENT_FEED_AUTO_PAUSED },
			{ key: "message.created" },
		]);
		expect(
			merged.filter((e) => e.key === PLATFORM_EVENT_FEED_AUTO_PAUSED),
		).toHaveLength(1);
	});
});
