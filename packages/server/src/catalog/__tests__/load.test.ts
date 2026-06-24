import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCatalogCacheForTests, listCatalogEntries } from "../load";

describe("catalog/load", () => {
	afterEach(() => {
		clearCatalogCacheForTests();
	});

	it("falls back to in-memory manifests when LOBU_CATALOG_URIS is unset", async () => {
		const prev = process.env.LOBU_CATALOG_URIS;
		delete process.env.LOBU_CATALOG_URIS;
		clearCatalogCacheForTests();

		const entries = await listCatalogEntries(["connectors", "skills"]);
		expect(entries.connectors.length).toBeGreaterThan(0);
		expect(entries.skills.length).toBeGreaterThanOrEqual(0);
		expect(entries.connectors[0]?.id).toBeTruthy();
		expect(entries.connectors[0]?.name).toBeTruthy();

		if (prev === undefined) delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = prev;
		clearCatalogCacheForTests();
	});

	it("serves bundled watcher templates when LOBU_CATALOG_URIS is unset", async () => {
		const prev = process.env.LOBU_CATALOG_URIS;
		delete process.env.LOBU_CATALOG_URIS;
		clearCatalogCacheForTests();

		const entries = await listCatalogEntries(["watchers"]);
		expect(entries.watchers.length).toBeGreaterThan(0);
		const first = entries.watchers[0];
		expect(first?.id).toBeTruthy();
		expect(first?.name).toBeTruthy();
		// detail mirrors the watcher create-form fields (used for prefill)
		expect(first?.detail.prompt).toBeTruthy();

		if (prev === undefined) delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = prev;
		clearCatalogCacheForTests();
	});

	it("deduplicates catalog entries by id within a kind", async () => {
		const prev = process.env.LOBU_CATALOG_URIS;
		const dir = await mkdtemp(join(tmpdir(), "lobu-catalog-test-"));
		const manifestPath = join(dir, "connectors.json");
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 1,
				kind: "connectors",
				entries: [
					{ id: "acme", name: "Acme One", detail: {} },
					{ id: "acme", name: "Acme Duplicate", detail: {} },
					{ id: "beta", name: "Beta", detail: {} },
				],
			}),
		);
		process.env.LOBU_CATALOG_URIS = manifestPath;
		clearCatalogCacheForTests();

		const entries = await listCatalogEntries(["connectors"]);
		expect(entries.connectors).toHaveLength(2);
		expect(entries.connectors.map((entry) => entry.id).sort()).toEqual([
			"acme",
			"beta",
		]);
		expect(entries.connectors.find((entry) => entry.id === "acme")?.name).toBe(
			"Acme One",
		);

		if (prev === undefined) delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = prev;
		clearCatalogCacheForTests();
	});
});
