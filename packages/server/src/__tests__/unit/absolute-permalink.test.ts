import { afterEach, describe, expect, it } from "bun:test";
import {
	__resetPublicOriginCachesForTests,
	__setLocalFrontendForTests,
} from "../../utils/public-origin";
import { toAbsolutePermalink } from "../../utils/url-builder";

/**
 * In-app permalinks are relative on purpose — the inbox resolves them against
 * whatever origin the user is on. Slack cannot: it answers a relative button
 * `url` with `invalid_blocks` and drops the WHOLE message, so this conversion
 * is what stands between an approval card and no notification at all.
 */
describe("toAbsolutePermalink", () => {
	afterEach(() => {
		__resetPublicOriginCachesForTests();
		__setLocalFrontendForTests(undefined);
	});

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

	it("returns undefined when no public origin is configured", () => {
		// A backend-only deployment falls back to the hosted UI, so pinning a
		// local frontend is what makes "no origin at all" reachable. The caller
		// then omits the button — a card with no button still delivers, which a
		// message Slack rejected does not.
		delete process.env.PUBLIC_GATEWAY_URL;
		// Reset FIRST — it clears the local-frontend pin too.
		__resetPublicOriginCachesForTests();
		__setLocalFrontendForTests(true);
		expect(toAbsolutePermalink("/acme/memory?run_ids=991")).toBeUndefined();
	});
});
