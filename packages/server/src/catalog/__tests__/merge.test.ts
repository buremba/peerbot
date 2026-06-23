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
					detail: { actions_schema: { ping: {} } },
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
		expect(merged[1]?.detail.installed).toBe(false);
		expect(merged[1]?.detail.installable).toBe(true);
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
