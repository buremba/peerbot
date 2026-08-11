import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../db/client";
import { getConnectorEventKinds } from "../utils/event-kind-validation";

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
 *  - Feed provenance is a `match` filter (`match: { feed_key: 'home_feed' }`),
 *    so the same kind in several feeds aggregates by default and scopes by
 *    match. The `change` attribute likewise distinguishes created vs updated
 *    when a trigger wants only one.
 *
 * Safety bounds:
 *  - Poll-driven ingestion only activates once the feed has a prior successful
 *    sync (`feeds.checkpoint IS NOT NULL`); a cold-start backfill would flood
 *    subscribers with every first-seen row. Webhook-STORE delivery is
 *    definitionally steady-state (a live push) and is never suppressed.
 *  - Only kinds the feed declares are activatable, so a trigger a user could
 *    never author (the picker reads the same catalog) can never fire.
 */

export interface ConnectorDeriveFeedContext {
	organizationId: string;
	connectorKey: string;
	feedKey: string;
	/** A prior successful poll sync exists (`feeds.checkpoint IS NOT NULL`). */
	feedCheckpointed: boolean;
	/** Declared eventKinds for this feed, or null when the connector declares none. */
	eventKinds: Record<string, unknown> | null;
}

export interface ConnectorDeriveEventInput {
	connectionId: number | null;
	feedId: number | null;
	/** null when the row was webhook-STORE'd (no poll run). */
	runId: number | null;
	originId: string;
	kind: string;
	title: string | null;
	payloadText: string | null;
	sourceUrl: string | null;
	occurredAt: Date | string;
	metadata: Record<string, unknown> | undefined;
}

/** Load the per-feed context a batch of events shares (once per sync, not per row). */
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
	const rows = await sql<{ checkpoint: unknown }>`
		SELECT checkpoint
		FROM feeds
		WHERE id = ${args.feedId}
		LIMIT 1
	`;
	const eventKinds = await getConnectorEventKinds(
		args.connectorKey,
		args.feedKey,
		args.organizationId,
	);
	return {
		organizationId: args.organizationId,
		connectorKey: args.connectorKey,
		feedKey: args.feedKey,
		feedCheckpointed: rows[0]?.checkpoint != null,
		eventKinds: (eventKinds as Record<string, unknown> | null) ?? null,
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
	eventId: number,
): ConnectorTriggerSignal[] {
	if (change !== "inserted") return [];
	if (event.connectionId == null || event.feedId == null) return [];
	if (event.runId != null && !ctx.feedCheckpointed) return [];
	if (ctx.eventKinds == null || ctx.eventKinds[event.kind] == null) return [];

	const occurred = new Date(event.occurredAt);
	const occurredAt = Number.isFinite(occurred.getTime())
		? occurred.toISOString()
		: new Date().toISOString();

	// `match` runs exact-equality over signal attributes; surface the row's
	// scalar metadata so connectors get matchable fields for free. Non-scalar
	// values (the TriggerAttributeValueSchema is scalar-only) are dropped.
	const attributes: Record<string, string | number | boolean | null> = {
		feed_key: ctx.feedKey,
		change,
	};
	for (const [key, value] of Object.entries(event.metadata ?? {})) {
		if (
			value !== null &&
			value !== undefined &&
			(typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean")
		) {
			attributes[key] = value;
		}
	}

	return [
		{
			connector_key: ctx.connectorKey,
			connection_id: event.connectionId,
			resource_type: event.kind,
			resource_ref: event.originId,
			event_type: event.kind,
			delivery_id:
				event.runId != null
					? `sync:${event.runId}:event:${eventId}:derived`
					: `store:${ctx.connectorKey}:${event.connectionId}:${event.originId}`,
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
 * (the runtime fires `event_type = kind` for any feed); feed scope is a match
 * filter. Returns `[]` when the connector declares no eventKinds.
 */
export function deriveBehaviorEventCatalogFromFeeds(
	feeds: unknown,
): Array<{ key: string }> {
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
	return [...seen].map((key) => ({ key }));
}
