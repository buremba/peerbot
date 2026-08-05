/**
 * complete_window action handler for manage_behaviors.
 *
 * Validates token, writes window + content links, processes classifications,
 * marks run completed, advances schedule, and runs reaction script.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createDbClientFromEnv, getDb, parsePgNumberArray } from '../../../db/client';
import type { Env } from '../../../index';
import { ToolUserError } from '../../../utils/errors';
import { verifyWindowToken } from '../../../utils/jwt';
import logger from '../../../utils/logger';
import { promoteBehaviorEntityOutput } from '../../../utils/promote-keyed-entities';
import type { DeferredMutation } from '../../../authz/entity-mutation-gate';
import { ensureCanvasEntity, findCanvasHead } from '../../../utils/canvas-events';
import { insertEvent } from '../../../utils/insert-event';
import { isUniqueViolation } from '../../../utils/pg-errors';
import { persistBehaviorEventOutput } from '../../../utils/persist-behavior-event-output';
import { validateStableKeyComponents } from '../../../utils/stable-keys';
import { deriveWatcherExtractionSchema } from '../../../utils/watcher-extraction-schema';
import { trackWatcherReaction } from '../../../utils/watcher-reactions';
import {
  getFieldsToStrip,
  processWatcherClassifications,
  stripFields,
} from '../../../watchers/classifier-extraction';
import { advanceWatcherSchedule } from '../../../watchers/schedule-cursor';
import { executeReaction } from '../../../watchers/reaction-executor';
import { getNextNumericId } from '../helpers/db-helpers';
import type { Outputs } from '../../../types/watchers';
import type { ToolContext } from '../../registry';
import type { ManageBehaviorsArgs } from '../manage_behaviors';
import { normalizeExtractedData, parseJson, requireWatcherAccess } from './shared';
import { getErrorMessage } from '@lobu/core';

// Initialize AJV for JSON Schema validation
// removeAdditional: true strips fields like 'embedding' that workers add but aren't in the schema
// This allows workers to add internal fields while still validating the core schema
const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: true });
addFormats(ajv);

function validateEntityOutputKeys(
  extractedData: Record<string, unknown>,
  outputs: Outputs | null
): void {
  for (const [outputName, output] of Object.entries(outputs ?? {})) {
    if (!('entity' in output)) continue;
    const rows = extractedData[outputName];
    if (!Array.isArray(rows)) continue;
    for (const [index, row] of rows.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      try {
        validateStableKeyComponents(row as Record<string, unknown>, output.key);
      } catch (error) {
        throw new ToolUserError(
          `Invalid stable key in entity output '${outputName}' row ${index + 1}: ${getErrorMessage(error)}`,
          422
        );
      }
    }
  }
}

// ============================================
// handleCompleteWindow
// ============================================

export async function handleCompleteWindow(
  args: ManageBehaviorsArgs,
  env: Env,
  ctx: ToolContext
): Promise<{
  action: 'complete_window';
  behavior_id: string;
  window_id: number;
  window_start: string;
  window_end: string;
  content_linked: number;
  /** False on idempotent replays that reused an existing window. */
  window_created: boolean;
  /** True when replace_existing superseded the head — the canvas changed, so
   *  reactions fire and the schedule advances like a fresh completion. */
  head_superseded: boolean;
  /** Set only when the submitted payload was NOT stored because a head already
   *  existed and `replace_existing` was not requested — otherwise this response
   *  is indistinguishable from a successful write. Retry with
   *  `replace_existing: true` to overwrite deliberately.
   *
   *  Attribution is best-effort: `already_completed` means the payload was
   *  dropped but the writer could not be identified (events.client_id is FK'd
   *  to oauth_clients, so PAT/device callers store NULL, and a manual-open
   *  window may carry no run id). It is NOT a weaker form of the other two. */
  skipped_reason?:
    | 'replayed_own_completion'
    | 'completed_by_other_client'
    | 'already_completed';
  reaction_status: 'success' | 'failed' | 'skipped';
  reaction_error?: string;
}> {
  const sql = getDb();
  const provenanceClientId = args.client_id ?? ctx.clientId ?? null;
  const explicitProvenanceModel =
    typeof args.model === 'string' && args.model.trim() ? args.model : null;
  const provenanceMetadata: Record<string, unknown> =
    args.run_metadata && typeof args.run_metadata === 'object' && !Array.isArray(args.run_metadata)
      ? { ...(args.run_metadata as Record<string, unknown>) }
      : {};
  // Historical runs carry a server-stamped `prompt_rendered` in run_metadata
  // (the pre-literal-prompt templating era), and the run-thread view reads it
  // back. A completion payload must never introduce or replace that key.
  delete provenanceMetadata.prompt_rendered;
  // Public arg is `behavior_run_id`; the persisted provenance jsonb key stays
  // the internal `watcher_run_id` (run_metadata is not part of the API surface).
  const watcherRunIdRaw = args.behavior_run_id ?? provenanceMetadata.watcher_run_id;
  let watcherRunId =
    watcherRunIdRaw !== undefined &&
    watcherRunIdRaw !== null &&
    Number.isFinite(Number(watcherRunIdRaw))
      ? Number(watcherRunIdRaw)
      : null;

  // ============================================
  // STEP 1: Validate inputs (no DB calls)
  // ============================================
  const windowTokens =
    Array.isArray(args.window_tokens) && args.window_tokens.length > 0
      ? args.window_tokens
      : args.window_token
        ? [args.window_token]
        : [];
  if (windowTokens.length === 0) {
    throw new Error(
      'window_token or window_tokens is required for complete_window action. ' +
        'Get tokens from read_knowledge({ behavior_id: ... }) responses.'
    );
  }
  if (!args.extracted_data) {
    throw new Error(
      'extracted_data is required for complete_window action. ' +
        'This should contain the LLM analysis results (e.g., { sentiment: "positive", themes: [...] }).'
    );
  }
  const extractedData = normalizeExtractedData(args.extracted_data);

  // Verify and decode JWT window token(s) (in-memory)
  let tokenPayloads: Awaited<ReturnType<typeof verifyWindowToken>>[];

  try {
    tokenPayloads = await Promise.all(windowTokens.map((token) => verifyWindowToken(token, env)));
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    // Agent-recoverable validation (the message says how) — ToolUserError so
    // it returns 400 and stays out of the Sentry feed (was LOBU-BACKEND-D).
    throw new ToolUserError(
      `Invalid window_token: ${errorMsg}. ` +
        'The token may have expired or been tampered with. ' +
        'Get a fresh token from read_knowledge({ behavior_id: ... }).'
    );
  }

  const firstToken = tokenPayloads[0];
  const { watcher_id: watcherId, window_start, window_end, granularity } = firstToken;

  for (const token of tokenPayloads) {
    if (
      token.watcher_id !== watcherId ||
      token.window_start !== window_start ||
      token.window_end !== window_end ||
      token.granularity !== granularity
    ) {
      throw new Error('All window_tokens must belong to the same Behavior window.');
    }
  }

  const pgSql = createDbClientFromEnv(env);
  await requireWatcherAccess(pgSql, [String(watcherId)], ctx, 'write');

  if (watcherRunId == null) {
    // Prefer an active (dispatched) run; otherwise a pending manual-open run
    // (no agent/device pin) waiting for an external completer.
    const runRows = await sql`
      SELECT id
      FROM runs
      WHERE watcher_id = ${watcherId}
        AND run_type = 'behavior'
        AND (
          status = 'running'
          OR (
            status = 'pending'
            AND (approved_input->>'agent_id' IS NULL OR approved_input->>'agent_id' = '')
            AND (approved_input->>'device_worker_id' IS NULL OR approved_input->>'device_worker_id' = '')
          )
        )
      ORDER BY
        CASE WHEN status = 'running' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
    `;
    if (runRows.length > 0 && runRows[0].id != null) {
      watcherRunId = Number(runRows[0].id);
      provenanceMetadata.watcher_run_id = watcherRunId;
    }
  } else if (provenanceMetadata.watcher_run_id == null) {
    provenanceMetadata.watcher_run_id = watcherRunId;
  }

  // Manual-open runs (no agent, no device pin) pend for any connected MCP
  // client — there is no claim step, so the completing client transitions the
  // run pending->running here. Best-effort and race-safe: concurrent completers
  // both see an active run, and the completion transition below is idempotent.
  // Addressed runs (agent dispatch / device lane) never match this filter, so
  // an external client cannot hijack a dispatched run.
  if (watcherRunId != null && Number.isFinite(watcherRunId)) {
    await sql`
      UPDATE runs
      SET status = 'running',
          claimed_at = COALESCE(claimed_at, current_timestamp)
      WHERE id = ${watcherRunId}
        AND watcher_id = ${watcherId}
        AND run_type = 'behavior'
        AND status = 'pending'
        AND (approved_input->>'agent_id' IS NULL OR approved_input->>'agent_id' = '')
        AND (approved_input->>'device_worker_id' IS NULL OR approved_input->>'device_worker_id' = '')
    `;
  }

  // ============================================
  // STEP 2: Combined query - watcher + classifiers + template schema
  // ============================================
  // Resolve the version this run was started against. The agent extracted
  // data using that version's prompt/schema; we MUST validate against the
  // same version even if the group has been edited mid-run.
  //
  // Resolution order:
  //   1. explicit args.template_version_id (the agent passes this back)
  //   2. runs.approved_input.version_id (snapshotted at run-creation)
  //   3. watchers.current_version_id (fallback for callers outside a run)
  //
  // The run lookup is scoped by watcher_id so a wrong/stale watcher_run_id
  // can't read another watcher's snapshot.
  let snapshotVersionId: number | null =
    typeof args.template_version_id === 'number' ? args.template_version_id : null;
  if (snapshotVersionId == null && watcherRunId != null) {
    const runRows = await sql`
      SELECT (approved_input->>'version_id')::bigint AS version_id
      FROM runs
      WHERE id = ${watcherRunId} AND watcher_id = ${watcherId}
      LIMIT 1
    `;
    if (runRows.length > 0 && runRows[0].version_id != null) {
      snapshotVersionId = Number(runRows[0].version_id);
    }
  }

  // The version row must belong to this watcher's group — prevents pinning
  // to another group's version via a forged template_version_id arg.
  const watcherRows = await sql`
    SELECT
      i.id,
      i.schedule,
      i.entity_ids,
      i.organization_id,
      i.created_by,
      wv.id as version_id,
      wv.outputs
    FROM watchers i
    LEFT JOIN watcher_versions wv
      ON wv.id = COALESCE(${snapshotVersionId}::bigint, i.current_version_id)
     AND wv.watcher_id = i.watcher_group_id
    WHERE i.id = ${watcherId}
    LIMIT 1
  `;

  if (watcherRows.length === 0) {
    throw new Error(
      `Behavior ${watcherId} not found. ` +
        'It may have been deleted. Use client.behaviors.list() via query_sdk to see available Behaviors.'
    );
  }

  // Fetch classifiers separately
  const classifierRows = await sql`
    SELECT
      cc.id,
      cc.slug,
      cc.id as version_id,
      cc.extraction_config
    FROM classify_facet cc
    WHERE cc.watcher_id = ${watcherId}
      AND cc.status = 'active'
      AND cc.extraction_config IS NOT NULL
  `;

  const timeGranularity = granularity || 'weekly';
  const classifiers = classifierRows.map((r) => ({
    id: r.id as number,
    slug: r.slug as string,
    version_id: r.version_id as number,
    extraction_config: r.extraction_config as any,
  }));

  const resolvedVersionId =
    watcherRows[0].version_id != null ? Number(watcherRows[0].version_id) : null;
  const outputs = parseJson(watcherRows[0].outputs) as Outputs | null;

  // The org + bound parent entity the promoted child entities hang under. The
  // watcher's first bound entity is the parent; unbound watchers promote at the
  // root (parent_id NULL). `entities.created_by` is NOT NULL with an
  // ON DELETE RESTRICT FK to user(id); the watcher's own `created_by` is a
  // guaranteed-live user (same FK), so it's the correct attribution.
  const watcherOrgId = watcherRows[0].organization_id as string;
  const watcherCreatedBy = (watcherRows[0].created_by as string | null) ?? null;
  // entity_ids is bigint[]; the prod pool runs fetch_types:false, so postgres.js
  // hands it back as the literal string "{4}" (NOT a JS array) — parse it.
  const boundEntityIds = parsePgNumberArray(watcherRows[0].entity_ids);
  const parentEntityId = boundEntityIds.length > 0 ? boundEntityIds[0] : null;

  // ============================================
  // STEP 2.5: Validate extracted_data against the extraction schema.
  // The schema is composed from declared outputs and the optional reaction
  // input. Entity schemas still live on their entity types; event outputs use
  // the standard event draft. The worker and completion share this helper.
  // ============================================
  const extractionSchema: Record<string, any> | null = await deriveWatcherExtractionSchema(
    getDb(),
    watcherOrgId,
    outputs,
    watcherId
  );
  if (extractionSchema) {
    const validate = ajv.compile(extractionSchema);
    // Validate a deep copy since removeAdditional:true mutates the data
    // This allows workers to include internal fields like 'embedding' that aren't in the schema
    const dataCopy = structuredClone(extractedData);
    const isValid = validate(dataCopy);

    if (!isValid) {
      const errors = validate.errors || [];
      const errorMessages = errors.map((e) => {
        const path = e.instancePath || '(root)';
        return `  - ${path}: ${e.message}`;
      });

      throw new Error(
        `extracted_data does not match the Behavior\'s extraction contract (derived from its entity type or reaction \`input\` schema).\n\n` +
          `Validation errors:\n${errorMessages.join('\n')}\n\n` +
          'Expected schema requires:\n' +
          `  - Required fields: ${JSON.stringify(extractionSchema.required || [])}\n` +
          `  - Top-level properties: ${Object.keys(extractionSchema.properties || {}).join(', ')}\n\n` +
          `Received top-level keys: ${Object.keys(extractedData).join(', ')}\n\n` +
          'Please ensure your LLM output matches the template schema exactly.'
      );
    }

    logger.info('[complete_window] extracted_data validated against template schema successfully');
  }

  // JSON Schema maxLength counts characters, while durable stable-key storage
  // is bounded in UTF-8 bytes and also rejects blank strings. Enforce the exact
  // encoder contract before opening the completion transaction or writing the
  // Canvas so invalid model output is an actionable 422, not a mid-write error.
  validateEntityOutputKeys(extractedData, outputs);

  // ============================================
  // STEP 3: Resolve the exact content IDs analyzed by the worker
  // ============================================
  const perTokenIds = tokenPayloads.map((token) => {
    if (!Array.isArray(token.content_ids)) {
      throw new ToolUserError(
        'Invalid window_token: content_ids is required. Get a fresh token from read_knowledge({ behavior_id: ... }).'
      );
    }
    const ids = [
      ...new Set(
        token.content_ids
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
          .map((id) => Math.trunc(id))
      ),
    ];
    if (ids.length !== token.content_count) {
      throw new ToolUserError(
        `Invalid window_token: content_ids has ${ids.length} IDs, but content_count is ${token.content_count}. ` +
          'Get a fresh token from read_knowledge({ behavior_id: ... }).'
      );
    }
    return ids;
  });

  const batchContentIds = [...new Set(perTokenIds.flat())];
  const summedContentCount = perTokenIds.reduce((sum, ids) => sum + ids.length, 0);
  if (batchContentIds.length !== summedContentCount) {
    throw new Error(
      'window_tokens contain overlapping content IDs. Pass each read_knowledge page token once.'
    );
  }

  const oldestTokenIssuedAt = Math.min(...tokenPayloads.map((token) => token.iat));
  const tokenAge = Math.floor(Date.now() / 1000) - oldestTokenIssuedAt;
  logger.info(
    `[complete_window] Token valid: ${batchContentIds.length} content items across ${tokenPayloads.length} page(s), oldest token age: ${tokenAge}s`
  );

  // ============================================
  // STEP 4: Process extracted_data BEFORE any writes (in-memory)
  // ============================================
  const fieldsToStrip = getFieldsToStrip(classifiers);
  const cleanedExtractedData = stripFields(extractedData, Array.from(fieldsToStrip));

  // ============================================
  // STEP 6: Wrap all DB operations in a transaction
  // If classification processing fails (e.g., embeddings service unavailable),
  // the entire operation rolls back - no corrupted data is saved.
  //
  // Transaction for data writes.
  // ============================================
  // Owned-field changes and policy-held creates a watcher proposed but couldn't
  // apply; surfaced out of the transaction as deferred approvals and flushed once
  // the window commits.
  let deferredApprovals: DeferredMutation[] = [];
  const result = await sql.begin(async (tx) => {
    // ============================================
    // STEP 7: Canvas-on-events write — THE window storage.
    //
    // A watcher "window" (canvas) is a supersede chain of
    // `semantic_type='canvas_state'` events; the chain ROOT
    // (supersedes_event_id IS NULL) is the window identity and its event id is
    // the `windowId` returned by complete_window. A fresh completion inserts a
    // root; `replace_existing` supersedes the current head instead of creating
    // a second root — so the root id NEVER changes. Concurrent root inserts
    // race on the partial unique index idx_canvas_chain_root → 23505 → 409;
    // concurrent supersedes race on idx_events_superseded_by → 23505 → 409.
    //
    // Any other same-period completion is an idempotent no-op that returns the
    // existing root — the agent loop can retry a period forever without
    // duplicating a root or overwriting a successful head (LOBU-Q); a genuine
    // re-analysis states replace_existing explicitly.
    // ============================================
    let windowId!: number;
    let canvasRevisionId!: number;
    let windowCreated = false;
    let headSuperseded = false;
    let skippedReason:
      | 'replayed_own_completion'
      | 'completed_by_other_client'
      | 'already_completed'
      | undefined;
    const canvasEntityId = await ensureCanvasEntity({
      tx,
      watcherId: Number(watcherId),
      organizationId: watcherOrgId,
      parentEntityId,
      createdBy: watcherCreatedBy,
    });
    const canvasEntityIds = canvasEntityId != null ? [canvasEntityId] : [];
    // events.client_id has an FK to oauth_clients — but callers pass PAT/device
    // ids verbatim (the legacy column had no FK, so they were accepted). Inside
    // this transaction insertEvent's client-id-FK retry cannot engage (the
    // first failed INSERT aborts the tx), so resolve validity up front and
    // drop unknown ids to NULL rather than aborting the whole completion.
    let canvasClientId: string | null = provenanceClientId;
    if (canvasClientId) {
      const knownClient = await tx`
        SELECT 1 FROM oauth_clients WHERE id = ${canvasClientId} LIMIT 1
      `;
      if (knownClient.length === 0) canvasClientId = null;
    }
    const canvasPeriodMeta = {
      watcher_id: Number(watcherId),
      granularity: timeGranularity,
      window_start,
      window_end,
      content_analyzed: batchContentIds.length,
      version_id: resolvedVersionId,
    };

    const existingHead = await findCanvasHead(tx, {
      watcherId: Number(watcherId),
      granularity: timeGranularity,
      windowStart: window_start,
    });

    if (existingHead && !args.replace_existing) {
      // Idempotent replay / concurrent completion that already produced a head:
      // never create a second root and never overwrite a successful head. The
      // window identity is the existing chain root.
      windowId = existingHead.rootEventId;
      canvasRevisionId = existingHead.id;
      // The caller's payload is DISCARDED here. Replaying your own completion
      // and losing a race to another MCP client are indistinguishable from the
      // outside — both just return the existing window — so a client that did
      // real work has no way to know its output was dropped. Name which case
      // this was so it can be logged or retried with replace_existing.
      // Manual-open Behaviors (no agent, no device pin) are the shape where a
      // second client can legitimately show up: the run pends for whoever
      // claims it first.
      // Attribution is best-effort and often UNAVAILABLE: events.client_id has
      // an FK to oauth_clients, so `canvasClientId` above nulls out for PAT and
      // device callers, and a manual-open window may carry no run id. Only
      // claim a verdict backed by two present ids that actually match or
      // differ — otherwise say plainly that the payload was dropped without
      // guessing who wrote the head. Guessing 'other client' on absent ids
      // would fire on every ordinary replay.
      // Client identity OUTRANKS run identity, and the order matters. A
      // manual-open Behavior has ONE pending run that every client races for,
      // so two different clients completing it both carry the same run id.
      // Ranking the run first would report the loser as a self-replay in
      // precisely the scenario this signal exists for. The run is only a
      // fallback for callers with no registered client id.
      const bothClients =
        existingHead.clientId != null && provenanceClientId != null;
      const bothRuns = existingHead.runId != null && watcherRunId != null;
      if (bothClients) {
        skippedReason =
          existingHead.clientId === provenanceClientId
            ? 'replayed_own_completion'
            : 'completed_by_other_client';
      } else if (bothRuns) {
        skippedReason =
          existingHead.runId === watcherRunId
            ? 'replayed_own_completion'
            : 'completed_by_other_client';
      } else {
        skippedReason = 'already_completed';
      }
    } else if (existingHead && args.replace_existing) {
      // Supersede the current head, copying the root's period metadata. Loser of
      // a concurrent supersede hits idx_events_superseded_by → 23505 → 409. The
      // root id (window identity) never changes across a supersede.
      windowId = existingHead.rootEventId;
      try {
        const replacement = await insertEvent(
          {
            entityIds: canvasEntityIds,
            organizationId: watcherOrgId,
            originId: `canvas_${crypto.randomUUID()}`,
            payloadType: 'json_template',
            payloadData: cleanedExtractedData,
            semanticType: 'canvas_state',
            metadata: {
              ...canvasPeriodMeta,
              root_event_id: existingHead.rootEventId,
            },
            runId: watcherRunId,
            occurredAt: window_end,
            createdBy: watcherCreatedBy,
            clientId: canvasClientId,
            supersedesEventId: existingHead.id,
          },
          { sql: tx }
        );
        canvasRevisionId = Number(replacement.id);
      } catch (err) {
        if (isUniqueViolation(err, 'idx_events_superseded_by')) {
          throw new ToolUserError(
            `Canvas for Behavior ${watcherId} period ${window_start} was concurrently updated. Retry with the latest state.`,
            409
          );
        }
        throw err;
      }
      headSuperseded = true;
      if (args.replace_existing) {
        // An explicit replace states "this analysis covers THIS content set":
        // clear the previous completion's links so STEP 8 re-links exactly the
        // new batch.
        await tx`DELETE FROM watcher_window_events WHERE window_id = ${windowId}`;
      }
    } else {
      // No chain yet → insert the ROOT. A root omits metadata.root_event_id (its
      // id isn't known until after insert, and metadata is immutable); readers
      // treat a missing root_event_id as "self", so the root id IS the window id.
      // Superseders above stamp root_event_id explicitly for zero-traversal reads.
      try {
        const rootEvent = await insertEvent(
          {
            entityIds: canvasEntityIds,
            organizationId: watcherOrgId,
            originId: `canvas_${crypto.randomUUID()}`,
            payloadType: 'json_template',
            payloadData: cleanedExtractedData,
            semanticType: 'canvas_state',
            metadata: canvasPeriodMeta,
            runId: watcherRunId,
            occurredAt: window_end,
            createdBy: watcherCreatedBy,
            clientId: canvasClientId,
          },
          { sql: tx }
        );
        windowId = Number(rootEvent.id);
        canvasRevisionId = windowId;
        windowCreated = true;
        logger.info(
          `[complete_window] Created canvas window ${windowId} for watcher ${watcherId} (${window_start} - ${window_end})`
        );
      } catch (err) {
        if (isUniqueViolation(err, 'idx_canvas_chain_root')) {
          throw new ToolUserError(
            `Window already exists for Behavior ${watcherId} for period ${window_start} to ${window_end}. ` +
              'Use replace_existing: true to replace it, or query a different time period.',
            409
          );
        }
        throw err;
      }
    }

    // ============================================
    // STEP 8: Link content to window (bulk INSERT)
    // Build VALUES clause for bulk insert
    // ============================================
    if (batchContentIds.length > 0) {
      let nextWindowEventId = await getNextNumericId(tx, 'watcher_window_events');
      const valuePlaceholders: string[] = [];
      const insertParams: unknown[] = [];
      let pIdx = 1;
      for (const contentId of batchContentIds) {
        valuePlaceholders.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, NOW())`);
        insertParams.push(nextWindowEventId, windowId, contentId, Number(watcherId));
        nextWindowEventId += 1;
        pIdx += 4;
      }

      await tx.unsafe(
        `INSERT INTO watcher_window_events (id, window_id, event_id, watcher_id, created_at)
         VALUES ${valuePlaceholders.join(', ')}
         ON CONFLICT DO NOTHING`,
        insertParams
      );
    }

    // The content this window_token actually granted. Both promotion (8.5) and
    // classification (9) validate agent-supplied content references against it,
    // so it is defined once here rather than per-consumer.
    const validContentIds = new Set(batchContentIds);

    // ============================================
    // STEP 8.5: Persist declared entity and event outputs atomically with Canvas.
    // ============================================
    const entityChanges = [] as Array<{
      entityId: number;
      name: string;
      kind: 'created' | 'updated';
      applied: Record<string, unknown>;
    }>;
    for (const [outputName, output] of Object.entries(outputs ?? {})) {
      if ('entity' in output) {
        const promote = await promoteBehaviorEntityOutput({
          tx,
          extractedData,
          outputName,
          output,
          watcherId: Number(watcherId),
          organizationId: watcherOrgId,
          windowId,
          parentEntityId,
          createdBy: watcherCreatedBy,
          validContentIds,
        });
        deferredApprovals.push(...promote.deferred);
        entityChanges.push(...promote.changes);
      } else {
        await persistBehaviorEventOutput({
          tx,
          rows: extractedData[outputName],
          outputName,
          output,
          watcherId: Number(watcherId),
          organizationId: watcherOrgId,
          windowId,
          canvasRevisionId,
          runId: watcherRunId,
          boundEntityIds,
          validContentIds,
          occurredAt: window_end,
          createdBy: watcherCreatedBy,
        });
      }
    }

    // One run-level change set covers every entity output.
    if (entityChanges.length > 0 && watcherRunId && Number.isFinite(watcherRunId)) {
      const createdCount = entityChanges.filter((c) => c.kind === 'created').length;
      const updatedCount = entityChanges.length - createdCount;
      const changeSetIdempotencyKey = `behavior:${watcherId}:run:${watcherRunId}:change_set`;
      const findChangeSet = () => tx<{ id: number }>`
        SELECT id FROM events
        WHERE organization_id = ${watcherOrgId}
          AND metadata->>'_lobu_idempotency_key' = ${changeSetIdempotencyKey}
        LIMIT 1
      `;
      if ((await findChangeSet()).length === 0) {
        try {
          await tx.savepoint((sp) =>
            insertEvent(
              {
                entityIds: entityChanges.map((c) => c.entityId),
                organizationId: watcherOrgId,
                originId: `run_${watcherRunId}_changeset`,
                title: `Behavior applied ${createdCount} new + ${updatedCount} updated`,
                content: `This run created ${createdCount} and updated ${updatedCount} entities.`,
                semanticType: 'change_set',
                runId: watcherRunId,
                metadata: {
                  _lobu_idempotency_key: changeSetIdempotencyKey,
                  kind: 'watcher_change_set',
                  window_id: windowId,
                  watcher_id: Number(watcherId),
                  created_count: createdCount,
                  updated_count: updatedCount,
                  changes: entityChanges,
                },
                createdBy: watcherCreatedBy,
              },
              { sql: sp }
            )
          );
        } catch (error) {
          if (!isUniqueViolation(error, 'idx_events_org_idempotency_key')) throw error;
          // The failed INSERT was savepoint-isolated, so the outer completion
          // transaction is still usable. Confirm the concurrent winner before
          // treating this replay as complete.
          if ((await findChangeSet()).length === 0) throw error;
        }
      }
    }

    // ============================================
    // STEP 9: Process classifications
    // If this fails (e.g., embeddings service down), the transaction rolls back
    // ============================================
    await processWatcherClassifications(
      tx,
      watcherId,
      windowId,
      extractedData,
      classifiers,
      validContentIds,
      env
    );

    let runMarkedCompleted = false;
    let completedDispatchSource: string | null = null;
    if (watcherRunId && Number.isFinite(watcherRunId)) {
      // Provenance now lives on the RUN row (model_used, run_metadata), not on
      // the retired watcher_windows table. window_id is stamped to the canvas
      // ROOT event id. Scope by watcher_id so a wrong/stale watcher_run_id
      // (passed in run_metadata) cannot mark another watcher's run completed
      // against this watcher's window. Stamp provenance whenever the run is
      // still terminable so an idempotent replay refreshing a running run still
      // records model/metadata.
      const completedRows = await tx`
        UPDATE runs
        SET status = 'completed',
            window_id = ${windowId},
            model_used = COALESCE(
              ${explicitProvenanceModel},
              NULLIF(model_used, 'external-client'),
              CASE
                WHEN dispatched_message_id IS NOT NULL THEN 'lobu-agent'
                ELSE 'external-client'
              END
            ),
            run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${sql.json(provenanceMetadata)},
            completed_at = current_timestamp,
            error_message = NULL
        WHERE id = ${watcherRunId}
          AND watcher_id = ${watcherId}
          AND run_type = 'behavior'
          AND status IN ('running', 'claimed')
        RETURNING id, approved_input->>'dispatch_source' AS dispatch_source
      `;
      runMarkedCompleted = completedRows.length > 0;
      completedDispatchSource =
        typeof completedRows[0]?.dispatch_source === 'string'
          ? completedRows[0].dispatch_source
          : null;
      if (!runMarkedCompleted) {
        // Idempotent replay against an already-completed run: keep window_id and
        // provenance current without re-transitioning status or side effects.
        await tx`
          UPDATE runs
          SET window_id = ${windowId},
              model_used = COALESCE(
                ${explicitProvenanceModel},
                NULLIF(model_used, 'external-client'),
                CASE
                  WHEN dispatched_message_id IS NOT NULL THEN 'lobu-agent'
                  ELSE 'external-client'
                END
              ),
              run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${sql.json(provenanceMetadata)}
          WHERE id = ${watcherRunId}
            AND watcher_id = ${watcherId}
            AND run_type = 'behavior'
        `;
      }
    }

    // Advance the schedule only when we actually did new work. Idempotent
    // replays (no window created, no run transitioned) must not push
    // next_run_at forward, or each retry would shift the schedule.
    if (
      (windowCreated || headSuperseded || runMarkedCompleted) &&
      completedDispatchSource !== 'event'
    ) {
      await advanceWatcherSchedule(tx, watcherId);
    }

    logger.info(
      `[manage_behaviors] Completed window ${windowId} for watcher ${watcherId} ` +
        `(${window_start} - ${window_end}), linked ${batchContentIds.length} content items`
    );

    return {
      action: 'complete_window' as const,
      behavior_id: String(watcherId),
      window_id: windowId,
      window_start,
      window_end,
      content_linked: batchContentIds.length,
      window_created: windowCreated,
      head_superseded: headSuperseded,
      ...(skippedReason ? { skipped_reason: skippedReason } : {}),
    };
  });

  // Post-commit: flush any deferred approvals (owned-field changes + policy-held
  // creates) the watcher couldn't apply inline. Done after the window transaction
  // so the durable approval (run + event + notify) is never rolled back with the
  // window, and a failure here never undoes the committed sync. Best-effort each.
  for (const d of deferredApprovals) {
    await d
      .queue(ctx, env)
      .catch((err) =>
        logger.error(
          { err, watcherId, action: d.display.action },
          '[complete-window] failed to queue deferred entity approval'
        )
      );
  }

  // Execute the reaction script inline in the isolated reaction sandbox.
  // Fire on linked content OR on a freshly created window: device-run and
  // other self-sourcing watchers link no server-side content — their signal
  // is the extracted_data itself, and the reaction script decides what to do
  // with it. Idempotent replays (no new window, nothing linked) still skip,
  // so a retried completion can't double-fire a reaction.
  let reactionStatus: 'success' | 'failed' | 'skipped' = 'skipped';
  let reactionError: string | undefined;

  // Fetch watcher metadata once — used for both reaction script and auto-notify
  const watcherMetaSql = getDb();
  const watcherMetaRows = await watcherMetaSql`
    SELECT w.reaction_script_compiled, w.entity_ids,
           w.organization_id, w.current_version_id,
           w.name, o.slug AS organization_slug,
           wv.version as watcher_version
    FROM watchers w
    JOIN organization o ON o.id = w.organization_id
    LEFT JOIN watcher_versions wv ON w.current_version_id = wv.id
    WHERE w.id = ${result.behavior_id}
  `;

  try {
    const sql = watcherMetaSql;
    const scriptRows = watcherMetaRows;
    if (
      (result.content_linked > 0 || result.window_created || result.head_superseded) &&
      scriptRows.length > 0 &&
      scriptRows[0].reaction_script_compiled
    ) {
      const row = scriptRows[0];
      const orgId = row.organization_id as string;

      // Fetch all entities
      const eIds = Array.isArray(row.entity_ids) ? row.entity_ids.map(Number) : [];
      const entityRows =
        eIds.length > 0
          ? await sql`
              SELECT e.id, e.name, et.slug AS entity_type, e.metadata
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.id = ANY(${`{${eIds.join(',')}}`}::bigint[])
            `
          : [];

      // Fetch watcher name from version, slug from template (pre-consolidation)
      const watcherMeta = await sql`
        SELECT w.id, COALESCE(wv.name, 'watcher-' || w.id) as name,
               COALESCE(w.slug, 'watcher-' || w.id) as slug
        FROM watchers w
        LEFT JOIN watcher_versions wv ON w.current_version_id = wv.id
        WHERE w.id = ${result.behavior_id}
      `;

      const reactionContext = {
        extracted_data: cleanedExtractedData,
        entities: entityRows.map((e: any) => ({
          id: Number(e.id),
          name: e.name as string,
          entity_type: e.entity_type as string,
          metadata: (e.metadata ?? {}) as Record<string, unknown>,
        })),
        window: {
          id: result.window_id,
          run_id: watcherRunId,
          behavior_id: Number(result.behavior_id),
          window_start: result.window_start,
          window_end: result.window_end,
          granularity: timeGranularity,
          content_analyzed: batchContentIds.length,
        },
        behavior: {
          id: Number(result.behavior_id),
          slug: (watcherMeta[0]?.slug ?? `watcher-${result.behavior_id}`) as string,
          name: (watcherMeta[0]?.name ?? `watcher-${result.behavior_id}`) as string,
          version: Number(row.watcher_version ?? 1),
        },
        organization_id: orgId,
        organization_slug: String(row.organization_slug),
      };

      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const execResult = await executeReaction({
          compiledScript: row.reaction_script_compiled as string,
          context: reactionContext,
          env: env as Record<string, string | undefined>,
        });

        await trackWatcherReaction({
          organizationId: orgId,
          watcherId: Number(result.behavior_id),
          windowId: result.window_id,
          reactionType: 'script_execution',
          toolName: 'reaction_executor',
          toolArgs: { attempt },
          toolResult: { success: execResult.success, error: execResult.error },
        });

        if (execResult.success) {
          reactionStatus = 'success';
          logger.info(
            {
              watcher_id: result.behavior_id,
              window_id: result.window_id,
              attempt,
            },
            'Reaction script executed successfully (inline)'
          );
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(
            { watcher_id: result.behavior_id, attempt, error: execResult.error },
            'Reaction script failed, retrying...'
          );
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          reactionStatus = 'failed';
          reactionError = execResult.error;
          logger.error(
            { watcher_id: result.behavior_id, error: execResult.error },
            'Reaction script failed after all retries'
          );
        }
      }
    }
  } catch (err) {
    reactionStatus = 'failed';
    reactionError = getErrorMessage(err);
    logger.warn({ err }, '[manage_behaviors] Failed to execute reaction script');
  }

  return {
    ...result,
    reaction_status: reactionStatus,
    reaction_error: reactionError,
  };
}
