import { describe, expect, it } from "vitest";
import { tsTime, tsTimeOrNull } from "../../db/client";
import {
	orgContext,
	requireOrgId,
	resolveOrgId,
} from "../../lobu/stores/org-context";
import { constantTimeEqual } from "../constant-time-equal";

describe("tsTime", () => {
	it("coerces a Date to epoch ms", () => {
		const d = new Date("2026-06-22T00:00:00.000Z");
		expect(tsTime(d)).toBe(d.getTime());
	});

	it("passes a number through", () => {
		expect(tsTime(1234567890)).toBe(1234567890);
	});

	it("parses a timestamp string", () => {
		const s = "2026-06-22T00:00:00.000Z";
		expect(tsTime(s)).toBe(new Date(s).getTime());
	});

	it("defaults to now for null/undefined/garbage", () => {
		const before = Date.now();
		expect(tsTime(null)).toBeGreaterThanOrEqual(before);
		expect(tsTime(undefined)).toBeGreaterThanOrEqual(before);
		expect(tsTime("not a date")).toBeGreaterThanOrEqual(before);
	});
});

describe("tsTimeOrNull", () => {
	it("coerces a Date, passes numbers, parses strings", () => {
		const d = new Date("2026-06-22T00:00:00.000Z");
		expect(tsTimeOrNull(d)).toBe(d.getTime());
		expect(tsTimeOrNull(42)).toBe(42);
		expect(tsTimeOrNull("2026-06-22T00:00:00.000Z")).toBe(d.getTime());
	});

	it("returns undefined for null/undefined/garbage (not now)", () => {
		expect(tsTimeOrNull(null)).toBeUndefined();
		expect(tsTimeOrNull(undefined)).toBeUndefined();
		expect(tsTimeOrNull("not a date")).toBeUndefined();
	});
});

describe("constantTimeEqual", () => {
	it("true for equal strings", () => {
		expect(constantTimeEqual("secret-token", "secret-token")).toBe(true);
	});

	it("false for different values, lengths, or missing inputs", () => {
		expect(constantTimeEqual("secret-token", "other-token!")).toBe(false);
		expect(constantTimeEqual("short", "longer-value")).toBe(false);
		expect(constantTimeEqual(undefined, "x")).toBe(false);
		expect(constantTimeEqual("x", undefined)).toBe(false);
		expect(constantTimeEqual(undefined, undefined)).toBe(false);
		expect(constantTimeEqual("", "")).toBe(false);
	});
});

describe("resolveOrgId / requireOrgId", () => {
	it("explicit wins over ambient context", () => {
		orgContext.run({ organizationId: "ambient" }, () => {
			expect(resolveOrgId("explicit")).toBe("explicit");
			expect(requireOrgId("explicit", "Caller.method")).toBe("explicit");
		});
	});

	it("falls back to ambient context when no explicit value", () => {
		orgContext.run({ organizationId: "ambient" }, () => {
			expect(resolveOrgId()).toBe("ambient");
			expect(resolveOrgId(null)).toBe("ambient");
			expect(requireOrgId(undefined, "Caller.method")).toBe("ambient");
		});
	});

	it("resolveOrgId returns null with no explicit + no context", () => {
		expect(resolveOrgId()).toBeNull();
	});

	it("requireOrgId throws a caller-named error with no org", () => {
		expect(() => requireOrgId(undefined, "Caller.method")).toThrow(
			/Caller\.method requires organizationId/,
		);
	});
});
