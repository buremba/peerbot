import { describe, expect, it } from "vitest";
import {
	compileReactionScript,
	extractReactionInputSchema,
} from "../watchers/reaction-executor";
import { WATCHER_CATALOG_TEMPLATES } from "./watcher-templates";

describe("duplicate merge watcher template", () => {
	it("creates one approval-gated merge proposal per duplicate group", () => {
		const template = WATCHER_CATALOG_TEMPLATES.find(
			(entry) => entry.id === "duplicate-merge",
		);
		const prompt = String(template?.detail?.prompt ?? "");
		const reaction = String(template?.detail?.reaction_script ?? "");

		expect(prompt).toContain("duplicate_entity_ids");
		expect(prompt).toContain("merge_evidence");
		expect(prompt).toContain("pending human approval");
		expect(prompt).toContain("Never emit textual backlog tasks");
		expect(prompt).not.toContain("call manage_entity");
		expect(reaction).toContain("client.entities.manage");
		expect(reaction).toContain('action: "merge"');
		expect(reaction).toContain("watcher_source");
	});

	it("ships a reaction script that compiles in the watcher runtime", async () => {
		const template = WATCHER_CATALOG_TEMPLATES.find(
			(entry) => entry.id === "duplicate-merge",
		);

		await expect(
			compileReactionScript(String(template?.detail?.reaction_script ?? "")),
		).resolves.toContain("client.entities.manage");
	});

	it("declares the extraction contract consumed by the reaction", async () => {
		const template = WATCHER_CATALOG_TEMPLATES.find(
			(entry) => entry.id === "duplicate-merge",
		);
		const schema = await extractReactionInputSchema(
			String(template?.detail?.reaction_script ?? ""),
		);

		expect(schema?.required).toEqual(["merge_proposals", "uncertain_groups"]);
		expect(schema?.properties).toHaveProperty("merge_proposals");
	});
});
