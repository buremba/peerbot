/**
 * Emit platform operational signals on the same ConnectorTriggerSignal path
 * Behaviors already use (no special-case agent subsystem).
 */

import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import { feedBackoff } from "../connectors/feed-backoff";
import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import logger from "../utils/logger";
import { insertEvent } from "../utils/insert-event";
import {
	activateBehaviorSignal,
	dispatchBehaviorRunsBestEffort,
} from "./activation";
import { PLATFORM_EVENT_FEED_AUTO_PAUSED } from "./platform-event-catalog";

export {
	PLATFORM_BEHAVIOR_EVENTS,
	PLATFORM_EVENT_FEED_AUTO_PAUSED,
	withPlatformBehaviorEvents,
	type PlatformBehaviorEventDef,
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
	 * losing the Behavior signal.
	 */
	pauseGeneration: string | number;
	/** Sync run that crossed the threshold, when known. */
	runId?: number | null;
	db?: DbClient;
}

function auditOriginId(feedId: number, pauseGeneration: string | number): string {
	return `feed_auto_paused:${feedId}:${pauseGeneration}`;
}

async function alreadyDeliveredBehaviorSignal(
	sql: DbClient,
	organizationId: string,
	deliveryId: string,
): Promise<boolean> {
	const rows = (await sql`
		SELECT 1
		FROM runs
		WHERE organization_id = ${organizationId}
		  AND run_type = 'behavior'
		  AND approved_input->'delivery_ids' ? ${deliveryId}
		LIMIT 1
	`) as Array<{ "?column?": number }>;
	return rows.length > 0;
}

async function alreadyWroteAuditEvent(
	sql: DbClient,
	organizationId: string,
	originId: string,
): Promise<boolean> {
	const rows = (await sql`
		SELECT 1
		FROM events
		WHERE organization_id = ${organizationId}
		  AND origin_id = ${originId}
		LIMIT 1
	`) as Array<{ "?column?": number }>;
	return rows.length > 0;
}

/**
 * Emit a connector-neutral Behavior signal when a feed hard-pauses after
 * consecutive failures. Idempotent per (feedId, pauseGeneration) via the run
 * queue's delivery_id unique key.
 *
 * Also writes a lifecycle change event (`semantic_type='change'`) with a
 * deterministic origin_id so retries never append duplicate audit rows.
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

	const sql = input.db ?? getDb();
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

	const signalDone = await alreadyDeliveredBehaviorSignal(
		sql,
		input.organizationId,
		deliveryId,
	);
	if (!signalDone) {
		const results = await activateBehaviorSignal({
			organizationId: input.organizationId,
			signal,
			db: input.db,
		});
		await dispatchBehaviorRunsBestEffort(results);
		logger.info(
			{
				feed_id: input.feedId,
				delivery_id: deliveryId,
				activations: results.length,
			},
			"[platform-events] feed.auto_paused signal dispatched",
		);
	} else {
		logger.debug(
			{ feed_id: input.feedId, delivery_id: deliveryId },
			"[platform-events] feed.auto_paused already delivered — skip activate",
		);
	}

	const auditDone = await alreadyWroteAuditEvent(
		sql,
		input.organizationId,
		originId,
	);
	if (!auditDone) {
		await insertEvent({
			entityIds: [],
			organizationId: input.organizationId,
			connectionId,
			originId,
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
		});
	}
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

	const firstFailMs = row.first_failure_at
		? new Date(row.first_failure_at).getTime()
		: Number(row.consecutive_failures);
	const pauseGeneration = Number.isFinite(firstFailMs)
		? firstFailMs
		: Number(row.consecutive_failures);

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
 * Recover feed.auto_paused deliveries that were lost after a hard pause.
 * Only selects episodes with no Behavior run yet for that delivery_id so
 * retries do not reprocess already-delivered feeds forever.
 */
export async function retryPendingFeedAutoPausedSignals(args?: {
	pauseThreshold?: number;
	limit?: number;
	db?: DbClient;
}): Promise<{ scanned: number; attempted: number; errors: number }> {
	const sql = args?.db ?? getDb();
	const threshold = args?.pauseThreshold ?? feedBackoff.pauseThreshold;
	const limit = Math.min(Math.max(args?.limit ?? 50, 1), 200);

	// Candidate hard-paused feeds; JS builds delivery_id and filters delivered.
	const rows = (await sql`
		SELECT f.id, f.organization_id, f.consecutive_failures, f.first_failure_at
		FROM feeds f
		WHERE f.status = 'paused'
		  AND f.deleted_at IS NULL
		  AND f.consecutive_failures >= ${threshold}
		  AND f.connection_id IS NOT NULL
		ORDER BY f.updated_at ASC
		LIMIT ${limit * 3}
	`) as Array<{
		id: number;
		organization_id: string;
		consecutive_failures: number;
		first_failure_at: Date | string | null;
	}>;

	let attempted = 0;
	let errors = 0;
	let scanned = 0;
	for (const row of rows) {
		if (attempted >= limit) break;
		scanned++;
		const firstFailMs = row.first_failure_at
			? new Date(row.first_failure_at).getTime()
			: Number(row.consecutive_failures);
		const pauseGeneration = Number.isFinite(firstFailMs)
			? firstFailMs
			: Number(row.consecutive_failures);
		const deliveryId = `feed-auto-paused:${row.id}:${pauseGeneration}`;
		const originId = auditOriginId(Number(row.id), pauseGeneration);

		const delivered = await alreadyDeliveredBehaviorSignal(
			sql,
			String(row.organization_id),
			deliveryId,
		);
		const audited = await alreadyWroteAuditEvent(
			sql,
			String(row.organization_id),
			originId,
		);
		// Need retry if either Behavior delivery or audit is missing.
		if (delivered && audited) continue;

		attempted++;
		try {
			await maybeEmitFeedAutoPausedAfterFailure({
				feedId: Number(row.id),
				consecutiveFailures: Number(row.consecutive_failures),
				pauseThreshold: threshold,
				db: sql,
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
