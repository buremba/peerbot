import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../db/client";

/**
 * Platform-derived connector activation: the events table is the bus, and the
 * connector's declared `eventKinds` are the subscribable catalog. When a feed
 * sync lands a new event, the platform builds the Behavior trigger signal
 * itself instead of the connector hand-writing `behavior_signals`.
 *
 * Convention (default-on, no per-connector declaration needed):
 *  - `event_type` is the feed's declared kind slug.
 *  - Only `change === 'inserted'` activates. A re-scraped row that supersedes
 *    the current head (e.g. an X tweet whose engagement metrics moved) is not
 *    a new source item and does not re-fire — that is what a listener wants.
 *
 * Feed scoping is deliberately NOT exposed: events dedupe by
 * (connection_id, origin_id), so an origin first observed by one feed (e.g. an
 * X tweet seen by the `tweets` search feed) is `unchanged` when another feed
 * (`home_feed`) later observes it — a `match: { feed_key }` subscription would
 * silently miss it. A `feed_key` attribute belongs on the signal only once a
 * durable per-feed first-seen record keyed by (feed_id, origin_id) exists.
 *
 * Safety bounds:
 *  - Ingestion only activates once the feed has a prior successful non-dry
 *    sync; a cold-start backfill would flood subscribers with every first-seen
 *    row. (The webhook-STORE path is expected to derive without that gate when
 *    it lands — a live push is definitionally steady-state — but no producer
 *    uses it yet.)
 *  - Only kinds the feed declares are activatable, so a trigger a user could
 *    never author (the picker reads the same catalog) can never fire.
 */

export interface ConnectorDeriveFeedContext {
	connectorKey: string;
	/** A prior successful, non-dry poll sync exists for this feed. */
	feedPreviouslySynced: boolean;
	/** Declared eventKinds for this feed, or null when the connector declares none. */
	eventKinds: Record<string, unknown> | null;
}

export interface ConnectorDeriveEventInput {
	connectionId: number | null;
	originId: string;
	kind: string;
	title: string | null;
	payloadText: string | null;
	sourceUrl: string | null;
	occurredAt: Date | string;
	metadata: Record<string, unknown> | undefined;
}

/**
 * Load the per-feed context a batch of events shares (once per sync, not per
 * row). A feed/definition that resolves to no activation surface returns a
 * no-op context (no kinds, not previously synced) rather than throwing — only
 * a genuine query failure propagates, fail-closed, to the caller.
 */
export async function loadConnectorDeriveFeedContext(
	args: {
		organizationId: string;
		connectorKey: string;
		feedKey: string;
		feedId: number;
	},
	db?: DbClient,
): Promise<ConnectorDeriveFeedContext> {
	const sql = db ?? getDb();
	const rows = await sql<{
		event_kinds: unknown;
		feed_previously_synced: boolean;
	}>`
		SELECT
			d.feeds_schema -> ${args.feedKey} -> 'eventKinds' AS event_kinds,
			EXISTS (
				SELECT 1
				FROM runs r
				WHERE r.feed_id = f.id
				  AND r.run_type = 'sync'
				  AND r.status = 'completed'
				  AND NOT r.dry_run
			) AS feed_previously_synced
		FROM feeds f
		JOIN connections c
		  ON c.id = f.connection_id
		 AND c.organization_id = f.organization_id
		-- LEFT: a feed whose connector has no active definition (test harnesses,
		-- device manifests, org overrides removed) has no activation surface —
		-- that is a deterministic state, not an activation failure. Only a real
		-- query error below propagates (fail-closed); a missing definition just
		-- yields no eventKinds and therefore no activation.
		LEFT JOIN connector_definitions d
		  ON d.organization_id = f.organization_id
		 AND d.key = c.connector_key
		 AND d.status = 'active'
		WHERE f.id = ${args.feedId}
		  AND f.organization_id = ${args.organizationId}
		  AND f.feed_key = ${args.feedKey}
		  AND f.deleted_at IS NULL
		  AND c.connector_key = ${args.connectorKey}
		LIMIT 1
	`;
	const row = rows[0];
	if (!row) {
		// The feed (or its connection) is not present — a sync referencing a
		// feed that no longer exists has no activation surface. Return a no-op
		// context so the batch ingests without activation; only a real query
		// failure aborts (fail-closed in the caller).
		return {
			connectorKey: args.connectorKey,
			feedPreviouslySynced: false,
			eventKinds: null,
		};
	}
	const eventKinds =
		row.event_kinds && typeof row.event_kinds === "object"
			? (row.event_kinds as Record<string, unknown>)
			: null;
	return {
		connectorKey: args.connectorKey,
		feedPreviouslySynced: row.feed_previously_synced,
		eventKinds,
	};
}

/**
 * Build the Behavior trigger signals for one connector-ingested event, or `[]`
 * when the event must not activate. Pure: the caller already holds the durable
 * row inside the ingest transaction.
 */
export function deriveConnectorActivationSignals(
	ctx: ConnectorDeriveFeedContext,
	event: ConnectorDeriveEventInput,
	change: "inserted" | "superseded" | "unchanged",
): ConnectorTriggerSignal[] {
	if (change !== "inserted") return [];
	if (event.connectionId == null) return [];
	if (!ctx.feedPreviouslySynced) return [];
	if (ctx.eventKinds == null || ctx.eventKinds[event.kind] == null) return [];

	const occurred = new Date(event.occurredAt);
	const occurredAt = Number.isFinite(occurred.getTime())
		? occurred.toISOString()
		: new Date().toISOString();

	// `match` runs exact-equality over signal attributes; surface the row's
	// scalar metadata so connectors get matchable fields for free. Non-scalar
	// values (the TriggerAttributeValueSchema is scalar-only) are dropped.
	// Reserved provenance keys win: connector metadata must not be able to
	// rewrite the change attribute and route activation to the wrong kind.
	const attributes: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(event.metadata ?? {})) {
		if (
			key === "change" ||
			value === null ||
			value === undefined ||
			(typeof value !== "string" &&
				typeof value !== "number" &&
				typeof value !== "boolean")
		) {
			continue;
		}
		attributes[key] = value;
	}
	attributes.change = change;

	return [
		{
			connector_key: ctx.connectorKey,
			connection_id: event.connectionId,
			resource_type: event.kind,
			resource_ref: event.originId,
			event_type: event.kind,
			delivery_id: `derived:${ctx.connectorKey}:${event.connectionId}:${event.originId}`,
			label: event.title ?? `${ctx.connectorKey} ${event.kind}`,
			input_text:
				event.payloadText ??
				event.title ??
				`${ctx.connectorKey} ${event.kind}: ${event.originId}`,
			...(event.sourceUrl ? { url: event.sourceUrl } : {}),
			occurred_at: occurredAt,
			attributes,
		},
	];
}

/**
 * Under the default-on convention, every declared eventKind is a subscribable
 * Behavior trigger type. Same-kind slugs across feeds aggregate into one entry
 * (the runtime fires `event_type = kind` for any feed). Returns `[]` when the
 * connector declares no eventKinds.
 */
export function deriveBehaviorEventCatalogFromFeeds(
	feeds: unknown,
): Array<{ key: string; label: string }> {
	if (!feeds || typeof feeds !== "object") return [];
	const seen = new Set<string>();
	for (const feed of Object.values(feeds as Record<string, unknown>)) {
		if (!feed || typeof feed !== "object") continue;
		const eventKinds = (feed as Record<string, unknown>).eventKinds;
		if (!eventKinds || typeof eventKinds !== "object") continue;
		for (const kind of Object.keys(eventKinds as Record<string, unknown>)) {
			if (kind) seen.add(kind);
		}
	}
	return [...seen].map((key) => ({
		key,
		label: key
			.split(/[._-]+/)
			.filter(Boolean)
			.map((part) => part[0]?.toUpperCase() + part.slice(1))
			.join(" "),
	}));
}

function parseDeclaredBehaviorEvents(
	value: unknown,
): Array<Record<string, unknown> & { key: string }> {
	if (!Array.isArray(value)) return [];
	const out: Array<Record<string, unknown> & { key: string }> = [];
	for (const item of value) {
		if (
			typeof item === "object" &&
			item !== null &&
			typeof (item as { key?: unknown }).key === "string" &&
			(item as { key: string }).key.length > 0
		) {
			const entry = item as Record<string, unknown>;
			// Preserve every validated ConnectorBehaviorEvent field — the UI
			// editor reads filterSchema/description/defaults/resourceType off
			// the catalog, not just key/label/capabilities.
			out.push({ ...entry, key: String(entry.key) });
		}
	}
	return out;
}

/** Bundled immutable catalog shape consumed by {@link resolveBehaviorEventCatalog}. */
export interface BundledBehaviorCatalogEntry {
	behavior_events?: unknown;
	feeds_schema?: unknown;
}

/**
 * Single source of truth for a connector's subscribable Behavior event catalog,
 * shared by trigger validation and the UI picker so the two can never disagree.
 * Precedence: persisted declaration > bundled immutable catalog > default-on
 * derivation from eventKinds.
 *
 * The bundled catalog is used ONLY when provenance proves it: the active
 * definition resolves to the SHARED connector_versions row (organization_id
 * NULL — a bundled install), or the connector is not installed in this org at
 * all (pure catalog entry). An org-scoped override — even one that reuses the
 * bundled key and feedsSchema but omits behaviorEvents — must never resolve to
 * the bundled curated catalog, because its code emits kind slugs, not curated
 * keys, and a catalog that advertises the latter would accept Behaviors that
 * never fire.
 */
export function resolveBehaviorEventCatalog(args: {
	persistedEvents: unknown;
	feedsSchema: unknown;
	bundled?: BundledBehaviorCatalogEntry | null;
	/** Provenance: the resolved version is the shared (bundled) row, or not installed. */
	useBundledFallback: boolean;
}): Array<Record<string, unknown> & { key: string }> {
	const declared = parseDeclaredBehaviorEvents(args.persistedEvents);
	if (declared.length > 0) return declared;

	const bundledDeclared = parseDeclaredBehaviorEvents(args.bundled?.behavior_events);
	if (args.useBundledFallback && bundledDeclared.length > 0) {
		return bundledDeclared;
	}

	// An org-scoped override, or a bundled install with no curated events:
	// derive from the feedsSchema of the definition's own code. An override
	// must NEVER fall back to the bundled feedsSchema (its code emits nothing
	// per its own schema); only a bundled-install resolution may borrow the
	// bundled feeds.
	return deriveBehaviorEventCatalogFromFeeds(
		args.useBundledFallback
			? args.feedsSchema ?? args.bundled?.feeds_schema
			: args.feedsSchema,
	);
}
