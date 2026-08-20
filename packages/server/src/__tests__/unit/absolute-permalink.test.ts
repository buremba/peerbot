import { describe, expect, it } from "bun:test";
import { toAbsolutePermalink } from "../../utils/url-builder";

/**
 * In-app permalinks are relative on purpose — the inbox resolves them against
 * whatever origin the user is on. Slack cannot: it answers a relative button
 * `url` with `invalid_blocks` and drops the WHOLE message, so this conversion
 * is what stands between an approval card and no notification at all.
 */
describe("toAbsolutePermalink", () => {
	it("absolutises a relative permalink against the configured origin", () => {
		expect(
			toAbsolutePermalink("/acme/memory?run_ids=991", "https://app.lobu.ai"),
		).toBe("https://app.lobu.ai/acme/memory?run_ids=991");
	});

	it("leaves an already-absolute url alone", () => {
		expect(
			toAbsolutePermalink("https://app.lobu.ai/x", "https://other.example"),
		).toBe("https://app.lobu.ai/x");
	});

	it("joins a path that does not start with a slash", () => {
		expect(toAbsolutePermalink("acme/runs/1", "https://app.lobu.ai")).toBe(
			"https://app.lobu.ai/acme/runs/1",
		);
	});

	it("returns undefined for nothing to link", () => {
		expect(toAbsolutePermalink(null, "https://app.lobu.ai")).toBeUndefined();
		expect(toAbsolutePermalink(undefined, "https://app.lobu.ai")).toBeUndefined();
	});
});
