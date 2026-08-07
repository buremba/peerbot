/**
 * Capture mode is a security boundary: an eval replay must not be able to talk
 * its way back into performing side effects. These tests pin the two hops
 * where that could go wrong — minting the signed claim, and honouring it.
 */

import { describe, expect, test } from "bun:test";
import { buildWorkerTokenClaims } from "../../gateway/orchestration/worker-token-claims";
import { resolveSandboxDryRun } from "../../tools/sdk_run";

const base = {
	channelId: "api_watcher_7",
	agentId: "agent_1",
	organizationId: "org_1",
	platform: "api",
};

describe("buildWorkerTokenClaims — executionMode", () => {
	test("carries capture through to the signed claim", () => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { executionMode: "capture" },
		});
		expect(claims.executionMode).toBe("capture");
	});

	test("a live Behavior run carries no claim", () => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { source: "watcher-run" },
		});
		expect(claims.executionMode).toBeUndefined();
	});

	// The claim is minted from platformMetadata, which is assembled server-side
	// — but only the exact literal may ever be honoured, so a value that reached
	// the bag by any other route cannot mint a mode we would act on.
	test.each([
		["live", "live"],
		["uppercase", "CAPTURE"],
		["padded", " capture"],
		["truthy object", { toString: () => "capture" }],
		["number", 1],
		["boolean", true],
		["null", null],
	])("%s does not mint a capture claim", (_label, value) => {
		const claims = buildWorkerTokenClaims({
			...base,
			platformMetadata: { executionMode: value },
		});
		expect(claims.executionMode).toBeUndefined();
	});

	test("an absent bag is not a capture run", () => {
		expect(
			buildWorkerTokenClaims({ ...base, platformMetadata: {} }).executionMode,
		).toBeUndefined();
	});
});

describe("resolveSandboxDryRun — capture forcing", () => {
	test("a capture run captures even when the agent asks for a live run", () => {
		expect(
			resolveSandboxDryRun({
				executionMode: "capture",
				sdkMode: "full",
				agentDryRun: false,
			}),
		).toBe(true);
	});

	test("capture holds on the read-mode surface too", () => {
		expect(
			resolveSandboxDryRun({
				executionMode: "capture",
				sdkMode: "read",
				agentDryRun: false,
			}),
		).toBe(true);
	});

	test("a live run still executes for real", () => {
		expect(
			resolveSandboxDryRun({
				executionMode: "live",
				sdkMode: "full",
				agentDryRun: false,
			}),
		).toBe(false);
		expect(
			resolveSandboxDryRun({
				executionMode: null,
				sdkMode: "full",
				agentDryRun: false,
			}),
		).toBe(false);
	});

	test("the agent's own dry_run opt-in still works on a live run", () => {
		expect(
			resolveSandboxDryRun({
				executionMode: null,
				sdkMode: "full",
				agentDryRun: true,
			}),
		).toBe(true);
	});
});
