/**
 * complete_window action handler for manage_watchers.
 *
 * Validates token, writes window + content links, processes classifications,
 * marks run completed, advances schedule, and runs reaction script.
 */

import Ajv from 'ajv';
import { createDbClientFromEnv, getDb, pgBigintArray } from '../../../db/client';
import type { Env } from '../../../index';
import { ToolUserError } from '../../../utils/errors';
import { verifyWindowToken } from '../../../utils/jwt';
import logger from '../../../utils/logger';
import { computeStableKeys } from '../../../utils/stable-keys';
import { trackWatcherReaction } from '../../../utils/watcher-reactions';
import {
  getFieldsToStrip,
  processWatcherClassifications,
  stripFields,
} from '../../../watchers/classifier-extraction';
import { advanceWatcherSchedule } from '../../../watchers/automation';
import { executeReaction } from '../../../watchers/reaction-executor';
import { getNextNumericId } from '../helpers/db-helpers';
import type { ToolContext } from '../../registry';
import type { ManageWatchersArgs } from '../manage_watchers';
import { normalizeExtractedData, parseJson, requireWatcherAccess } from './shared';
import { getErrorMessage } from "@lobu/core";

// Initialize AJV for JSON Schema validation
// removeAdditional: true strips fields like 'embedding' that workers add but aren't in the schema
// This allows workers to add internal fields while still validating the core schema
const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: true });

// ============================================
// handleCompleteWindow
// ============================================

export async function handleCompleteWindow(
  args: ManageWatchersArgs,
  env: Env,
  ctx: ToolContext
): Promise<{
  action: 'complete_window';
  watcher_id: string;
  window_id: number;
  window_start: string;
  window_end: string;
  content_linked: number;
  /** False on idempotent replays that reused an existing window. */
  window_created: boolean;
  is_rollup?: boolean;
  depth?: number;
  source_window_ids?: number[];
  reaction_status: 'success' | 'failed' | 'skipped';
  reaction_error?: string;
}> {
  const sql = getDb();
  const provenanceClientId = args.client_id ?? ctx.clientId ?? null;
  const provenanceModel =
    typeof args.model === 'string' && args.model.trim() ? args.model : 'external-client';
  const provenanceMetadata: Record<string, unknown> =
    args.run_metadata && typeof args.run_metadata === 'object' && !Array.isArray(args.run_metadata)
      ? (args.run_metadata as Record<string, unknown>)
      : {};
  const watcherRunIdRaw = args.watcher_run_id ?? provenanceMetadata.watcher_run_id;
  let watcherRunId =
    watcherRunIdRaw !== undefined && watcherRunIdRaw !== null && Number.isFinite(Number(watcherRunIdRaw))
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
        'Get tokens from read_knowledge({ watcher_id: ... }) responses.'
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
  type VerifiedWindowToken = Awaited<ReturnType<typeof verifyWindowToken>> & {
    is_rollup?: boolean;
    source_window_ids?: number[];
    depth?: number;
  };
  let tokenPayloads: VerifiedWindowToken[];

  try {
    tokenPayloads = (await Promise.all(
      windowTokens.map((token) => verifyWindowToken(token, env))
    )) as VerifiedWindowToken[];
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    // Agent-recoverable validation (the message says how) — ToolUserError so
    // it returns 400 and stays out of the Sentry feed (was LOBU-BACKEND-D).
    throw new ToolUserError(
      `Invalid window_token: ${errorMsg}. ` +
        'The token may have expired or been tampered with. ' +
        'Get a fresh token from read_knowledge({ watcher_id: ... }).'
    );
  }

  const firstToken = tokenPayloads[0];
  const {
    watcher_id: watcherId,
    window_start,
    window_end,
    granularity,
    window_id: tokenWindowId,
    is_rollup: tokenIsRollup,
    source_window_ids: tokenSourceWindowIds,
    depth: tokenDepth,
  } = firstToken;

  for (const token of tokenPayloads) {
    if (
      token.watcher_id !== watcherId ||
      token.window_start !== window_start ||
      token.window_end !== window_end ||
      token.granularity !== granularity ||
      token.window_id !== tokenWindowId
    ) {
      throw new Error('All window_tokens must belong to the same watcher window.');
    }
  }

  if (tokenPayloads.length > 1 && tokenIsRollup) {
    throw new Error('Rollup completion accepts exactly one window_token.');
  }

  const pgSql = createDbClientFromEnv(env);
  await requireWatcherAccess(pgSql, [String(watcherId)], ctx, 'write');

  const MAX_ROLLUP_DEPTH = 3;
  if (tokenIsRollup && tokenDepth != null && tokenDepth > MAX_ROLLUP_DEPTH) {
    throw new Error(`Rollup depth ${tokenDepth} exceeds maximum of ${MAX_ROLLUP_DEPTH}`);
  }

  if (watcherRunId == null) {
    const runRows = await sql`
      SELECT id
      FROM runs
      WHERE watcher_id = ${watcherId}
        AND run_type = 'watcher'
        AND status = 'running'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (runRows.length > 0 && runRows[0].id != null) {
      watcherRunId = Number(runRows[0].id);
      provenanceMetadata.watcher_run_id = watcherRunId;
    }
  } else if (provenanceMetadata.watcher_run_id == null) {
    provenanceMetadata.watcher_run_id = watcherRunId;
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
      wv.id as version_id,
      wv.prompt as prompt,
      wv.extraction_schema as extraction_schema,
      wv.version_sources as version_sources,
      wv.classifiers as classifiers,
      wv.keying_config
    FROM watchers i
    LEFT JOIN watcher_versions wv
      ON wv.id = COALESCE(${snapshotVersionId}::bigint, i.current_version_id)
     AND wv.watcher_id = i.watcher_group_id
    WHERE i.id = ${watcherId}
    LIMIT 1
  `;

  if (watcherRows.length === 0) {
    throw new Error(
      `Watcher ${watcherId} not found. ` +
        'It may have been deleted. Use list_watchers to see available watchers.'
    );
  }

  // Fetch classifiers separately
  const classifierRows = await sql`
    SELECT
      cc.id,
      cc.slug,
      ccv.id as version_id,
      ccv.extraction_config
    FROM event_classifiers cc
    JOIN event_classifier_versions ccv ON cc.id = ccv.classifier_id AND ccv.is_current = true
    WHERE cc.watcher_id = ${watcherId}
      AND ccv.extraction_config IS NOT NULL
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
  const templateData = {
    prompt: watcherRows[0].prompt ?? undefined,
    extraction_schema: parseJson(watcherRows[0].extraction_schema) ?? undefined,
    data: parseJson(watcherRows[0].version_sources) ?? undefined,
    classifiers: parseJson(watcherRows[0].classifiers) ?? undefined,
  } as Record<string, any>;
  const keyingConfig = parseJson(watcherRows[0].keying_config) as {
    entity_path: string;
    key_fields: string[];
    key_output_field: string;
  } | null;

  // ============================================
  // STEP 2.5: Validate extracted_data against template's extraction_schema
  // ============================================
  if (templateData?.extraction_schema) {
    const extractionSchema = templateData.extraction_schema;
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
        `extracted_data does not match template's extraction_schema.\n\n` +
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

  // ============================================
  // STEP 2.6: Compute stable entity keys if template has keying_config
  // ============================================
  if (keyingConfig) {
    computeStableKeys(extractedData, keyingConfig);
    logger.info(
      `[complete_window] Computed stable keys for entities at path "${keyingConfig.entity_path}"`
    );
  }

  // ROLLUP PATH: If this is a condensation rollup, skip content linking
  if (tokenIsRollup && tokenSourceWindowIds && tokenSourceWindowIds.length > 0) {
    const depth = tokenDepth ?? 1;

    const sourceIds = tokenSourceWindowIds.map(Number);
    // getNextNumericId uses a transaction-scoped advisory lock; it MUST run in
    // the same transaction as the INSERT or the lock releases before the INSERT
    // and two concurrent device-worker rollup completions race on the PK (both
    // compute the same MAX(id)+1). Mirror the leaf-window path below.
    //
    // source_window_ids is integer[]; the prod pool runs fetch_types: false, so
    // postgres.js can't serialize a bare JS array (it ships "5,6" and PG throws
    // `malformed array literal`) — bind via the explicit literal idiom (#1046).
    const newWindowId = await sql.begin(async (tx) => {
      const allocatedWindowId = await getNextNumericId(tx, 'watcher_windows');
      await tx`
        INSERT INTO watcher_windows (
          id, watcher_id, version_id, window_start, window_end, granularity,
          extracted_data, content_analyzed, model_used, client_id, run_metadata,
          is_rollup, depth, source_window_ids, run_id, created_at
        ) VALUES (
          ${allocatedWindowId}, ${watcherId}, ${resolvedVersionId}, ${window_start}, ${window_end}, ${granularity || timeGranularity},
          ${tx.json(extractedData)}, 0, ${provenanceModel}, ${provenanceClientId}, ${tx.json(provenanceMetadata)},
          true, ${depth}, ${pgBigintArray(sourceIds)}::int[], ${watcherRunId}, NOW()
        )
      `;
      return allocatedWindowId;
    });

    logger.info(
      `[complete_window] Created rollup window ${newWindowId} for watcher ${watcherId} ` +
        `(depth=${depth}, sources=${tokenSourceWindowIds.join(',')})`
    );

    return {
      action: 'complete_window',
      watcher_id: String(watcherId),
      window_id: newWindowId,
      window_start,
      window_end,
      content_linked: 0,
      // Rollups condense existing windows — no fresh signal, so the early
      // return (before the reaction block) keeps reactions skipped.
      window_created: true,
      is_rollup: true,
      depth,
      source_window_ids: tokenSourceWindowIds,
      reaction_status: 'skipped' as const,
    };
  }

  // ============================================
  // STEP 3: Resolve the exact content IDs analyzed by the worker
  // ============================================
  const perTokenIds = tokenPayloads.map((token) => {
    if (!Array.isArray(token.content_ids)) {
      throw new ToolUserError(
        'Invalid window_token: content_ids is required. Get a fresh token from read_knowledge({ watcher_id: ... }).'
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
          'Get a fresh token from read_knowledge({ watcher_id: ... }).'
      );
    }
    return ids;
  });

  const batchContentIds = [...new Set(perTokenIds.flat())];
  const summedContentCount = perTokenIds.reduce((sum, ids) => sum + ids.length, 0);
  if (batchContentIds.length !== summedContentCount) {
    throw new Error('window_tokens contain overlapping content IDs. Pass each read_knowledge page token once.');
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
  const result = await sql.begin(async (tx) => {
    // ============================================
    // STEP 7: Get or create window with FINAL values
    //
    // Empty-content replay is idempotent: if a zero-content window already
    // exists for this period (a prior run consumed all candidates already),
    // refresh provenance instead of throwing "Window already exists". This
    // keeps the agent loop from retrying the same period forever (LOBU-Q)
    // without needing a separate no-op code path.
    // ============================================
    let windowId!: number;
    let windowCreated = false;

    if (tokenWindowId) {
      // Legacy flow: window_id in token, verify and update it
      const windowResult = await tx`
        UPDATE watcher_windows
        SET
          extracted_data = ${sql.json(cleanedExtractedData)},
          content_analyzed = ${batchContentIds.length},
          model_used = ${provenanceModel},
          client_id = ${provenanceClientId},
          run_metadata = ${sql.json(provenanceMetadata)},
          run_id = COALESCE(${watcherRunId}, run_id),
          created_at = COALESCE(created_at, NOW())
        WHERE id = ${tokenWindowId} AND watcher_id = ${watcherId}
        RETURNING id
      `;
      if (windowResult.length === 0) {
        throw new Error(
          `Window ${tokenWindowId} not found for watcher ${watcherId}. ` +
            'The window may have been deleted. Get a fresh token from read_knowledge({ watcher_id: ... }).'
        );
      }
      windowId = tokenWindowId;
    } else {
      // New flow: check for existing window first
      const existingWindow = await tx`
        SELECT id, content_analyzed FROM watcher_windows
        WHERE watcher_id = ${watcherId}
          AND window_start = ${window_start}
          AND window_end = ${window_end}
          AND granularity = ${timeGranularity}
        LIMIT 1
      `;

      let reuseExistingWindow = false;
      if (existingWindow.length > 0) {
        if (args.replace_existing) {
          // Delete existing window and its content links
          windowId = existingWindow[0].id as number;
          await tx`DELETE FROM watcher_window_events WHERE window_id = ${windowId}`;
          await tx`DELETE FROM watcher_windows WHERE id = ${windowId}`;
          logger.info(
            `[complete_window] Deleted existing window ${windowId} (replace_existing=true)`
          );
        } else if (watcherRunId != null || batchContentIds.length === 0) {
          // Idempotent replay: reuse the existing window so retries/manual
          // runs can still mark their run completed. Only refresh analysis
          // payload if the existing row was itself a no-op write — never
          // overwrite a successful completion's extracted data.
          windowId = existingWindow[0].id as number;
          reuseExistingWindow = true;
          if (Number(existingWindow[0].content_analyzed ?? 0) === 0) {
            await tx`
              UPDATE watcher_windows
              SET extracted_data = ${sql.json(cleanedExtractedData)},
                  content_analyzed = ${batchContentIds.length},
                  model_used = ${provenanceModel},
                  client_id = ${provenanceClientId},
                  run_metadata = ${sql.json(provenanceMetadata)},
                  run_id = COALESCE(${watcherRunId}, run_id)
              WHERE id = ${windowId} AND watcher_id = ${watcherId}
            `;
          } else if (watcherRunId != null) {
            await tx`
              UPDATE watcher_windows
              SET run_id = COALESCE(${watcherRunId}, run_id)
              WHERE id = ${windowId} AND watcher_id = ${watcherId}
            `;
          }
        } else {
          // Conflict with an existing window, not a server fault — 409 keeps
          // it out of the Sentry feed (was LOBU-BACKEND-Q).
          throw new ToolUserError(
            `Window already exists for watcher ${watcherId} for period ${window_start} to ${window_end}. ` +
              'Use replace_existing: true to replace it, or query a different time period.',
            409
          );
        }
      }

      if (!reuseExistingWindow) {
        const newWindowId = await getNextNumericId(tx, 'watcher_windows');

        // Single INSERT with ALL final values
        // UNIQUE index idx_watcher_windows_unique_period prevents race conditions
        try {
          await tx`
            INSERT INTO watcher_windows (
              id,
              watcher_id, version_id, window_start, window_end, granularity,
              extracted_data, content_analyzed, model_used, client_id, run_metadata, run_id, created_at
            ) VALUES (
              ${newWindowId},
              ${watcherId}, ${resolvedVersionId}, ${window_start}, ${window_end}, ${timeGranularity},
              ${sql.json(cleanedExtractedData)}, ${batchContentIds.length}, ${provenanceModel}, ${provenanceClientId}, ${sql.json(provenanceMetadata)}, ${watcherRunId}, NOW()
            )
          `;
        } catch (err: any) {
          if (err?.code === '23505') {
            throw new ToolUserError(
              `Window already exists for watcher ${watcherId} for period ${window_start} to ${window_end}. ` +
                'Use replace_existing: true to replace it, or query a different time period.',
              409
            );
          }
          throw err;
        }
        windowId = newWindowId;
        windowCreated = true;
        logger.info(
          `[complete_window] Created window ${windowId} for watcher ${watcherId} (${window_start} - ${window_end})`
        );
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
        valuePlaceholders.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, NOW())`);
        insertParams.push(nextWindowEventId, windowId, contentId);
        nextWindowEventId += 1;
        pIdx += 3;
      }

      await tx.unsafe(
        `INSERT INTO watcher_window_events (id, window_id, event_id, created_at)
         VALUES ${valuePlaceholders.join(', ')}
         ON CONFLICT DO NOTHING`,
        insertParams
      );
    }

    // ============================================
    // STEP 9: Process classifications
    // If this fails (e.g., embeddings service down), the transaction rolls back
    // ============================================
    const validContentIds = new Set(batchContentIds);
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
    if (watcherRunId && Number.isFinite(watcherRunId)) {
      // Scope by watcher_id so a wrong/stale watcher_run_id (passed in
      // run_metadata) cannot mark another watcher's run completed against
      // this watcher's window.
      const completedRows = await tx`
        UPDATE runs
        SET status = 'completed',
            window_id = ${windowId},
            completed_at = current_timestamp,
            error_message = NULL
        WHERE id = ${watcherRunId}
          AND watcher_id = ${watcherId}
          AND run_type = 'watcher'
          AND status IN ('running', 'claimed')
        RETURNING id
      `;
      runMarkedCompleted = completedRows.length > 0;
    }

    // Advance the schedule only when we actually did new work. Idempotent
    // replays (no window created, no run transitioned) must not push
    // next_run_at forward, or each retry would shift the schedule.
    if (windowCreated || runMarkedCompleted) {
      await advanceWatcherSchedule(tx, watcherId);
    }

    logger.info(
      `[manage_watchers] Completed window ${windowId} for watcher ${watcherId} ` +
        `(${window_start} - ${window_end}), linked ${batchContentIds.length} content items`
    );

    return {
      action: 'complete_window' as const,
      watcher_id: String(watcherId),
      window_id: windowId,
      window_start,
      window_end,
      content_linked: batchContentIds.length,
      window_created: windowCreated,
    };
  });

  // Execute reaction script inline (in-process via QuickJS WASM sandbox).
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
           w.name,
           wv.version as watcher_version
    FROM watchers w
    LEFT JOIN watcher_versions wv ON w.current_version_id = wv.id
    WHERE w.id = ${result.watcher_id}
  `;

  try {
    const sql = watcherMetaSql;
    const scriptRows = watcherMetaRows;
    if (
      (result.content_linked > 0 || result.window_created) &&
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
        WHERE w.id = ${result.watcher_id}
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
          watcher_id: Number(result.watcher_id),
          window_start: result.window_start,
          window_end: result.window_end,
          granularity: timeGranularity,
          content_analyzed: batchContentIds.length,
        },
        watcher: {
          id: Number(result.watcher_id),
          slug: (watcherMeta[0]?.slug ?? `watcher-${result.watcher_id}`) as string,
          name: (watcherMeta[0]?.name ?? `watcher-${result.watcher_id}`) as string,
          version: Number(row.watcher_version ?? 1),
        },
        organization_id: orgId,
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
          watcherId: Number(result.watcher_id),
          windowId: result.window_id,
          reactionType: 'script_execution',
          toolName: 'reaction_executor',
          toolArgs: { attempt },
          toolResult: { success: execResult.success, error: execResult.error },
        });

        if (execResult.success) {
          reactionStatus = 'success';
          logger.info(
            { watcher_id: result.watcher_id, window_id: result.window_id, attempt },
            'Reaction script executed successfully (inline)'
          );
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(
            { watcher_id: result.watcher_id, attempt, error: execResult.error },
            'Reaction script failed, retrying...'
          );
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          reactionStatus = 'failed';
          reactionError = execResult.error;
          logger.error(
            { watcher_id: result.watcher_id, error: execResult.error },
            'Reaction script failed after all retries'
          );
        }
      }
    }
  } catch (err) {
    reactionStatus = 'failed';
    reactionError = getErrorMessage(err);
    logger.warn({ err }, '[manage_watchers] Failed to execute reaction script');
  }

  return { ...result, reaction_status: reactionStatus, reaction_error: reactionError };
}
