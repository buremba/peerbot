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

	it("refuses a url whose scheme we did not choose", () => {
		// The origin join is what makes these dangerous: with no `http` prefix
		// they would come back out as `https://app.lobu.ai/javascript:alert(1)`
		// — a link wearing our domain, on a card the reader trusts. `notify`
		// takes `resource_url` as an agent-supplied tool argument, so this is
		// reachable without any template involved.
		expect(
			toAbsolutePermalink("javascript:alert(1)", "https://app.lobu.ai"),
		).toBeUndefined();
		expect(
			toAbsolutePermalink("//evil.example/x", "https://app.lobu.ai"),
		).toBeUndefined();
		expect(toAbsolutePermalink("   ", "https://app.lobu.ai")).toBeUndefined();
	});

	it("still takes an absolute https url and a plain relative path", () => {
		expect(toAbsolutePermalink("https://evil.example/x", "https://app.lobu.ai")).toBe(
			"https://evil.example/x",
		);
		expect(toAbsolutePermalink("/acme/x", "https://app.lobu.ai")).toBe(
			"https://app.lobu.ai/acme/x",
		);
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
