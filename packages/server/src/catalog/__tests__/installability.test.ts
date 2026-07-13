import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installCatalogConnectorDefinition } from "../connector-definitions";
import { clearCatalogCacheForTests } from "../load";
import { buildCatalogListResponse } from "../responses";
import type { CatalogEntry, CatalogKind } from "../types";

const ORIGINAL_CLOUD_MODE = process.env.LOBU_CLOUD_MODE;
const ORIGINAL_CATALOG_URIS = process.env.LOBU_CATALOG_URIS;

function connectorEntry(id: string, name = id): CatalogEntry {
	return {
		id,
		name,
		version: "1.0.0",
		detail: { source_uri: `file:///stale-catalog/${id}.ts` },
	};
}

function connectorDetail(entry: CatalogEntry): Record<string, unknown> {
	const all = {
		connectors: [entry],
		skills: [],
		watchers: [],
	} satisfies Record<CatalogKind, CatalogEntry[]>;
	const response = buildCatalogListResponse(["connectors"], all);
	return response.catalogs.connectors!.entries[0]!.detail;
}

describe("connector catalog installability", () => {
	afterEach(() => {
		if (ORIGINAL_CLOUD_MODE === undefined) delete process.env.LOBU_CLOUD_MODE;
		else process.env.LOBU_CLOUD_MODE = ORIGINAL_CLOUD_MODE;
		if (ORIGINAL_CATALOG_URIS === undefined)
			delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = ORIGINAL_CATALOG_URIS;
		clearCatalogCacheForTests();
	});

	it("keeps PostgreSQL installable in cloud now that its egress is hardened", () => {
		process.env.LOBU_CLOUD_MODE = "1";

		// `postgres` graduated out of CLOUD_RESTRICTED_CONNECTOR_KEYS: the
		// db-egress-guard (block-private + resolve-then-pin IP + forced TLS) is
		// the platform boundary, so it is installable by cloud tenants like any
		// other connector. CLOUD_RESTRICTED_CONNECTOR_KEYS is now empty and
		// stays as the kill-switch for future warehouse connectors.
		expect(connectorDetail(connectorEntry("postgres", "PostgreSQL"))).toMatchObject({
			installable: true,
		});
	});

	it("marks the bundled PostgreSQL connector installable when self-hosted", () => {
		expect(connectorDetail(connectorEntry("postgres", "PostgreSQL"))).toMatchObject({
			installable: true,
		});
	});

	it("marks a stale manifest entry non-installable when its bundle was removed", () => {
		expect(connectorDetail(connectorEntry("spotify", "Spotify"))).toMatchObject({
			installable: false,
			installability_reason: "bundled_source_unavailable",
		});
	});

	it("no longer blocks PostgreSQL install in cloud at the capability gate", async () => {
		process.env.LOBU_CLOUD_MODE = "1";

		// With CLOUD_RESTRICTED_CONNECTOR_KEYS empty, postgres is no longer
		// rejected at the cloud capability gate. Installation now proceeds past
		// that gate (and fails later for an unrelated reason — a bogus org — not
		// with a `cloud_restricted` message). Assert it does NOT throw the
		// cloud-restriction message. The stale-source case below still covers the
		// catalog-rejection-message-on-install path via spotify.
		const detail = connectorDetail(connectorEntry("postgres", "PostgreSQL"));
		expect(detail.installable).toBe(true);
		expect(detail.installability_reason).toBeUndefined();

		await expect(
			installCatalogConnectorDefinition({
				organizationId: "unused-before-capability-gate",
				connectorId: "postgres",
			}),
		).rejects.not.toThrow("cloud_restricted");
	});

	it("uses the catalog's stale-source rejection message when installation is attempted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobu-stale-catalog-"));
		const manifestPath = join(dir, "connectors.json");
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 1,
				kind: "connectors",
				entries: [connectorEntry("spotify", "Spotify")],
			}),
		);
		process.env.LOBU_CATALOG_URIS = manifestPath;
		clearCatalogCacheForTests();
		const detail = connectorDetail(connectorEntry("spotify", "Spotify"));

		await expect(
			installCatalogConnectorDefinition({
				organizationId: "unused-before-capability-gate",
				connectorId: "spotify",
			}),
		).rejects.toThrow(String(detail.installability_message));
	});
});
