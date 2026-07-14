import { describe, expect, it } from "bun:test";
import type { Env } from "../../index";
import type { ToolContext } from "../../tools/registry";
import {
	type ConnectorDiscoveryDeps,
	searchLiveConnectors,
} from "../../tools/connector-discovery";

// Fixture mirrors the audit's Website-installed-but-unconfigured production
// shape: website is INSTALLED with a `pages` feed schema, NOT in the configured
// connections, and NOT in the global catalog (an org-installed connector). RSS
// is also installed as a decoy alternative. Injected via the `deps` param — no
// mock.module (process-global in Bun; it corrupts sibling suites).
const installedResult = {
	installed: {
		connectors: {
			items: [
				{
					id: "website",
					name: "Website",
					detail: {
						description:
							"Scrapes JS-rendered pages via Playwright; supports sitemap.xml",
						// SECRET-looking fields that must NOT surface:
						auth_schema: { api_key: { type: "string" } },
						default_connection_config: { token: "sekret" },
						feeds_schema: { pages: { config: { urls: {}, max_pages: {} } } },
					},
				},
				{
					id: "rss",
					name: "RSS",
					detail: { description: "RSS reader", feeds_schema: { articles: {} } },
				},
			],
		},
	},
};

const catalogResult = {
	catalogs: {
		connectors: {
			entries: [
				{ id: "slack", name: "Slack", description: "Slack workspace sync" },
				{ id: "webhook", name: "Webhook", description: "Inbound push" },
			],
		},
	},
};

const noConnections = { connections: [] };

function makeDeps(over?: {
	installed?: unknown;
	catalog?: unknown;
	connections?: unknown;
}): ConnectorDiscoveryDeps {
	return {
		manageCatalog: (async (args: { action: string }) =>
			args.action === "list_catalog"
				? (over?.catalog ?? catalogResult)
				: (over?.installed ?? installedResult)) as never,
		manageConnections: (async () => over?.connections ?? noConnections) as never,
	};
}

const env = {} as Env;
const ctx = { organizationId: "org-1", userId: "u1" } as ToolContext;

describe("searchLiveConnectors (search_sdk connector intent search)", () => {
	it("surfaces an installed-but-unconfigured connector with feed key + connect lifecycle", async () => {
		const hits = await searchLiveConnectors("website", env, ctx, makeDeps());
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatch(/website/);
		expect(hits[0]).toMatch(/not yet configured/);
		expect(hits[0]).toMatch(/feed_key: 'pages'/);
		expect(hits[0]).toMatch(/connections\.connect/);
		expect(hits[0]).toMatch(/feeds\.trigger/);
	});

	it("matches a MULTI-WORD intent phrase via tokens, not just the bare name", async () => {
		// The failure the eval exposed: "website connect source" / "crawl a web
		// page" returned nothing because the whole phrase was matched as one
		// substring. Token matching must still find the connector.
		for (const q of ["website connect source", "crawl a web page", "ingest a website"]) {
			const hits = await searchLiveConnectors(q, env, ctx, makeDeps());
			expect(hits.some((h) => h.includes("'website'"))).toBe(true);
		}
	});

	it("reports an already-configured connector as configured (read, don't re-connect)", async () => {
		const deps = makeDeps({
			connections: { connections: [{ connector_key: "website", status: "active" }] },
		});
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/already CONFIGURED/);
		expect(hits[0]).toMatch(/status: active/);
		expect(hits[0]).not.toMatch(/not yet configured/);
	});

	it("surfaces a global-catalog connector as installable when not installed", async () => {
		const hits = await searchLiveConnectors("slack", env, ctx, makeDeps());
		expect(hits.some((h) => h.includes("'slack'") && /CATALOG/.test(h))).toBe(true);
		expect(hits.some((h) => /installConnector/.test(h))).toBe(true);
	});

	it("never leaks credentials or raw connector config", async () => {
		const hits = await searchLiveConnectors("website", env, ctx, makeDeps());
		const json = JSON.stringify(hits);
		expect(json).not.toMatch(/sekret/);
		expect(json).not.toMatch(/auth_schema/);
		expect(json).not.toMatch(/default_connection_config/);
	});

	it("returns empty for a query that names no connector", async () => {
		expect(await searchLiveConnectors("zzz-nothing", env, ctx, makeDeps())).toEqual([]);
	});

	it("returns empty for a blank query (never dumps the whole catalog)", async () => {
		expect(await searchLiveConnectors("", env, ctx, makeDeps())).toEqual([]);
		expect(await searchLiveConnectors("   ", env, ctx, makeDeps())).toEqual([]);
	});

	it("drops stopword-only queries so filler words don't match every connector", async () => {
		// "connect a source" is all stopwords → no token → no match (else it would
		// spuriously match on the word 'connect' inside connector descriptions).
		expect(await searchLiveConnectors("connect a source", env, ctx, makeDeps())).toEqual([]);
	});
});
