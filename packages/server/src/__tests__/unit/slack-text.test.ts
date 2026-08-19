/**
 * Slack text limits.
 *
 * The bug these pin: Slack rejects a whole `section` past 3000 characters, and
 * with it the entire message or `views.publish`. The App Home built its lists
 * by joining an unbounded `.map()`, so a busy inbox produced no App Home at
 * all rather than a truncated one.
 */

import { describe, expect, it } from "bun:test";
import {
	escapeSlackText,
	joinSectionLines,
	MAX_SECTION_CHARS,
} from "../../utils/slack-text";

describe("escapeSlackText", () => {
	it("neutralises the entities Slack would otherwise interpret", () => {
		expect(escapeSlackText("<!channel> & <https://evil.example|Review in Lobu>")).toBe(
			"&lt;!channel&gt; &amp; &lt;https://evil.example|Review in Lobu&gt;",
		);
	});

	it("escapes the ampersand first, so an entity is never double-escaped", () => {
		expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
	});
});

describe("joinSectionLines", () => {
	it("keeps a short list whole and omits nothing", () => {
		const { text, omitted } = joinSectionLines(["• one", "• two"], {
			header: "*Recent*",
		});
		expect(text).toBe("*Recent*\n• one\n• two");
		expect(omitted).toBe(0);
	});

	it("drops the tail rather than the message, and says how many", () => {
		const lines = Array.from({ length: 400 }, (_, i) => `• item ${i} ${"x".repeat(40)}`);
		const { text, omitted } = joinSectionLines(lines, { header: "*Recent*" });
		expect(text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
		expect(omitted).toBeGreaterThan(0);
		expect(text).toContain(`_…and ${omitted} more_`);
	});

	it("stays inside the cap even when a single line is enormous", () => {
		const { text, omitted } = joinSectionLines(["x".repeat(9000)]);
		expect(text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
		expect(omitted).toBe(1);
	});
});
