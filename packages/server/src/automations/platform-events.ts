/**
 * Emit platform operational signals on the same ConnectorTriggerSignal path
 * Automations already use (no special-case agent subsystem).
 */

import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import { feedBackoff } from "../connectors/feed-backoff";
import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import logger from "../utils/logger";
import { insertEvent } from "../utils/insert-event";
import {
	activateAutomationSignal,
	dispatchAutomationRunsBestEffort,
} from "./activation";
import { PLATFORM_EVENT_FEED_AUTO_PAUSED } from "./platform-event-catalog";

export {
	PLATFORM_AUTOMATION_EVENTS,
	PLATFORM_EVENT_FEED_AUTO_PAUSED,
	withPlatformAutomationEvents,
	type PlatformAutomationEventDef,
} from "./platform-event-catalog";

export interface FeedAutoPausedInput {
	organizationId: string;
	feedId: number;
	connectionId: number | null;
	connectorKey: string;
	feedKey: string | null;
	displayName: string | null;
	consecutiveFailures: number;
	lastError: string | null;
	/**
	 * Stable per pause-episode generation for delivery_id idempotency.
	 * Prefer first_failure_at ms so a retried complete after a failed activation
	 * reuses the same delivery_id (runs unique key) instead of permanently
	 * losing the Automation signal.
	 */
	pauseGeneration: string | number;
	/** Sync run that crossed the threshold, when known. */
	runId?: number | null;
	db?: DbClient;
}

function auditOriginId(feedId: number, pauseGeneration: string | number): string {
	return `feed_auto_paused:${feedId}:${pauseGeneration}`;
}

/**
 * Stable pause-episode generation used for delivery_id and audit origin_id.
 * Prefer first_failure_at as integer Unix milliseconds.
 *
 * Millisecond resolution is required, not cosmetic: a resume followed by a new
 * failure episode can land in the same wall-clock second, and a second-grained
 * key would collide with the previous episode's delivery_id and silently drop
 * the new signal.
 *
 * JS and the redelivery SQL filter still agree exactly at ms precision:
 * `first_failure_at` is `timestamptz` (absolute, no local-zone reinterpretation),
 * `EXTRACT(EPOCH FROM …)` returns exact `numeric` (PG 14+) so
 * `FLOOR(epoch * 1000)` is exact integer ms, and the JS Date parser truncates
 * sub-millisecond digits rather than rounding them. Keep both sides on
 * floor-to-ms; do not "align" them by dropping to seconds.
 */
export function pauseGenerationForFeed(row: {
	first_failure_at: Date | string | null;
	consecutive_failures: number | string;
}): number {
	if (row.first_failure_at) {
		const ms = new Date(row.first_failure_at).getTime();
		if (Number.isFinite(ms)) return ms;
	}
	return Number(row.consecutive_failures);
}

/**
 * Emit a connector-neutral Automation signal when a feed hard-pauses after
 * consecutive failures. Idempotent per (feedId, pauseGeneration) via
 * createAutomationEventRun's per-Automation delivery_id dedupe — always call
 * activate so a partial multi-Automation fan-out can finish on retry.
 *
 * Also writes a lifecycle change event (`semantic_type='change'`) with a
 * deterministic origin_id. The audit row is the durable emission marker for
 * redelivery; insert uses onConflictUpdate so concurrent emitters cannot
 * append duplicate current audit events.
 */
export async function emitFeedAutoPaused(
	input: FeedAutoPausedInput,
): Promise<void> {
	const connectionId = input.connectionId;
	if (connectionId == null) {
		logger.warn(
			{ feed_id: input.feedId },
			"[platform-events] feed.auto_paused skipped — feed has no connection_id",
		);
		return;
	}

	const feedLabel =
		input.displayName?.trim() ||
		input.feedKey ||
		`feed ${input.feedId}`;
	const errorLine = (input.lastError ?? "unknown error").slice(0, 500);
	const deliveryId = `feed-auto-paused:${input.feedId}:${input.pauseGeneration}`;
	const originId = auditOriginId(input.feedId, input.pauseGeneration);

	const signal: ConnectorTriggerSignal = {
		connector_key: input.connectorKey,
		connection_id: connectionId,
		resource_type: "feed",
		resource_ref: `feed:${input.feedId}`,
		event_type: PLATFORM_EVENT_FEED_AUTO_PAUSED,
		delivery_id: deliveryId,
		label: `Feed auto-paused: ${feedLabel}`,
		input_text: [
			`Lobu auto-paused the feed "${feedLabel}" after ${input.consecutiveFailures} consecutive sync failures.`,
			`Connector: ${input.connectorKey}`,
			`Feed id: ${input.feedId}`,
			`Connection id: ${connectionId}`,
			input.feedKey ? `Feed key: ${input.feedKey}` : null,
			`Last error: ${errorLine}`,
			"",
			"Investigate auth, device online status, or connector config. Unpause the feed once fixed (or leave it paused).",
		]
			.filter(Boolean)
			.join("\n"),
		occurred_at: new Date().toISOString(),
		attributes: {
			feed_id: input.feedId,
			feed_key: input.feedKey,
			consecutive_failures: input.consecutiveFailures,
			last_error: errorLine,
			run_id: input.runId ?? null,
		},
	};

	// Always activate: createAutomationEventRun dedupes independently per
	// Automation, so partial fan-out retries finish remaining targets.
	const results = await activateAutomationSignal({
		organizationId: input.organizationId,
		signal,
		db: input.db,
	});
	await dispatchAutomationRunsBestEffort(results);
	logger.info(
		{
			feed_id: input.feedId,
			delivery_id: deliveryId,
			activations: results.length,
		},
		"[platform-events] feed.auto_paused signal dispatched",
	);

	// Audit after activate so a mid-activate throw leaves no "done" marker and
	// redelivery will retry. onConflictUpdate + origin_id is the race-safe
	// idempotency path (advisory lock inside insertEvent).
	await insertEvent(
		{
			entityIds: [],
			organizationId: input.organizationId,
			connectionId,
			originId,
			connectorKey: input.connectorKey,
			feedKey: input.feedKey,
			feedId: input.feedId,
			runId: input.runId ?? null,
			title: `Feed auto-paused after ${input.consecutiveFailures} consecutive failures: ${feedLabel}`,
			semanticType: "change",
			originType: "feed_updated",
			payloadType: "empty",
			metadata: {
				category: "lifecycle",
				entity_type: "feed",
				op: "updated",
				entity_id: String(input.feedId),
				extra: {
					reason: PLATFORM_EVENT_FEED_AUTO_PAUSED,
					connector_key: input.connectorKey,
					connection_id: connectionId,
					feed_key: input.feedKey,
					consecutive_failures: input.consecutiveFailures,
					last_error: errorLine,
					run_id: input.runId ?? null,
					delivery_id: deliveryId,
				},
			},
		},
		{ onConflictUpdate: true, sql: input.db },
	);
}

/**
 * After a feed UPDATE that may have hard-paused, load identity and emit when
 * the feed is paused at/above the threshold. Uses a stable delivery_id per
 * failure episode (first_failure_at) so a failed activation can be retried
 * without double-firing later.
 */
export async function maybeEmitFeedAutoPausedAfterFailure(args: {
	feedId: number;
	/** consecutive_failures AFTER the increment */
	consecutiveFailures: number;
	pauseThreshold: number;
	runId?: number | null;
	db?: DbClient;
}): Promise<void> {
	if (args.consecutiveFailures < args.pauseThreshold) return;

	const sql = args.db ?? getDb();
	const rows = (await sql`
		SELECT f.id, f.organization_id, f.connection_id, f.feed_key, f.display_name,
		       f.last_error, f.status, f.consecutive_failures, f.first_failure_at,
		       c.connector_key
		FROM feeds f
		LEFT JOIN connections c ON c.id = f.connection_id
		WHERE f.id = ${args.feedId}
		LIMIT 1
	`) as Array<{
		id: number;
		organization_id: string;
		connection_id: number | null;
		feed_key: string | null;
		display_name: string | null;
		last_error: string | null;
		status: string;
		consecutive_failures: number;
		first_failure_at: Date | string | null;
		connector_key: string | null;
	}>;

	const row = rows[0];
	if (!row || row.status !== "paused") return;
	if (!row.connector_key) {
		logger.warn(
			{ feed_id: args.feedId },
			"[platform-events] feed.auto_paused skipped — missing connector_key",
		);
		return;
	}

	const pauseGeneration = pauseGenerationForFeed(row);

	await emitFeedAutoPaused({
		organizationId: String(row.organization_id),
		feedId: Number(row.id),
		connectionId:
			row.connection_id == null ? null : Number(row.connection_id),
		connectorKey: String(row.connector_key),
		feedKey: row.feed_key,
		displayName: row.display_name,
		consecutiveFailures: Number(row.consecutive_failures),
		lastError: row.last_error,
		pauseGeneration,
		runId: args.runId,
		db: args.db,
	});
}

/**
 * Recover feed.auto_paused emissions that never wrote their durable audit
 * event (crash between hard-pause and emit, or failed activate before audit).
 *
 * The audit row is the completion marker: feeds with no matching Automations
 * still complete once audited, so they cannot starve the redelivery scan.
 * Automation fan-out is always re-attempted on emit; per-Automation delivery_id
 * dedupe in createAutomationEventRun makes that safe.
 */
export async function retryPendingFeedAutoPausedSignals(args?: {
	pauseThreshold?: number;
	limit?: number;
	db?: DbClient;
}): Promise<{ scanned: number; attempted: number; errors: number }> {
	const sql = args?.db ?? getDb();
	const threshold = args?.pauseThreshold ?? feedBackoff.pauseThreshold;
	const limit = Math.min(Math.max(args?.limit ?? 50, 1), 200);

	// Filter missing audit origins in SQL so completed / no-subscriber feeds
	// never occupy the scan window. origin_id matches auditOriginId():
	//   feed_auto_paused:<feedId>:<pauseGeneration>
	// pauseGeneration is floor(epoch ms of first_failure_at) or consecutive_failures;
	// EXTRACT(EPOCH …) is exact numeric, so this matches pauseGenerationForFeed().
	const rows = (await sql`
		SELECT f.id, f.organization_id, f.consecutive_failures, f.first_failure_at
		FROM feeds f
		WHERE f.status = 'paused'
		  AND f.deleted_at IS NULL
		  AND f.consecutive_failures >= ${threshold}
		  AND f.connection_id IS NOT NULL
		  AND NOT EXISTS (
		    SELECT 1
		    FROM events e
		    WHERE e.organization_id = f.organization_id
		      AND e.superseded_by IS NULL
		      AND e.origin_id = (
		        'feed_auto_paused:' || f.id::text || ':' ||
		        CASE
		          WHEN f.first_failure_at IS NOT NULL THEN
		            FLOOR(EXTRACT(EPOCH FROM f.first_failure_at) * 1000)::bigint::text
		          ELSE f.consecutive_failures::text
		        END
		      )
		  )
		ORDER BY f.updated_at ASC, f.id ASC
		LIMIT ${limit}
	`) as Array<{
		id: number;
		organization_id: string;
		consecutive_failures: number;
		first_failure_at: Date | string | null;
	}>;

	let attempted = 0;
	let errors = 0;
	const scanned = rows.length;
	for (const row of rows) {
		attempted++;
		try {
			// Do not forward the scan pool client as `db`. activateAutomationSignal
			// and insertEvent(onConflictUpdate) treat a supplied client as
			// transaction-bound and skip their own advisory-lock transactions;
			// letting each writer own its tx keeps multi-replica redelivery
			// race-safe against concurrent worker completion.
			await maybeEmitFeedAutoPausedAfterFailure({
				feedId: Number(row.id),
				consecutiveFailures: Number(row.consecutive_failures),
				pauseThreshold: threshold,
			});
		} catch (err) {
			errors++;
			logger.error(
				{ feed_id: row.id, error: String(err) },
				"[platform-events] retryPendingFeedAutoPausedSignals failed for feed",
			);
		}
	}
	return { scanned, attempted, errors };
}
