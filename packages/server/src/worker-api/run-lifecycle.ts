/**
 * Run lifecycle endpoints.
 *
 * Handlers for the in-flight and completion phases of connector/watcher/auth
 * runs: heartbeat, stream, complete, complete-behavior, complete-action,
 * complete-auth, complete-embeddings, fetch-events, emit-auth-artifact,
 * poll-auth-signal.
 */

import type {
	CompleteActionRequest,
	CompleteAuthRequest,
	CompleteEmbeddingsRequest,
	CompleteRequest,
	EmitAuthArtifactRequest,
	HeartbeatRequest,
	PollAuthSignalRequest,
	StreamBatch,
} from "@lobu/core/contracts/worker/protocol";
import type { Context } from "hono";
import {
	activateBehaviorSignal,
	type BehaviorActivationResult,
	dispatchBehaviorRunsBestEffort,
} from "../behaviors/activation";
import { materializeConnectorBehaviorSignal } from "../behaviors/connector-signal";
import { feedBackoff } from "../connectors/feed-backoff";
import { maybeEmitFeedAutoPausedAfterFailure } from "../behaviors/platform-events";
import { getDb, parsePgNumberArray } from "../db/client";
import { emit } from "../events/emitter";
import { parseJsonBody } from "../gateway/routes/shared/helpers";
import type { Env } from "../index";
import { notifyBrowserAuthExpired } from "../notifications/triggers";
import { supersedeActionEvent } from "../tools/admin/manage_operations";
import {
	type AuthProfileKind,
	getAuthProfileById,
	getBrowserSessionReadiness,
} from "../utils/auth-profiles";
import { toSecretRefAuthData } from "../utils/auth-credential-secrets";
import { autoLinkEvent } from "../utils/auto-linker";
import { nextRunAt as nextRunAtFromCron } from "../utils/cron";
import { needsEmbeddingSql } from "../utils/embeddings";
import { applyEventAttributions } from "../utils/entity-link-upsert";
import { errorMessage } from "../utils/errors";
import { validateConnectorEventSemanticType } from "../utils/event-kind-validation";
import {
	materializeInlineAttachments,
	triggerAudioTranscriptions,
} from "../utils/inline-attachments";
import { insertEvent, recordLifecycleEvent } from "../utils/insert-event";
import logger from "../utils/logger";
import { stripNulDeep } from "../utils/strip-nul";
import {
	bumpDeviceFinalizeNudge,
	markWatcherRunCompleted,
	resolveFinalizeNudgeBudget,
} from "../watchers/run-completion";
import { advanceScheduleAfterTerminalFailure } from "../watchers/schedule-cursor";
import { authorizeRunForWorker } from "./shared";

type DbClient = ReturnType<typeof getDb>;
type SqlFragment = ReturnType<DbClient>;

/**
 * Atomic terminal-state transition guarded on `status = 'running' AND
 * claimed_by = worker_id`. If the run was already finalized by another path
 * (e.g. the gateway reaped it on a timeout and the worker reports in late) or
 * this worker isn't the claimant, the UPDATE matches zero rows — the caller
 * must then skip every side effect and ack idempotently. This is the F2
 * guard shared by every /complete handler; do not relax it.
 *
 * `extraSet` carries handler-specific column writes (e.g. items_collected,
 * exit metadata) and is spliced into the SET list. `returning` is the
 * handler's RETURNING column list. Both are nested `sql` fragments.
 */
async function finalizeRun(
	sql: DbClient,
	params: {
		runId: number;
		workerId: string;
		status: "completed" | "failed";
		extraSet?: SqlFragment;
		returning?: SqlFragment;
	}
): Promise<Array<Record<string, unknown>>> {
	const status = params.status;
	const extra = params.extraSet ?? sql``;
	const returning = params.returning ?? sql`id`;
	return (await sql`
    UPDATE runs
    SET status = ${status},
        completed_at = current_timestamp${extra}
    WHERE id = ${params.runId}
      AND status = 'running'
      AND claimed_by = ${params.workerId}
    RETURNING ${returning}
  `) as unknown as Array<Record<string, unknown>>;
}

/**
 * Reactivate the auth profile + the paused connections/feeds linked to it
 * after a successful auth run. Connections leave `pending_auth`, paused feeds
 * resume with `next_run_at` seeded. Shared by the auth completion path.
 */
async function reactivateProfileCascade(
	sql: DbClient,
	authProfileId: number,
	organizationId: string,
	profileKind: AuthProfileKind | null,
	authData: {
		credentials: Record<string, unknown>;
		metadata: Record<string, unknown>;
	}
): Promise<void> {
	// Only flat bearer-credential kinds (env, oauth_account, …) get their
	// auth_data stored as `secret://` refs. `browser_session` / `interactive`
	// profiles hold structured session state (cookie jars, Baileys creds) that
	// execution passes through verbatim as `sessionState` and never resolves as
	// refs — secret-ref'ing them would both strip their non-string values
	// (normalizeAuthValues keeps only strings) and leave unresolvable refs on
	// the worker. So those kinds pass their session state through unchanged.
	//
	// Secret upsert + profile activation still share one transaction so a
	// partial failure cannot leave a rotated secret without the matching
	// auth_data row (or vice versa).
	const isSessionStateProfile =
		profileKind === "browser_session" || profileKind === "interactive";
	await sql.begin(async (tx) => {
		const nextAuthData = isSessionStateProfile
			? authData.credentials
			: await toSecretRefAuthData({
					organizationId,
					authProfileId,
					credentials: authData.credentials,
					db: tx,
				});
		await tx`
      UPDATE auth_profiles
      SET auth_data = ${tx.json(nextAuthData)},
          metadata = ${tx.json(authData.metadata)},
          status = 'active',
          updated_at = current_timestamp
      WHERE id = ${authProfileId}
    `;
		await tx`
      UPDATE connections
      SET status = 'active', updated_at = current_timestamp
      WHERE auth_profile_id = ${authProfileId}
        AND status = 'pending_auth'
    `;
		await tx`
      UPDATE feeds f
      SET status = 'active',
          next_run_at = COALESCE(f.next_run_at, NOW()),
          updated_at = current_timestamp
      FROM connections c
      WHERE f.connection_id = c.id
        AND c.auth_profile_id = ${authProfileId}
        AND f.status = 'paused'
    `;
	});
}

/**
 * POST /api/workers/heartbeat
 *
 * Worker sends periodic heartbeat to indicate it's still processing.
 */
export async function heartbeat(c: Context<{ Bindings: Env }>) {
	try {
		const { run_id, worker_id, progress } =
			await c.req.json<HeartbeatRequest>();

		const denied = await authorizeRunForWorker(c, run_id, worker_id);
		if (denied) return denied;

		const sql = getDb();

		await sql`
      UPDATE runs
      SET last_heartbeat_at = current_timestamp,
          items_collected = COALESCE(${progress?.items_collected_so_far ?? null}, items_collected)
      WHERE id = ${run_id}
    `;

		return c.json({ continue: true });
	} catch (err: unknown) {
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/stream
 *
 * Worker streams content batch for a sync run.
 */
export async function streamContent(c: Context<{ Bindings: Env }>) {
	try {
		const batch = await c.req.json<StreamBatch>();

		// Connector-supplied checkpoints (LinkedIn takeout cursors, browser
		// scrapes) can carry stray NUL (0x00), which Postgres rejects when written
		// to the jsonb checkpoint column (unsupported Unicode escape sequence).
		// Item payloads go through insertEvent which already sanitizes; the
		// checkpoint writes below are raw sql.json, so strip it here.
		if (batch.checkpoint) {
			batch.checkpoint = stripNulDeep(batch.checkpoint) as Record<
				string,
				unknown
			>;
		}

		const denied = await authorizeRunForWorker(
			c,
			batch.run_id,
			batch.worker_id
		);
		if (denied) return denied;

		const sql = getDb();

		// Look up run details for event columns
		const runRows = (await sql`
    SELECT r.feed_id, r.connection_id, r.connector_key, r.organization_id,
           f.feed_key, f.entity_ids
    FROM runs r
    LEFT JOIN feeds f ON f.id = r.feed_id
    WHERE r.id = ${batch.run_id}
  `) as unknown as Array<{
			feed_id: number | null;
			connection_id: number | null;
			connector_key: string;
			organization_id: string;
			feed_key: string | null;
			entity_ids: number[] | null;
		}>;

		if (runRows.length === 0) {
			return c.json({ error: "Run not found" }, 404);
		}

		const run = runRows[0];
		const entityIds = parsePgNumberArray(run.entity_ids);

		// Connector-emitted inline attachments (e.g. whatsapp.local voice notes)
		// come over the wire as base64 in `attachment.data`. Materialize each into
		// the ArtifactStore before the row hits events.attachments — the events
		// table is not a binary store. Audio attachments are queued for async
		// transcription after insert.
		const { items: materializedItems, pendingTranscriptions } =
			await materializeInlineAttachments(batch.items);
		batch.items = materializedItems as typeof batch.items;

		// Resolve or create entities declared via eventKinds[kind].attributions
		// before inserting events. One query per (entityType, matchField) per
		// batch — cheap compared to the per-event inserts that follow.
		await applyEventAttributions({
			connectorKey: run.connector_key,
			connectionId: run.connection_id,
			feedKey: run.feed_key,
			orgId: run.organization_id,
			items: batch.items,
		});

		let totalItems = 0;
		const rejectedItems: Array<{
			id: string;
			semantic_type?: string;
			errors: string[];
		}> = [];

		for (const item of batch.items) {
			try {
				const itemOriginType = item.origin_type ?? null;
				const itemSemanticType =
					item.semantic_type ?? itemOriginType ?? "content";
				const validationType = itemOriginType ?? itemSemanticType;

				// Validate connector-declared type against the feed's eventKinds schema.
				if (validationType && run.feed_key) {
					const kindResult = await validateConnectorEventSemanticType(
						validationType,
						item.metadata as Record<string, unknown> | undefined,
						run.connector_key,
						run.feed_key,
						run.organization_id
					);
					if (!kindResult.valid) {
						logger.warn(
							{
								run_id: batch.run_id,
								item_id: item.id,
								semantic_type: validationType,
								errors: kindResult.errors,
							},
							"Connector event semantic type validation failed — rejecting event"
						);
						rejectedItems.push({
							id: item.id,
							semantic_type: validationType,
							errors: kindResult.errors,
						});
						continue;
					}
				}

				// Skip events with no content — connectors must provide text
				if (!item.payload_text && !item.title) {
					logger.warn(
						{
							run_id: batch.run_id,
							item_id: item.id,
							connector: run.connector_key,
						},
						"[stream] Skipping event with empty payload_text and title"
					);
					continue;
				}

				const activations: BehaviorActivationResult[] = [];
				const inserted = await insertEvent(
					{
						entityIds: entityIds,
						organizationId: run.organization_id,
						originId: item.id,
						title: item.title,
						payloadType: item.payload_type,
						content: item.payload_text,
						payloadData: item.payload_data,
						payloadTemplate: item.payload_template,
						attachments: item.attachments,
						authorName: item.author_name,
						sourceUrl: item.source_url,
						occurredAt: item.occurred_at,
						score: item.score,
						embedding: item.embedding,
						embeddingModel: item.embedding_model,
						metadata: item.metadata as Record<string, unknown> | undefined,
						semanticType: itemSemanticType,
						originType: itemOriginType,
						connectorKey: run.connector_key,
						connectionId: run.connection_id,
						feedKey: run.feed_key,
						feedId: run.feed_id,
						runId: batch.run_id,
						parentOriginId: item.origin_parent_id,
					},
					{
						onConflictUpdate: true,
						afterPersist: async (persisted, tx) => {
							for (const [draftIndex, draft] of (
								item.behavior_signals ?? []
							).entries()) {
								const signal = materializeConnectorBehaviorSignal({
									draft,
									change: persisted.change,
									connectorKey: run.connector_key,
									connectionId: run.connection_id,
									deliveryId: `sync:${batch.run_id}:event:${persisted.id}:${draftIndex}`,
								});
								if (!signal) continue;
								activations.push(
									...(await activateBehaviorSignal({
										organizationId: run.organization_id,
										signal,
										db: tx,
									}))
								);
							}
						},
					}
				);
				await dispatchBehaviorRunsBestEffort(activations);
				if (inserted) {
					totalItems++;
					if (entityIds.length > 0) {
						autoLinkEvent({
							eventId: Number(inserted.id),
							entityIds,
							content: item.payload_text,
							title: item.title,
							organizationId: run.organization_id,
						}).catch(() => {});
					}
				}
			} catch (err) {
				console.error("[stream] Insert failed for item", item.id, ":", err);
				throw err;
			}
		}

		// Kick off background transcription for any audio attachments
		// materialized above. Runs detached — never blocks the stream-batch ack.
		triggerAudioTranscriptions(run.organization_id, pendingTranscriptions);

		// Update feed + run checkpoint if provided (so mid-run state like QR codes
		// surface in UI via recent_runs[0].checkpoint before the run completes).
		if (batch.checkpoint) {
			if (run.feed_id) {
				await sql`
      UPDATE feeds
      SET checkpoint = ${sql.json(batch.checkpoint)},
          updated_at = current_timestamp
      WHERE id = ${run.feed_id}
    `;
			}
			await sql`
      UPDATE runs
      SET checkpoint = ${sql.json(batch.checkpoint)}
      WHERE id = ${batch.run_id}
    `;
		}

		return c.json({
			batches_received: 1,
			total_items: totalItems,
			...(rejectedItems.length > 0 && { rejected_items: rejectedItems }),
		});
	} catch (err: unknown) {
		const stack = err instanceof Error ? err.stack : undefined;
		console.error("[stream] Error:", errorMessage(err), stack);
		return c.json({ error: errorMessage(err), stack }, 500);
	}
}

/**
 * POST /api/workers/complete
 *
 * Worker signals sync run completion (success or failure).
 */
export async function completeWorkerJob(c: Context<{ Bindings: Env }>) {
	try {
		const req = await c.req.json<CompleteRequest>();

		// Strip NUL (0x00) from connector-supplied jsonb payloads before they hit
		// Postgres (see streamContent). The final checkpoint and refreshed browser
		// auth_update are written via raw sql.json below.
		if (req.checkpoint) {
			req.checkpoint = stripNulDeep(req.checkpoint) as Record<string, unknown>;
		}
		if (req.auth_update) {
			req.auth_update = stripNulDeep(req.auth_update) as Record<
				string,
				unknown
			>;
		}

		const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
		if (denied) return denied;

		const sql = getDb();

		// Atomic terminal-state transition with the shared F2 guard (see
		// finalizeRun). A no-op (0 rows) means the run was already finalized by
		// another path (e.g. the gateway reaped it on timeout and the worker is
		// reporting in late) or this worker isn't the claimant — without it a late
		// completion resurrects a reaped run and the feed/auth bookkeeping below
		// double-applies (consecutive_failures, items_collected, next_run_at,
		// auth_data). The failed path also stamps exit diagnostics.
		const updatedRuns = (await finalizeRun(sql, {
			runId: req.run_id,
			workerId: req.worker_id,
			status: req.status === "failed" ? "failed" : "completed",
			extraSet:
				req.status === "failed"
					? sql`,
          items_collected = ${req.items_collected ?? 0},
          error_message = ${req.error_message ?? null},
          checkpoint = COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint),
          output_tail = ${req.output_tail ?? null},
          exit_code = ${req.exit_code ?? null},
          exit_signal = ${req.exit_signal ?? null},
          exit_reason = ${req.exit_reason ?? null}`
					: sql`,
          items_collected = ${req.items_collected ?? 0},
          error_message = ${req.error_message ?? null},
          checkpoint = COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint)`,
			returning: sql`feed_id, connection_id`,
		})) as unknown as Array<{
			feed_id: number | null;
			connection_id: number | null;
		}>;

		if (updatedRuns.length === 0) {
			// The run was already finalized (timeout race) or this worker isn't the
			// claimant. Skip all feed/auth bookkeeping and return an idempotent
			// already-finalized response.
			logger.info(
				{
					run_id: req.run_id,
					worker_id: req.worker_id,
					claimed_status: req.status,
				},
				"[completeWorkerJob] no-op: run already in terminal state (likely gateway timeout)"
			);
			return c.json({ success: false, reason: "already_finalized" });
		}

		// Update the feed's sync state
		const runRows = updatedRuns;
		const feedId = runRows[0]?.feed_id;

		if (feedId) {
			const feedRows = (await sql`
      SELECT schedule, timezone FROM feeds WHERE id = ${feedId}
    `) as unknown as Array<{
				schedule: string | null;
				timezone: string | null;
			}>;

			// Manual feeds (no schedule) stay unscheduled after completion.
			const schedule = feedRows[0]?.schedule ?? null;
			const nextRun = schedule
				? nextRunAtFromCron(schedule, new Date(), feedRows[0]?.timezone ?? null)
				: null;
			const isSuccess = req.status === "success";

			// Failure rescheduling (item 5, #2033):
			//  - On success: reset consecutive_failures to 0 and use the plain cron
			//    next_run_at so a recovered feed immediately resumes normal cadence.
			//  - On failure: apply exponential backoff on top of the cron cadence so
			//    a persistently-failing feed retries progressively less often instead
			//    of re-enqueueing every plain cadence (which hammered the connector,
			//    the worker lane, and upstream rate limits). The backoff is computed
			//    from the NEW consecutive_failures count (post-increment) directly in
			//    SQL so it stays correct under concurrent completions across replicas.
			//  - Hard auto-pause: once the NEW count crosses the pause threshold, the
			//    feed is paused (status='paused'; the DB trigger nulls next_run_at).
			//    Crossing the threshold emits feed.auto_paused so Behaviors can react.
			//    Manual feeds (no schedule) can't exponentially back off (nextRun is
			//    NULL) but still hard-pause.
			const backoffBaseMs = feedBackoff.baseMs;
			const backoffMaxMs = feedBackoff.maxMs;
			const pauseThreshold = feedBackoff.pauseThreshold;

			const feedUpdate = (await sql`
        UPDATE feeds
        SET last_sync_at = current_timestamp,
            last_sync_status = ${req.status},
            last_error = ${isSuccess ? null : (req.error_message ?? null)},
            consecutive_failures = ${isSuccess ? sql`0` : sql`consecutive_failures + 1`},
            first_failure_at = ${isSuccess ? sql`NULL` : sql`COALESCE(first_failure_at, current_timestamp)`},
            items_collected = ${isSuccess ? sql`items_collected + ${req.items_collected ?? 0}` : sql`items_collected`},
            checkpoint = ${isSuccess ? sql`COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint)` : sql`checkpoint`},
            status = ${
							isSuccess
								? sql`status`
								: sql`CASE WHEN consecutive_failures + 1 >= ${pauseThreshold} THEN 'paused' ELSE status END`
						},
            next_run_at = ${
							isSuccess
								? nextRun
								: sql`CASE
                    WHEN consecutive_failures + 1 >= ${pauseThreshold} THEN NULL
                    WHEN ${nextRun}::timestamptz IS NULL THEN NULL
                    ELSE GREATEST(
                      ${nextRun}::timestamptz,
                      current_timestamp + (LEAST(
                        ${backoffBaseMs}::bigint * (2 ^ LEAST(consecutive_failures, 30))::bigint,
                        ${backoffMaxMs}::bigint
                      ) || ' milliseconds')::interval
                    )
                  END`
						},
            updated_at = current_timestamp
        WHERE id = ${feedId}
        RETURNING consecutive_failures, status
      `) as Array<{ consecutive_failures: number; status: string }>;

			if (!isSuccess) {
				const after = feedUpdate[0];
				const consec = Number(after?.consecutive_failures ?? 0);
				// Emit when paused at/above threshold. delivery_id is stable per
				// failure episode (first_failure_at), so retries after a failed
				// activation are idempotent and do not double-queue Behaviors.
				try {
					await maybeEmitFeedAutoPausedAfterFailure({
						feedId,
						consecutiveFailures: consec,
						pauseThreshold,
						runId: req.run_id,
					});
				} catch (err) {
					// Feed is already paused; log hard so we notice lost activation,
					// but do not fail the worker complete ACK (run is terminal).
					logger.error(
						{ feed_id: feedId, error: errorMessage(err) },
						"[completeWorkerJob] maybeEmitFeedAutoPausedAfterFailure threw",
					);
				}
			}
		}

		// Persist refreshed browser auth data on the auth profile
		const connectionId = runRows[0]?.connection_id;
		if (req.status === "success" && req.auth_update && connectionId) {
			const connectionRows = (await sql`
        SELECT c.organization_id, c.connector_key, c.auth_profile_id
        FROM connections c
        WHERE c.id = ${connectionId}
        LIMIT 1
      `) as Array<{
				organization_id: string;
				connector_key: string;
				auth_profile_id: number | null;
			}>;

			const connection = connectionRows[0];
			const authProfile =
				connection?.auth_profile_id != null
					? await getAuthProfileById(
							connection.organization_id,
							connection.auth_profile_id
						)
					: null;

			if (authProfile?.profile_kind === "browser_session") {
				const nextAuthData = {
					...(authProfile.auth_data ?? {}),
					...req.auth_update,
				};
				const nextStatus = (
					await getBrowserSessionReadiness(
						nextAuthData,
						connection.connector_key
					)
				).usable
					? "active"
					: "pending_auth";

				await sql`
          UPDATE auth_profiles
          SET auth_data = ${sql.json(nextAuthData)},
              status = ${nextStatus},
              updated_at = current_timestamp
          WHERE id = ${authProfile.id}
        `;

				await sql`
          UPDATE connections
          SET status = ${nextStatus === "active" ? "active" : "pending_auth"},
              updated_at = current_timestamp
          WHERE auth_profile_id = ${authProfile.id}
        `;

				await sql`
          UPDATE feeds f
          SET status = ${nextStatus === "active" ? "active" : "paused"},
              next_run_at = ${
								nextStatus === "active"
									? sql`COALESCE(f.next_run_at, NOW())`
									: sql`NULL`
							},
              updated_at = current_timestamp
          FROM connections c
          WHERE f.connection_id = c.id
            AND c.auth_profile_id = ${authProfile.id}
        `;

				if (nextStatus === "pending_auth") {
					notifyBrowserAuthExpired({
						orgId: connection.organization_id,
						connectionId,
						connectorKey: connection.connector_key,
						authProfileSlug: authProfile.slug,
					}).catch(() => {});
				}
			} else if (authProfile?.profile_kind === "interactive") {
				// Interactive profiles (e.g. WhatsApp/Baileys) manage their own session
				// tokens. Merge the connector's auth_update into auth_data. A sentinel
				// { creds: null } wipes the profile and forces re-pair.
				const update = (req.auth_update ?? {}) as Record<string, unknown>;
				const wiped = update.creds === null;
				const nextAuthData = wiped
					? {}
					: { ...(authProfile.auth_data ?? {}), ...update };
				const nextStatus = wiped ? "pending_auth" : "active";

				await sql`
          UPDATE auth_profiles
          SET auth_data = ${sql.json(nextAuthData)},
              status = ${nextStatus},
              updated_at = current_timestamp
          WHERE id = ${authProfile.id}
        `;

				if (wiped) {
					await sql`
            UPDATE connections
            SET status = 'pending_auth',
                updated_at = current_timestamp
            WHERE auth_profile_id = ${authProfile.id}
          `;
					await sql`
            UPDATE feeds f
            SET status = 'paused', next_run_at = NULL, updated_at = current_timestamp
            FROM connections c
            WHERE f.connection_id = c.id AND c.auth_profile_id = ${authProfile.id}
          `;
				}
			}
		}

		logger.info({ run_id: req.run_id, status: req.status }, "Run completed");

		return c.json({ success: true });
	} catch (err: unknown) {
		logger.error({ error: errorMessage(err) }, "[completeWorkerJob] Error");
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * Prompt appended to the re-spawned CLI when a device Behavior exited without
 * calling completeWindow. Module-level so a granted resume and its idempotent
 * replay hand the device byte-identical instructions.
 */
const MISSING_COMPLETE_WINDOW_NUDGE =
	"Device CLI exited without calling completeWindow. Re-run the Behavior task and " +
	"finalize via the lobu skill + CLI (preferred): " +
	"`lobu memory exec` with client.knowledge.read({ watcher_id }) then " +
	"client.behaviors.completeWindow({ window_token, extracted_data, behavior_run_id }). " +
	"MCP query_sdk/run_sdk is also fine if wired. Do not only print a summary.";

/**
 * POST /api/workers/me/runs/:runId/complete-behavior
 *
 * Device-side EXIT REPORT for a watcher run executed by a local CLI agent
 * (Claude Code, agy, etc.) on the user's machine. The Owletto Mac app's
 * `WatcherDispatcher` posts here once the subprocess exits.
 *
 * The agent is expected to complete window Behaviors itself — via Lobu MCP
 * tools (`query_sdk` / `run_sdk` → `completeWindow`) and/or the local
 * `lobu` CLI (`lobu memory exec` with the same ClientSDK calls). This
 * endpoint records process exit metadata and enforces the finalize contract:
 *
 * - body.error set → the subprocess crashed/timed out → run failed.
 * - clean exit + run already completed (by complete_window) → ack; stamp
 *   exit metadata and the window's wall-clock.
 * - clean exit + event-turn Behavior still running → complete without a
 *   window (turn path has no completeWindow step).
 * - clean exit + window Behavior still running + finalize budget left →
 *   status `resume` (run stays claimed/running; Mac re-spawns with nudge).
 * - clean exit + window Behavior still running + budget exhausted →
 *   failed with reason_code `missing_complete_window`.
 * - a replay of a report already answered with a resume (body
 *   `finalize_attempt` behind the stored count, i.e. the device never saw the
 *   response) → the same `resume` again, consuming no further attempt.
 *
 * Authorization: the caller must own the claim — same gate as
 * /api/workers/complete (status='running' AND claimed_by === worker_id).
 */
export async function completeBehaviorRun(c: Context<{ Bindings: Env }>) {
	const runIdParam = c.req.param("runId");
	if (!runIdParam) {
		return c.json({ error: "runId is required" }, 400);
	}
	const runId = Number(runIdParam);
	if (!Number.isFinite(runId) || runId <= 0) {
		return c.json({ error: "Invalid runId" }, 400);
	}

	const body = await parseJsonBody<{
		worker_id: string;
		output?: string;
		error?: string;
		duration_ms?: number;
		exit_code?: number | null;
		exit_signal?: string | null;
		exit_reason?: "ok" | "error_message" | "timeout" | "oom" | "crash";
		/**
		 * Which finalize attempt this report covers: the run's
		 * `finalize_nudge_count` at the time the reporting spawn started. 0 for
		 * the first spawn. Makes the report replayable — see the replay guard
		 * below.
		 */
		finalize_attempt?: number;
	}>(c, "Invalid or missing JSON body");
	if (body instanceof Response) return body;

	// allowTerminal: when the CLI agent already completed the run via MCP
	// complete_window, the exit report arrives against a terminal run — that's
	// the happy path. Ownership (scope + claimed_by) is still enforced.
	const denied = await authorizeRunForWorker(c, runId, body.worker_id, {
		allowTerminal: true,
	});
	if (denied) return denied;

	const sql = getDb();
	// Reload the row now that authorization has cleared. Status drives the
	// exit-report decision; the authoritative guard against double-writes is
	// failRun's status-filtered UPDATE, so a stale read can't double-fail —
	// at worst it reports `idempotent: true` with the loser's view.
	const runRows = (await sql`
    SELECT id, organization_id, watcher_id, approved_input, run_type, claimed_at, status, window_id
    FROM runs
    WHERE id = ${runId}
    LIMIT 1
  `) as unknown as Array<{
		id: number;
		organization_id: string;
		watcher_id: number | null;
		approved_input: Record<string, unknown> | null;
		run_type: string;
		claimed_at: string | Date | null;
		status: string;
		window_id: number | null;
	}>;
	const run = runRows[0];
	if (!run) return c.json({ error: "Run not found" }, 404);
	if (run.run_type !== "behavior") {
		return c.json({ error: "Not a Behavior run" }, 409);
	}
	if (run.watcher_id == null) {
		return c.json({ error: "Behavior run missing watcher_id" }, 500);
	}

	const watcherId = Number(run.watcher_id);
	const approved = (run.approved_input ?? {}) as Record<string, unknown>;

	// Fix 2 (pi round-2): device-identity binding pinned to the OAuth token, not
	// the request body.
	//
	// The previous version looked up `(workerUserId, body.worker_id)` in
	// `device_workers`, but `body.worker_id` is client-supplied. A same-user
	// token could complete as a different registered worker by posting that
	// worker's id. The fix is the same trick `pollWorkerJob` already uses: if
	// the token was minted with a `workerId` binding (`device_worker:run`
	// PATs/OAuth tokens always are), require `body.worker_id === boundWorkerId`
	// AND, if the run is pinned to a device, the bound worker's
	// `device_workers.id` matches `approved_input.device_worker_id`.
	//
	// For legacy/admin tokens with no `workerId` binding we fall through to the
	// old user_id+worker_id lookup, but emit a warning so the audit trail can
	// catch this path if it ever fires in production (Lobu for Mac always
	// mints worker-bound tokens via /api/me/devices/mint-child-token).
	if (c.var.workerAuthMode === "user") {
		const workerUserId = c.var.workerUserId;
		const boundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
		const pinnedDeviceWorkerId =
			typeof approved.device_worker_id === "string"
				? approved.device_worker_id
				: null;

		if (boundWorkerId) {
			if (boundWorkerId !== body.worker_id) {
				logger.warn(
					{
						run_id: runId,
						body_worker_id: body.worker_id,
						bound_worker_id: boundWorkerId,
					},
					"[completeBehaviorRun] body.worker_id != token-bound worker_id — rejecting"
				);
				return c.json(
					{
						error: "worker_id_mismatch",
						error_description: `this token is bound to worker_id '${boundWorkerId}'`,
					},
					403
				);
			}
			if (pinnedDeviceWorkerId && workerUserId) {
				const deviceRows = (await sql`
          SELECT id
          FROM device_workers
          WHERE user_id = ${workerUserId}
            AND worker_id = ${boundWorkerId}
          LIMIT 1
        `) as unknown as Array<{ id: string }>;
				const callerDeviceWorkerId = deviceRows[0]?.id ?? null;
				if (
					!callerDeviceWorkerId ||
					callerDeviceWorkerId !== pinnedDeviceWorkerId
				) {
					logger.warn(
						{
							run_id: runId,
							bound_worker_id: boundWorkerId,
							caller_device: callerDeviceWorkerId,
							pinned_device: pinnedDeviceWorkerId,
						},
						"[completeBehaviorRun] device_worker_id mismatch — rejecting"
					);
					return c.json({ error: "Forbidden: device worker mismatch" }, 403);
				}
			}
		} else if (workerUserId && pinnedDeviceWorkerId) {
			// Legacy/admin path: no worker-bound token. Fall back to the
			// (user_id, body.worker_id) lookup; this is weaker than the bound path
			// but still gates on user ownership. Emit a warning so prod telemetry
			// can flag if any non-Mac caller hits this branch.
			logger.warn(
				{
					run_id: runId,
					worker_user_id: workerUserId,
					body_worker_id: body.worker_id,
				},
				"[completeBehaviorRun] no token-bound workerId — falling back to user_id+worker_id check"
			);
			const deviceRows = (await sql`
        SELECT id
        FROM device_workers
        WHERE user_id = ${workerUserId}
          AND worker_id = ${body.worker_id}
        LIMIT 1
      `) as unknown as Array<{ id: string }>;
			const callerDeviceWorkerId = deviceRows[0]?.id ?? null;
			if (
				!callerDeviceWorkerId ||
				callerDeviceWorkerId !== pinnedDeviceWorkerId
			) {
				logger.warn(
					{
						run_id: runId,
						body_worker_id: body.worker_id,
						caller_device: callerDeviceWorkerId,
						pinned_device: pinnedDeviceWorkerId,
					},
					"[completeBehaviorRun] device_worker_id mismatch (legacy path) — rejecting"
				);
				return c.json({ error: "Forbidden: device worker mismatch" }, 403);
			}
		}
	}

	const hasError = typeof body.error === "string" && body.error.trim() !== "";
	const output = typeof body.output === "string" ? body.output : "";
	const durationMs =
		typeof body.duration_ms === "number" && Number.isFinite(body.duration_ms)
			? Math.max(0, Math.floor(body.duration_ms))
			: null;

	// Mark the run failed and, for non-event dispatches, tick the schedule
	// forward. The RETURNING guard keeps a concurrent duplicate POST from
	// advancing `next_run_at` twice and skipping a window.
	// The stdout tail is stashed for diagnosis (why didn't the agent call
	// complete_window?); the worker redacts before sending.
	const failRun = async (reason: string): Promise<boolean> => {
		return sql.begin(async (tx) => {
			const failedRows = (await tx`
        UPDATE runs
        SET status = 'failed',
            completed_at = current_timestamp,
            error_message = ${reason},
            output_tail = ${output ? output.slice(-2000) : null},
            exit_code = ${body.exit_code ?? null},
            exit_signal = ${body.exit_signal ?? null},
            exit_reason = ${body.exit_reason ?? "error_message"}
        WHERE id = ${runId}
          AND status = 'running'
        RETURNING id
      `) as unknown as Array<{ id: number }>;
			if (failedRows.length === 0) return false;
			await tx`
        UPDATE watchers
        SET last_fired_at = NOW(), updated_at = NOW()
        WHERE id = ${watcherId}
      `;
			await advanceScheduleAfterTerminalFailure(
				tx,
				watcherId,
				typeof approved.dispatch_source === "string"
					? approved.dispatch_source
					: null
			);
			return true;
		});
	};

	const emitCompletionEvent = (
		outcome: "completed" | "failed",
		detail?: string
	) => {
		// Fire-and-forget: a "change" event so the dashboard's metric_series picks
		// up the device-CLI completion the same way it picks up server-side ones.
		// LifecycleOp is restricted to created/updated/deleted — we use 'updated'
		// and put the actual ran/errored detail under `extra`.
		recordLifecycleEvent({
			organizationId: run.organization_id,
			entityType: "watcher",
			op: "updated",
			entityId: String(watcherId),
			summary:
				outcome === "failed"
					? `Behavior run ${runId} failed on device CLI: ${detail ?? "unknown error"}`
					: `Behavior run ${runId} completed via device CLI`,
			extra: {
				run_id: runId,
				source: "device_worker",
				outcome,
				duration_ms: durationMs,
			},
		});
	};

	if (hasError) {
		const transitioned = await failRun(body.error as string);
		if (!transitioned) {
			const finalRows = (await sql`
        SELECT status FROM runs WHERE id = ${runId} LIMIT 1
      `) as unknown as Array<{ status: string }>;
			return c.json({
				ok: true,
				status: finalRows[0]?.status ?? "failed",
				idempotent: true,
			});
		}
		emitCompletionEvent("failed", body.error);
		return c.json({ ok: true, status: "failed" });
	}

	// Clean exit + run already completed: the agent finished the job over MCP
	// (query_sdk → completeWindow) before the subprocess exited. Stamp
	// the device-side provenance the pipeline can't know — exit metadata and
	// the subprocess wall-clock — plus the cooldown bookkeeping. The
	// `exit_reason IS NULL` filter makes this first-report-only: a duplicate
	// exit report matches zero rows and acks without re-firing side effects.
	if (run.status === "completed") {
		const stamped = (await sql`
      UPDATE runs
      SET exit_code = ${body.exit_code ?? null},
          exit_signal = ${body.exit_signal ?? null},
          exit_reason = ${body.exit_reason ?? "ok"}
      WHERE id = ${runId}
        AND exit_reason IS NULL
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		if (stamped.length === 0) {
			return c.json({
				ok: true,
				status: "completed",
				window_id: run.window_id,
				idempotent: true,
			});
		}
		if (run.window_id != null) {
			const agentKind =
				typeof approved.agent_kind === "string" &&
				(approved.agent_kind as string).trim()
					? (approved.agent_kind as string).trim()
					: null;
			// Deterministic provenance from the system of record (the run's pinned
			// agent_kind): the agent isn't trusted to self-report `model` through
			// complete_window, so runs it left on the pipeline default get the device
			// stamp. An explicit model passed by the agent wins. Provenance now lives
			// on the RUN row (model_used / run_metadata.execution_time_ms), not the
			// retired watcher_windows table — the canvas is the window projection and
			// reads pull execution_time_ms from run timestamps / run_metadata.
			await sql`
        UPDATE runs
        SET model_used = CASE
              WHEN model_used = 'external-client' OR model_used IS NULL
                THEN ${agentKind ? `device-cli:${agentKind}` : "device-cli"}
              ELSE model_used
            END,
            run_metadata = CASE
              -- jsonb_set is STRICT: a NULL new_value would null out the whole
              -- run_metadata. No duration from the device and none recorded →
              -- leave run_metadata untouched.
              WHEN COALESCE(
                ${durationMs}::bigint,
                (run_metadata->>'execution_time_ms')::bigint
              ) IS NULL THEN run_metadata
              ELSE jsonb_set(
                COALESCE(run_metadata, '{}'::jsonb),
                '{execution_time_ms}',
                to_jsonb(COALESCE(
                  ${durationMs}::bigint,
                  (run_metadata->>'execution_time_ms')::bigint
                ))
              )
            END
        WHERE id = ${runId}
      `;
		}
		await sql`
      UPDATE watchers
      SET last_fired_at = NOW(), updated_at = NOW()
      WHERE id = ${watcherId}
    `;
		emitCompletionEvent("completed");
		return c.json({ ok: true, status: "completed", window_id: run.window_id });
	}

	// Already failed/timed out (a concurrent report, the reconciler, or the
	// 2h sweep won): idempotent ack, no side effects.
	if (run.status !== "running") {
		return c.json({ ok: true, status: run.status, idempotent: true });
	}

	// Clean exit but the run is still `running`.
	// Event turns complete on agent reply — no completeWindow.
	if (approved.trigger_execution === "turn") {
		const agentKind =
			typeof approved.agent_kind === "string" &&
			(approved.agent_kind as string).trim()
				? (approved.agent_kind as string).trim()
				: null;
		// First-report-only: a duplicate/concurrent report finds the row already
		// out of an active status, so it acks instead of re-stamping exit metadata
		// and re-emitting the completion event.
		const marked = await markWatcherRunCompleted(
			sql,
			runId,
			null,
			agentKind ? `device-cli:${agentKind}` : "device-cli"
		);
		if (!marked) {
			const finalRows = (await sql`
        SELECT status FROM runs WHERE id = ${runId} LIMIT 1
      `) as unknown as Array<{ status: string }>;
			return c.json({
				ok: true,
				status: finalRows[0]?.status ?? "failed",
				idempotent: true,
			});
		}
		await sql`
      UPDATE runs
      SET exit_code = ${body.exit_code ?? null},
          exit_signal = ${body.exit_signal ?? null},
          exit_reason = ${body.exit_reason ?? "ok"},
          output_tail = ${output ? output.slice(-2000) : null},
          run_metadata = CASE
            WHEN ${durationMs}::bigint IS NULL THEN COALESCE(run_metadata, '{}'::jsonb)
            ELSE jsonb_set(
              COALESCE(run_metadata, '{}'::jsonb),
              '{execution_time_ms}',
              to_jsonb(${durationMs}::bigint)
            )
          END
      WHERE id = ${runId}
    `;
		await sql`
      UPDATE watchers
      SET last_fired_at = NOW(), updated_at = NOW()
      WHERE id = ${watcherId}
    `;
		emitCompletionEvent("completed");
		return c.json({
			ok: true,
			status: "completed",
			reason_code: "event_turn",
			window_id: null,
		});
	}

	// Window Behavior: agent never called completeWindow. Bounded device-held
	// resume (same finalize_nudges budget as cloud) so the Mac can re-spawn.
	const watcherRows = (await sql`
    SELECT execution_config
    FROM watchers
    WHERE id = ${watcherId}
    LIMIT 1
  `) as unknown as Array<{
		execution_config: Record<string, unknown> | null;
	}>;
	const budget = resolveFinalizeNudgeBudget(
		watcherRows[0]?.execution_config ?? null
	);
	const nudgeCount = Number(approved.finalize_nudge_count ?? 0);
	const attemptsSoFar = Number.isFinite(nudgeCount) ? nudgeCount : 0;

	// Replay guard. `finalize_attempt` is the finalize_nudge_count the reporting
	// spawn ran under (0 = first spawn, N = the spawn a resume #N granted). When
	// the stored count is already past it, this exact exit report was answered
	// with a resume the device never saw — its POST committed and the response
	// was lost. That is an ambiguous delivery outcome, not a fresh attempt, so
	// re-serve the same grant. Consuming another attempt here would fail the run
	// one spawn early, reinterpreting a lost response as work that happened.
	//
	// A device that omits the field (a build older than this endpoint's resume
	// contract) reads as "reporting the attempt the server has", i.e. the
	// pre-existing behavior — the field is what makes a retry safe, so the Mac
	// retry loop and this guard ship together.
	const reportedAttempt =
		typeof body.finalize_attempt === "number" &&
		Number.isFinite(body.finalize_attempt)
			? Math.max(0, Math.trunc(body.finalize_attempt))
			: attemptsSoFar;
	if (reportedAttempt < attemptsSoFar) {
		logger.info(
			{ run_id: runId, reported: reportedAttempt, granted: attemptsSoFar },
			"[completeBehaviorRun] replayed exit report — re-serving the granted resume"
		);
		return c.json({
			ok: true,
			status: "resume",
			reason_code: "missing_complete_window",
			attempt: attemptsSoFar,
			max_attempts: budget,
			nudge: MISSING_COMPLETE_WINDOW_NUDGE,
			error: MISSING_COMPLETE_WINDOW_NUDGE,
			idempotent: true,
		});
	}

	// attemptsSoFar is how many resumes already granted; next spawn is attempt+1.
	// Budget N means N extra spawns after the first (same as cloud).
	if (attemptsSoFar < budget) {
		const nextAttempt = attemptsSoFar + 1;
		const bumped = await bumpDeviceFinalizeNudge(
			sql,
			runId,
			nextAttempt,
			output ? output.slice(-2000) : null
		);
		if (!bumped) {
			const finalRows = (await sql`
        SELECT status FROM runs WHERE id = ${runId} LIMIT 1
      `) as unknown as Array<{ status: string }>;
			return c.json({
				ok: true,
				status: finalRows[0]?.status ?? "failed",
				idempotent: true,
			});
		}
		logger.info(
			{ run_id: runId, attempt: nextAttempt, max: budget },
			"[completeBehaviorRun] missing completeWindow — device resume"
		);
		return c.json({
			ok: true,
			status: "resume",
			reason_code: "missing_complete_window",
			attempt: nextAttempt,
			max_attempts: budget,
			// Total spawns allowed = first + budget resumes.
			// attempt is the resume index (1..budget); Mac should re-spawn now
			// and report back with finalize_attempt = attempt.
			nudge: MISSING_COMPLETE_WINDOW_NUDGE,
			error: MISSING_COMPLETE_WINDOW_NUDGE,
		});
	}

	const reason =
		"Device CLI exited without calling completeWindow " +
		(budget > 0 ? `after ${budget + 1} attempt(s)` : "(finalize nudges disabled)") +
		". Use the lobu skill + `lobu memory exec` (knowledge.read → completeWindow) " +
		"or MCP query_sdk/run_sdk. Check lobu CLI login/org, gateway reachability, " +
		"and that the device token has mcp:write if using MCP.";
	const transitioned = await failRun(reason);
	if (!transitioned) {
		const finalRows = (await sql`
      SELECT status FROM runs WHERE id = ${runId} LIMIT 1
    `) as unknown as Array<{ status: string }>;
		return c.json({
			ok: true,
			status: finalRows[0]?.status ?? "failed",
			idempotent: true,
		});
	}
	emitCompletionEvent("failed", reason);
	return c.json({
		ok: true,
		status: "failed",
		reason_code: "missing_complete_window",
		attempt: attemptsSoFar,
		max_attempts: budget,
		error: reason,
	});
}

/**
 * POST /api/workers/fetch-events
 *
 * Worker fetches event content for embedding generation.
 * Returns event IDs and payload_text for the given IDs.
 */
export async function fetchEventsForEmbedding(c: Context<{ Bindings: Env }>) {
	try {
		const { event_ids } = await c.req.json<{ event_ids: number[] }>();

		if (!event_ids || event_ids.length === 0) {
			return c.json({ events: [] });
		}

		const sql = getDb();

		// Build safe IN clause
		const safeIds = event_ids.filter((id) => Number.isInteger(id) && id > 0);
		if (safeIds.length === 0) {
			return c.json({ events: [] });
		}

		// Return events that need (re)embedding under the configured model. The
		// shared predicate (NOT EXISTS anti-joins on event_embeddings) is identical
		// to the backfill discovery rule and, being multi-vector aware, also catches
		// long events that only have a chunk-0 vector. A correlated anti-join (not a
		// LEFT JOIN) also avoids fanning out one row per chunk now that an event can
		// have many embedding rows.
		const placeholders = safeIds.map((_, i) => `$${i + 1}`).join(",");
		const rows = await sql.unsafe(
			`SELECT e.id, e.payload_text, e.title
       FROM events e
       WHERE e.id IN (${placeholders})
         AND ${needsEmbeddingSql("e")}`,
			safeIds
		);

		return c.json({
			events: rows.map((r) => ({
				id: Number(r.id),
				content: (r.payload_text as string) ?? "",
				title: (r.title as string) ?? null,
			})),
		});
	} catch (err: unknown) {
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/complete-embeddings
 *
 * Worker submits generated embeddings for a batch of events.
 * Used by embed_backfill runs.
 */
export async function completeEmbeddings(c: Context<{ Bindings: Env }>) {
	try {
		const req = await c.req.json<CompleteEmbeddingsRequest>();

		// Ownership gate — a worker can only finalize runs it claimed. Mirrors the
		// other /complete handlers; without it a leaked worker token could mark
		// arbitrary runs terminal.
		const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
		if (denied) return denied;

		const sql = getDb();

		if (!req.embeddings || req.embeddings.length === 0) {
			if (req.error_message) {
				// Guarded terminal transition (the status='running' AND claimed_by guard
				// inside finalizeRun won't resurrect a reaped run). Ownership is already
				// enforced by authorizeRunForWorker above.
				await finalizeRun(sql, {
					runId: req.run_id,
					workerId: req.worker_id,
					status: "failed",
					extraSet: sql`,
              error_message = ${req.error_message}`,
				});
				return c.json({ success: false, error: req.error_message }, 400);
			}
			// Empty batch means all events already had embeddings — mark completed
			// (best-effort; the guard makes it a no-op on an already-finalized run).
			await finalizeRun(sql, {
				runId: req.run_id,
				workerId: req.worker_id,
				status: "completed",
			});
			return c.json({ success: true, updated: 0 });
		}

		// Durability first, THEN finalize the run. Each (event, model)'s chunk set is
		// replaced in its OWN transaction (delete that model's rows, then insert):
		// per-(event, model) isolation so one bad write can't drop another's and so
		// old/new models can coexist during a zero-downtime swap. chunk_index
		// defaults to 0 for an older worker mid-deploy.
		const byEventModel = new Map<string, typeof req.embeddings>();
		for (const item of req.embeddings) {
			if (!item.embedding_model) continue; // unstamped vectors are unusable (search scopes by model)
			const key = `${item.event_id}\0${item.embedding_model}`;
			const group = byEventModel.get(key);
			if (group) group.push(item);
			else byEventModel.set(key, [item]);
		}
		let updated = 0;
		let failed = 0;
		for (const [, items] of byEventModel) {
			const eventId = items[0]!.event_id;
			const model = items[0]!.embedding_model!;
			try {
				await sql.begin(async (tx) => {
					await tx`DELETE FROM event_embeddings WHERE event_id = ${eventId} AND embedding_model = ${model}`;
					for (const item of items) {
						const vectorStr = `[${item.embedding.join(",")}]`;
						await tx.unsafe(
							`INSERT INTO event_embeddings (event_id, chunk_index, embedding, embedding_model)
               VALUES ($1, $2, $3::vector, $4)`,
							[eventId, item.chunk_index ?? 0, vectorStr, model]
						);
					}
				});
				updated++;
			} catch (err) {
				failed++;
				logger.error(
					{ event_id: eventId, model, error: err },
					"[completeEmbeddings] Failed to write embeddings for event (stays stale, will re-queue)"
				);
			}
		}

		// Finalize AFTER the writes, and only as completed if nothing failed — a
		// failed write must not be hidden behind a "completed" run; mark the run
		// failed so the events get re-queued and the failure is visible. Headless
		// backfills (run_id=-1) make finalizeRun a harmless no-op either way.
		await finalizeRun(sql, {
			runId: req.run_id,
			workerId: req.worker_id,
			status: failed > 0 ? "failed" : "completed",
			...(failed > 0
				? {
						extraSet: sql`,
              error_message = ${`${failed}/${byEventModel.size} event embedding writes failed`}`,
					}
				: {}),
		});

		await sql`
      UPDATE runs
      SET items_collected = ${updated}
      WHERE id = ${req.run_id}
        AND claimed_by = ${req.worker_id}
    `;

		logger.info(
			{ run_id: req.run_id, total: req.embeddings.length, updated, failed },
			"Embedding backfill completed"
		);

		return c.json({ success: failed === 0, updated, failed });
	} catch (err: unknown) {
		logger.error({ error: errorMessage(err) }, "[completeEmbeddings] Error");
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/emit-auth-artifact
 *
 * Worker streams an auth artifact (QR, redirect URL, prompt) into the run
 * checkpoint so the UI can render it.
 */
export async function emitAuthArtifact(c: Context<{ Bindings: Env }>) {
	try {
		const { run_id, artifact } = await c.req.json<EmitAuthArtifactRequest>();

		const sql = getDb();

		await sql`
      UPDATE runs
      SET checkpoint = ${sql.json({ artifact, emitted_at: new Date().toISOString() })},
          last_heartbeat_at = current_timestamp
      WHERE id = ${run_id}
    `;

		return c.json({ success: true });
	} catch (err: unknown) {
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/poll-auth-signal
 *
 * Worker polls for a pending signal on an auth run. The signal is consumed
 * (cleared from the run row) when delivered.
 */
export async function pollAuthSignal(c: Context<{ Bindings: Env }>) {
	try {
		const { run_id, signal_name } = await c.req.json<PollAuthSignalRequest>();

		const sql = getDb();

		const consumed = await sql.begin(async (tx) => {
			const rows = (await tx`
        SELECT auth_signal FROM runs
        WHERE id = ${run_id}
        FOR UPDATE
      `) as Array<{ auth_signal: Record<string, unknown> | null }>;

			const current = rows[0]?.auth_signal ?? null;
			if (!current) return null;
			if (current.name !== signal_name) return null;

			await tx`UPDATE runs SET auth_signal = NULL WHERE id = ${run_id}`;
			return current.payload ?? {};
		});

		return c.json(consumed ? { signal: consumed } : {});
	} catch (err: unknown) {
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/complete-auth
 *
 * Worker signals auth run completion. On success, credentials + metadata are
 * written to the linked auth_profiles row and the profile moves to 'active'.
 */
export async function completeAuthRun(c: Context<{ Bindings: Env }>) {
	try {
		const req = await c.req.json<CompleteAuthRequest>();

		// Ownership gate — a worker can only finalize runs it claimed. Mirrors the
		// other /complete handlers. Without it a leaked worker token could finalize
		// an arbitrary auth run and inject credentials into the linked auth_profiles
		// row. authorizeRunForWorker waves through token-auth (non-'user') mode, so
		// the claimant/status guard inside finalizeRun is what protects that path.
		const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
		if (denied) return denied;

		const sql = getDb();

		// Atomic terminal transition with the shared F2 guard (see finalizeRun), so
		// a late/reaped completion is a no-op rather than resurrecting the run and
		// double-applying the auth_profile/connection/feed side effects below. The
		// failed path also clears auth_signal and stamps exit diagnostics.
		const runRows = (await finalizeRun(sql, {
			runId: req.run_id,
			workerId: req.worker_id,
			status: req.status === "failed" ? "failed" : "completed",
			extraSet:
				req.status === "failed"
					? sql`,
          error_message = ${req.error_message ?? null},
          auth_signal = NULL,
          output_tail = ${req.output_tail ?? null},
          exit_code = ${req.exit_code ?? null},
          exit_signal = ${req.exit_signal ?? null},
          exit_reason = ${req.exit_reason ?? null}`
					: sql`,
          error_message = ${req.error_message ?? null},
          auth_signal = NULL`,
			returning: sql`auth_profile_id, organization_id`,
		})) as unknown as Array<{
			auth_profile_id: number | null;
			organization_id: string;
		}>;

		if (runRows.length === 0) {
			// Already finalized (timeout race) or not the claimant. Skip all
			// auth_profile/connection/feed side effects and ack idempotently.
			logger.info(
				{
					run_id: req.run_id,
					worker_id: req.worker_id,
					claimed_status: req.status,
				},
				"[completeAuthRun] no-op: run already in terminal state (likely gateway timeout)"
			);
			return c.json({ success: false, reason: "already_finalized" });
		}

		const authProfileId = runRows[0]?.auth_profile_id ?? null;
		const organizationId = runRows[0]?.organization_id;

		if (
			req.status === "success" &&
			authProfileId &&
			req.credentials &&
			organizationId
		) {
			// The profile kind decides whether the returned credentials are
			// secret-ref'd (bearer kinds) or written through as session state
			// (browser_session / interactive) — see reactivateProfileCascade.
			const authProfile = await getAuthProfileById(
				organizationId,
				authProfileId
			);
			await reactivateProfileCascade(
				sql,
				authProfileId,
				organizationId,
				authProfile?.profile_kind ?? null,
				{
					credentials: req.credentials,
					metadata: req.metadata ?? {},
				}
			);

			if (organizationId) {
				emit(organizationId, { keys: ["connections", "auth-profiles"] });
			}
		} else if (req.status === "failed" && authProfileId) {
			await sql`
        UPDATE auth_profiles
        SET status = 'error',
            updated_at = current_timestamp
        WHERE id = ${authProfileId}
      `;
		}

		logger.info(
			{ run_id: req.run_id, status: req.status },
			"Auth run completed"
		);
		return c.json({ success: true });
	} catch (err: unknown) {
		logger.error({ error: errorMessage(err) }, "[completeAuthRun] Error");
		return c.json({ error: errorMessage(err) }, 500);
	}
}

/**
 * POST /api/workers/complete-action
 *
 * Worker signals action run completion (for async high-risk actions).
 */
export async function completeActionRun(c: Context<{ Bindings: Env }>) {
	try {
		const req = await c.req.json<CompleteActionRequest>();

		// Same ownership check as the other /complete endpoints — a worker
		// can only finalize runs it claimed. Without this, a leaked worker
		// token could overwrite action_output on arbitrary runs.
		const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
		if (denied) return denied;

		const sql = getDb();

		// Atomic terminal-state transition with the shared F2 guard (see
		// finalizeRun), so a no-op (0 rows) means the row was already finalized by
		// another path (e.g. waitForDeviceActionRun timed out and marked it
		// 'timeout'). Without it a slow worker could overwrite a gateway-side
		// timeout decision with success — and the caller has already returned
		// timeout to its caller, so the action would double-finalize.
		const updatedRuns = await finalizeRun(sql, {
			runId: req.run_id,
			workerId: req.worker_id,
			status: req.status === "success" ? "completed" : "failed",
			extraSet: sql`,
          action_output = ${req.action_output ? sql.json(req.action_output) : null},
          error_message = ${req.error_message ?? null}`,
			returning: sql`organization_id, action_key`,
		});
		if (updatedRuns.length === 0) {
			// Either the run was already finalized (timeout race) or the
			// worker isn't the claimant. authorizeRunForWorker already gated
			// ownership, so this is almost always the timeout race; return
			// a clear status so the worker's logs are informative.
			logger.info(
				{
					run_id: req.run_id,
					worker_id: req.worker_id,
					claimed_status: req.status,
				},
				"[completeActionRun] no-op: run already in terminal state (likely gateway timeout)"
			);
			return c.json({ success: false, reason: "already_finalized" });
		}

		const organizationId = (updatedRuns[0] as any)?.organization_id;
		const actionKey = (updatedRuns[0] as any)?.action_key ?? "Action";

		if (organizationId) {
			const newStatus = req.status === "success" ? "completed" : "failed";
			await supersedeActionEvent(
				req.run_id,
				organizationId,
				newStatus,
				`${actionKey} — ${newStatus}`,
				req.status === "success"
					? `Action completed: ${actionKey}`
					: `Action failed: ${actionKey}${req.error_message ? ` — ${req.error_message}` : ""}`,
				req.status === "success"
					? { action_output: req.action_output }
					: { error_message: req.error_message }
			);

			emit(organizationId, { keys: ["contents-filtered", "notifications"] });
		}

		logger.info(
			{ run_id: req.run_id, status: req.status },
			"Action run completed"
		);
		return c.json({ success: true });
	} catch (err: unknown) {
		logger.error({ error: errorMessage(err) }, "[completeActionRun] Error");
		return c.json({ error: errorMessage(err) }, 500);
	}
}
