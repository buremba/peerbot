import { describe, expect, it } from "bun:test";
import {
	effectiveSdkRequiredTier,
	resolveSdkAccessGuidance,
	sdkMethodVisible,
} from "../../../sandbox/sdk-method-access";

describe("sdkMethodVisible", () => {
	it("read mode exposes only read-tier methods", () => {
		expect(sdkMethodVisible("read", "read", "read")).toBe(true);
		expect(sdkMethodVisible("write", "admin", "read")).toBe(false);
		expect(sdkMethodVisible("admin", "admin", "read")).toBe(false);
	});

	it("full mode exposes read methods to every caller", () => {
		expect(sdkMethodVisible("read", "read", "full")).toBe(true);
		expect(sdkMethodVisible("read", "write", "full")).toBe(true);
		expect(sdkMethodVisible("read", "admin", "full")).toBe(true);
	});

	it("full mode exposes write methods to write and admin tiers", () => {
		expect(sdkMethodVisible("write", "read", "full")).toBe(false);
		expect(sdkMethodVisible("write", "write", "full")).toBe(true);
		expect(sdkMethodVisible("write", "admin", "full")).toBe(true);
	});

	it("full mode exposes admin methods only to admin tier", () => {
		expect(sdkMethodVisible("admin", "read", "full")).toBe(false);
		expect(sdkMethodVisible("admin", "write", "full")).toBe(false);
		expect(sdkMethodVisible("admin", "admin", "full")).toBe(true);
	});

	it("full mode treats external like write", () => {
		expect(sdkMethodVisible("external", "read", "full")).toBe(false);
		expect(sdkMethodVisible("external", "write", "full")).toBe(true);
		expect(sdkMethodVisible("external", "admin", "full")).toBe(true);
	});
});

describe("SDK access guidance", () => {
	it("keeps write/external on operate and admin on administer", () => {
		expect(effectiveSdkRequiredTier("read")).toBe("read");
		expect(effectiveSdkRequiredTier("write")).toBe("operate");
		expect(effectiveSdkRequiredTier("external")).toBe("operate");
		expect(effectiveSdkRequiredTier("admin")).toBe("administer");
		expect(effectiveSdkRequiredTier(["read", "external", "admin"])).toBe(
			"administer",
		);
	});

	it("marks owner/admin mcp:write callers as progressively authorizable for admin methods", () => {
		const guidance = resolveSdkAccessGuidance("admin", "owner", [
			"mcp:read",
			"mcp:write",
		]);

		expect(guidance.available).toBe(false);
		expect(guidance.progressivelyAuthorizable).toBe(true);
		expect(guidance.requiredTier).toBe("administer");
		expect(guidance.instruction).toMatch(/progressively authorizable|OAuth challenge/i);
		expect(guidance.instruction).toContain("mcp:admin");
	});

	it("tells a regular member to hand administer work to an owner/admin", () => {
		const guidance = resolveSdkAccessGuidance("admin", "member", [
			"mcp:read",
			"mcp:write",
			"mcp:admin",
		]);

		expect(guidance.available).toBe(false);
		expect(guidance.instruction).toMatch(/ask a workspace owner\/admin/i);
		expect(guidance.instruction).toMatch(/cannot elevate/i);
	});

	it("recognizes an owner/admin with mcp:admin as ready to administer", () => {
		const guidance = resolveSdkAccessGuidance("admin", "admin", [
			"mcp:admin",
		]);

		expect(guidance.available).toBe(true);
		expect(guidance.instruction).toBeUndefined();
	});
});
