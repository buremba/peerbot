import { describe, expect, it } from "vitest";
import { WATCHER_CATALOG_TEMPLATES } from "./watcher-templates";

describe("duplicate merge watcher template", () => {
	it("creates one approval-gated merge proposal per duplicate group", () => {
		const template = WATCHER_CATALOG_TEMPLATES.find(
			(entry) => entry.id === "duplicate-merge",
		);
		const prompt = String(template?.detail?.prompt ?? "");

		expect(prompt).toContain("duplicate_entity_ids");
		expect(prompt).toContain("merge_evidence");
		expect(prompt).toContain("one pending human approval for the whole group");
		expect(prompt).toContain("Never substitute textual backlog tasks");
	});
});
