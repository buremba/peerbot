import { afterEach, describe, expect, test } from "bun:test";
import { getConnectBaseUrl } from "../../tools/admin/helpers/connection-helpers";
import { __resetPublicOriginCachesForTests } from "../../utils/public-origin";

const ORIGINAL_PUBLIC_GATEWAY_URL = process.env.PUBLIC_GATEWAY_URL;

afterEach(() => {
	if (ORIGINAL_PUBLIC_GATEWAY_URL === undefined) {
		delete process.env.PUBLIC_GATEWAY_URL;
	} else {
		process.env.PUBLIC_GATEWAY_URL = ORIGINAL_PUBLIC_GATEWAY_URL;
	}
	__resetPublicOriginCachesForTests();
});

describe("getConnectBaseUrl", () => {
	test("uses the configured gateway mount when the tool context has only the web origin", () => {
		process.env.PUBLIC_GATEWAY_URL = "https://app.lobu.ai/lobu";
		__resetPublicOriginCachesForTests();

		expect(
			getConnectBaseUrl({
				baseUrl: "https://app.lobu.ai",
				requestUrl: "https://app.lobu.ai/mcp",
			} as Parameters<typeof getConnectBaseUrl>[0]),
		).toBe("https://app.lobu.ai/lobu");
	});

	test("preserves an explicit path-aware context base in tests and self-hosted mounts", () => {
		process.env.PUBLIC_GATEWAY_URL = "https://configured.example/lobu";
		__resetPublicOriginCachesForTests();

		expect(
			getConnectBaseUrl({
				baseUrl: "https://gateway.test/custom-mount/",
			} as Parameters<typeof getConnectBaseUrl>[0]),
		).toBe("https://gateway.test/custom-mount");
	});
});
