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


function makeDeps(over?: {
	installed?: unknown;
	catalog?: unknown;
	// Connections keyed by connector_key — the tool queries connections FILTERED
	// by connector_key, so the mock returns only the matching key's rows (models
	// the real filter and proves an active connection is found regardless of how
	// many other connections exist).
	connectionsByKey?: Record<string, Array<{ status: string }>>;
}): ConnectorDiscoveryDeps {
	return {
		manageCatalog: (async (args: { action: string }) =>
			args.action === "list_catalog"
				? (over?.catalog ?? catalogResult)
				: (over?.installed ?? installedResult)) as never,
		manageConnections: (async (args: { connector_key?: string; status?: string }) => {
			// Model the real handler: connector_key AND optional status filter.
			const all = over?.connectionsByKey?.[args.connector_key ?? ""] ?? [];
			const rows = args.status ? all.filter((c) => c.status === args.status) : all;
			return { connections: rows };
		}) as never,
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

	it("reports an active connection as CONNECTED (add feed / read, don't re-connect)", async () => {
		const deps = makeDeps({ connectionsByKey: { website: [{ status: "active" }] } });
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/CONNECTED/);
		expect(hits[0]).toMatch(/feeds\.create/);
		expect(hits[0]).not.toMatch(/not yet configured/);
		expect(hits[0]).not.toMatch(/reauthenticate/i);
	});

	it("tells the agent to REPAIR a revoked/error connection, not create a feed on it", async () => {
		// The review-caught bug: a revoked connection was labeled 'already
		// CONFIGURED' and told to create feeds, which would silently never sync.
		const deps = makeDeps({ connectionsByKey: { website: [{ status: "revoked" }] } });
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/needs attention/);
		expect(hits[0]).toMatch(/status: revoked/);
		expect(hits[0]).toMatch(/reauthenticate|repair|reconnect/i);
		expect(hits[0]).not.toMatch(/CONNECTED \(active/);
	});

	it("prefers an ACTIVE connection when a connector has several (active + revoked)", async () => {
		const deps = makeDeps({
			connectionsByKey: { website: [{ status: "revoked" }, { status: "active" }] },
		});
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/CONNECTED/);
		expect(hits[0]).not.toMatch(/needs attention/);
	});

	it("finds an ACTIVE connection even behind many newer non-active ones (status probe, not one page)", async () => {
		// The review-caught bug: an older active connection hidden behind 200 newer
		// revoked rows was reported as 'needs repair'. The tool probes status=active
		// (filtered) first, so it's found regardless of ordering/volume.
		const many = [
			...Array.from({ length: 200 }, () => ({ status: "revoked" })),
			{ status: "active" }, // older, would be on page 2 of an unfiltered scan
		];
		const deps = makeDeps({ connectionsByKey: { website: many } });
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/CONNECTED/);
		expect(hits[0]).not.toMatch(/needs attention/);
	});

	it("surfaces a global-catalog connector as installable when not installed", async () => {
		const hits = await searchLiveConnectors("slack", env, ctx, makeDeps());
		expect(hits.some((h) => h.includes("'slack'") && /CATALOG/.test(h))).toBe(true);
		expect(hits.some((h) => /installConnector/.test(h))).toBe(true);
	});

	it("does NOT recommend installConnector for a non-installable catalog entry", async () => {
		// The review-caught bug: a stale/unavailable catalog entry
		// (installable:false) was still told to run installConnector, which is
		// guaranteed to fail. Surface the reason instead.
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [
							{
								id: "spotify",
								name: "Spotify",
								description: "Music",
								detail: {
									installable: false,
									installability_message: "Connector source is no longer available.",
								},
							},
						],
					},
				},
			},
		});
		const hits = await searchLiveConnectors("spotify", env, ctx, deps);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatch(/NOT currently installable/);
		expect(hits[0]).toMatch(/no longer available/);
		expect(hits[0]).not.toMatch(/installConnector/);
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

	it("matches a dotted CONNECTOR id (google.calendar), not just single words", async () => {
		// Connector ids are commonly dotted; searchLiveConnectors must find them by
		// exact id. (search_sdk's method-path skip must not swallow these — its
		// first segment 'google' is not an SDK namespace.)
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [
							{ id: "google.calendar", name: "Google Calendar", description: "Calendar sync" },
						],
					},
				},
			},
		});
		const hits = await searchLiveConnectors("google.calendar", env, ctx, deps);
		expect(hits.some((h) => h.includes("'google.calendar'"))).toBe(true);
	});

	it("drops stopword-only queries so filler words don't match every connector", async () => {
		// "connect a source" is all stopwords → no token → no match (else it would
		// spuriously match on the word 'connect' inside connector descriptions).
		expect(await searchLiveConnectors("connect a source", env, ctx, makeDeps())).toEqual([]);
	});
});
