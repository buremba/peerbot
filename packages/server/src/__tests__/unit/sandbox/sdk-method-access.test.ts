import { describe, expect, it } from "bun:test";
import { sdkMethodVisible } from "../../../sandbox/sdk-method-access";

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
