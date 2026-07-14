import { afterEach, describe, expect, test } from "bun:test";
import {
	getConnectBaseUrl,
	getGatewayBaseUrl,
} from "../../tools/admin/helpers/connection-helpers";
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
	test("keeps token-gated connector auth on the app root", () => {
		process.env.PUBLIC_GATEWAY_URL = "https://app.lobu.ai/lobu";
		__resetPublicOriginCachesForTests();

		expect(
			getConnectBaseUrl({
				baseUrl: "https://app.lobu.ai",
				requestUrl: "https://app.lobu.ai/mcp",
			} as Parameters<typeof getConnectBaseUrl>[0]),
		).toBe("https://app.lobu.ai");
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

describe("getGatewayBaseUrl", () => {
	test("uses the configured gateway mount for gateway-owned install routes", () => {
		process.env.PUBLIC_GATEWAY_URL = "https://app.lobu.ai/lobu";
		__resetPublicOriginCachesForTests();

		expect(
			getGatewayBaseUrl({
				baseUrl: "https://app.lobu.ai",
				requestUrl: "https://app.lobu.ai/mcp",
			} as Parameters<typeof getGatewayBaseUrl>[0]),
		).toBe("https://app.lobu.ai/lobu");
	});
});
