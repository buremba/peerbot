import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDefaultCatalogDir } from "../uris";

describe("catalog/uris", () => {
	it("getDefaultCatalogDir returns the first existing candidate", () => {
		// Mirror uris.ts candidate resolution from the catalog module dir, not
		// this test file's __tests__ location (vitest/bun cwd layouts differ).
		const catalogModuleDir = fileURLToPath(new URL("..", import.meta.url));
		const candidates = [
			resolve(catalogModuleDir, "../../dist/catalogs"),
			resolve(catalogModuleDir, "../../../dist/catalogs"),
			resolve(process.cwd(), "packages/server/dist/catalogs"),
		];
		const expected =
			candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
		const result = getDefaultCatalogDir();

		expect(result).toBe(expected);
		if (existsSync(result)) {
			expect(candidates).toContain(result);
		}
	});
});
