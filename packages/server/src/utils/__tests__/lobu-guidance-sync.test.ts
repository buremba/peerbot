import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	renderFallbackSystemContext,
	renderSkillMemorySection,
} from "@lobu/core";
import { describe, expect, it } from "vitest";

// Memory guidance now lives in the bundled Lobu skill. Resolve relative to this
// file so the test works regardless of `process.cwd()` (worktrees, vitest's
// per-package cwd, IDE runners).
const skillPath = resolve(__dirname, "../../../../../skills/lobu/SKILL.md");
const START_MARKER = "<!-- lobu-memory-guidance:start -->";
const END_MARKER = "<!-- lobu-memory-guidance:end -->";

describe("lobu guidance sync", () => {
	it("renders plugin fallback context with namespaced tool names", () => {
		const text = renderFallbackSystemContext();

		expect(text).toContain("lobu_save_memory");
		expect(text).toContain("lobu_search_memory");
		expect(text).toContain("<lobu-system>");
	});

	it("keeps the skill memory section in sync with the shared renderer", () => {
		const skill = readFileSync(skillPath, "utf-8");
		const start = skill.indexOf(START_MARKER);
		const end = skill.indexOf(END_MARKER);

		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);

		const generatedSection = skill
			.slice(start + START_MARKER.length, end)
			.trim();

		expect(generatedSection).toBe(renderSkillMemorySection());
	});
});
