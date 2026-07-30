/**
 * Emit platform operational signals on the same ConnectorTriggerSignal path
 * Behaviors already use (no special-case agent subsystem).
 */

import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import logger from "../utils/logger";
import { recordLifecycleEvent } from "../utils/insert-event";
import {
	activateBehaviorSignal,
	dispatchBehaviorRunsBestEffort,
} from "./activation";
import {
	PLATFORM_EVENT_FEED_AUTO_PAUSED,
} from "./platform-event-catalog";

export {
	PLATFORM_BEHAVIOR_EVENTS,
	PLATFORM_EVENT_FEED_AUTO_PAUSED,
	isPlatformBehaviorEvent,
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
	/** Stable generation for delivery idempotency (e.g. consec count at pause). */
	pauseGeneration: number;
	/** Sync run that crossed the threshold, when known. */
	runId?: number | null;
	db?: DbClient;
}

/**
 * Emit a connector-neutral Behavior signal when a feed hard-pauses after
 * consecutive failures. Idempotent per (feedId, pauseGeneration) via the run
 * queue's delivery_id unique key.
 *
 * Also writes a lifecycle change event so dashboards / knowledge search see
 * the pause.
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

	try {
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
	} catch (error) {
		logger.error(
			{ feed_id: input.feedId, error: String(error) },
			"[platform-events] feed.auto_paused activation failed",
		);
	}

	recordLifecycleEvent({
		organizationId: input.organizationId,
		entityType: "feed",
		op: "updated",
		entityId: input.feedId,
		summary: `Feed auto-paused after ${input.consecutiveFailures} consecutive failures: ${feedLabel}`,
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
	});
}

/**
 * After a feed UPDATE that may have hard-paused, load identity and emit when
 * this failure is the one that crossed the pause threshold.
 */
export async function maybeEmitFeedAutoPausedAfterFailure(args: {
	feedId: number;
	/** consecutive_failures AFTER the increment */
	consecutiveFailures: number;
	pauseThreshold: number;
	/** True when this failure is the one that crossed the threshold. */
	crossedThreshold: boolean;
	runId?: number | null;
	db?: DbClient;
}): Promise<void> {
	if (!args.crossedThreshold) return;
	if (args.consecutiveFailures < args.pauseThreshold) return;

	const sql = args.db ?? getDb();
	const rows = (await sql`
		SELECT f.id, f.organization_id, f.connection_id, f.feed_key, f.display_name,
		       f.last_error, f.status, f.consecutive_failures,
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
		pauseGeneration: Number(row.consecutive_failures),
		runId: args.runId,
		db: args.db,
	});
}
