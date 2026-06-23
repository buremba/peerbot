import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDefaultCatalogDir } from "../uris";

describe("catalog/uris", () => {
	it("getDefaultCatalogDir returns the first existing candidate", () => {
		const here =
			import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
		const candidates = [
			resolve(here, "../../dist/catalogs"),
			resolve(here, "../../../dist/catalogs"),
			resolve(process.cwd(), "packages/server/dist/catalogs"),
		];
		const expected = candidates.find((candidate) => existsSync(candidate));
		expect(getDefaultCatalogDir()).toBe(expected ?? candidates[0]);
	});
});
