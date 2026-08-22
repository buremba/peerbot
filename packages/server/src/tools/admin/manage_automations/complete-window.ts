/**
 * complete_window action handler for manage_automations.
 *
 * Validates token, writes the run result + content links, processes classifications,
 * marks run completed, advances schedule, and runs reaction script.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  enqueueWorkspaceEventActivations,
  findSubscribedWorkspaceEventTypes,
} from '../../../automations/workspace-event-enqueue';
import {
  automationTriggerSignals,
  deriveWorkspaceEventCausality,
  type WorkspaceEventActivationTaskPayload,
} from '../../../automations/workspace-event-contract';
import { createDbClientFromEnv, getDb, parsePgNumberArray } from '../../../db/client';
import type { Env } from '../../../index';
import { ToolUserError } from '../../../utils/errors';
import { verifyWindowToken } from '../../../utils/jwt';
import logger from '../../../utils/logger';
import { promoteAutomationEntityOutput } from '../../../utils/promote-keyed-entities';
import type { DeferredMutation } from '../../../authz/entity-mutation-gate';
import { insertEvent } from '../../../utils/insert-event';
import { isUniqueViolation } from '../../../utils/pg-errors';
import { persistAutomationEventOutput } from '../../../utils/persist-automation-event-output';
import { validateStableKeyComponents } from '../../../utils/stable-keys';
import { deriveAutomationExtractionSchema } from '../../../utils/automation-extraction-schema';
import { trackAutomationReaction } from '../../../utils/automation-reactions';
import {
  getFieldsToStrip,
  processAutomationClassifications,
  stripFields,
} from '../../../automations/classifier-extraction';
import { advanceAutomationSchedule } from '../../../automations/schedule-cursor';
import { executeReaction } from '../../../automations/reaction-executor';
import { getNextNumericId } from '../helpers/db-helpers';
import type { Outputs } from '../../../types/automations';
import type { ToolContext } from '../../registry';
import type { ManageAutomationsArgs } from '../manage_automations';
import { normalizeExtractedData, parseJson, requireAutomationAccess } from './shared';
import { getErrorMessage } from '@lobu/core';
import { classifyRunOutcome } from "../../../runs/run-outcome";
import { AUTOMATION_EVAL_RUN_TYPE, AUTOMATION_RUN_TYPE } from "../../../runs/run-types.js";
import { automationOutputOccurredAt } from '../../../utils/window-utils';

/** Cap on the content ids echoed into `dry_run_preview` — the preview exists to
 *  be read, and an unbounded id list on a wide window is neither useful nor
 *  cheap to store. Mirrors the capping rationale in worker-api/run-lifecycle. */
const CAPTURE_PREVIEW_CONTENT_CAP = 200;

/**
 * Deterministic reaction-script failure classes that a retry can never fix.
 * The sandbox prefixes these errors (`run-script.ts` classifyRuntimeError +
 * terminateRun): a timed-out, quota-exhausted, oversize, or compile-failed
 * reaction burns its full wall-clock budget on EVERY attempt, so retrying
 * multiplies the stall (a 60s TimeoutError retried 3x costs ~182s) with zero
 * recovery probability. Everything else — provider/network 5xx, transient SDK
 * failures — stays retryable.
 */
export function reactionErrorIsNonTransient(error: string | undefined): boolean {
  if (!error) return false;
  return (
    /^(TimeoutError|CompileError|QuotaExceeded|OutputSizeExceeded|InvalidSleepDuration|SleepLimitExceeded|OutOfMemory|ValidationError|ClientSdkActionError|McpScopeRequiredError):/.test(
      error
    ) ||
    /^ScriptError: (?:Script must `export default` an async function|NamespaceNotAvailable:|CrossOrgAccessDenied:|InvalidSDKDispatchEnvelope|Unknown SDK method:)/.test(
      error
    )
  );
}

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
  args: ManageAutomationsArgs,
  env: Env,
  ctx: ToolContext
): Promise<{
  action: 'complete_window';
  automation_id: string;
  run_id: number;
  window_start: string;
  window_end: string;
  content_linked: number;
  /** Internal reaction gate; false on idempotent replays. */
  completed_now: boolean;
  reaction_status: 'success' | 'failed' | 'skipped';
  reaction_error?: string;
  /** Set only on an eval replay (`executionMode = 'capture'`): the extraction
   *  was recorded on the eval run's `dry_run_preview` and nothing was written. */
  captured?: true;
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
  if (provenanceClientId) provenanceMetadata.client_id = provenanceClientId;
  // The run row is the identity; never duplicate its id inside run_metadata.
  delete provenanceMetadata.automation_run_id;
  delete provenanceMetadata.run_id;
  const runId = Number(args.run_id);

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
    throw new ToolUserError(
      'window_token or window_tokens is required for complete_window action. ' +
        'Get tokens from read_knowledge({ automation_id: ... }) responses.',
      400
    );
  }
  if (!args.extracted_data) {
    throw new ToolUserError(
      'extracted_data is required for complete_window action. ' +
        'This should contain the LLM analysis results (e.g., { sentiment: "positive", themes: [...] }).',
      400
    );
  }
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new ToolUserError(
      'run_id is required for complete_window. Use the run ID from the dispatch prompt or Automation list.',
      400
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
        'Get a fresh token from read_knowledge({ automation_id: ... }).'
    );
  }

  const firstToken = tokenPayloads[0];
  const { automation_id: automationId, window_start, window_end, granularity } = firstToken;

  for (const token of tokenPayloads) {
    if (
      token.automation_id !== automationId ||
      token.window_start !== window_start ||
      token.window_end !== window_end ||
      token.granularity !== granularity
    ) {
      throw new ToolUserError('All window_tokens must belong to the same Automation window.', 400);
    }
  }

  const pgSql = createDbClientFromEnv(env);
  await requireAutomationAccess(pgSql, [String(automationId)], ctx, 'write');

  // The lane this caller belongs to. A live session and an eval replay must
  // never resolve to, or claim, each other's run: the mode is derived from the
  // run row at session creation, so a live token carries no capture claim and
  // would execute the real write path for a window the eval only replays.
  const callerRunType =
    ctx.executionMode === 'capture' ? AUTOMATION_EVAL_RUN_TYPE : AUTOMATION_RUN_TYPE;

  // ============================================
  // STEP 2: Combined query - automation + classifiers + template schema
  // ============================================
  // Resolve the version this run was started against. The agent extracted
  // data using that version's prompt/schema; we MUST validate against the
  // same version even if the group has been edited mid-run.
  //
  // Resolution order:
  //   1. explicit args.template_version_id (the agent passes this back)
  //   2. runs.approved_input.version_id (snapshotted at run-creation)
  //   3. automations.current_version_id (fallback for callers outside a run)
  //
  // The run lookup is scoped by automation_id so a wrong or stale run_id
  // can't read another automation's snapshot.
  let snapshotVersionId: number | null =
    typeof args.template_version_id === 'number' ? args.template_version_id : null;
  let runTriggerSignals: unknown[] = [];
  const runRows = await sql`
    SELECT (r.approved_input->>'version_id')::bigint AS version_id,
           r.approved_input
    FROM runs r
    JOIN automations a
      ON a.id = r.automation_id
     AND a.organization_id = r.organization_id
    WHERE r.id = ${runId}
      AND r.automation_id = ${automationId}
      AND r.run_type = ${callerRunType}
      AND (r.approved_input->>'window_start')::timestamptz = ${window_start}::timestamptz
      AND (r.approved_input->>'window_end')::timestamptz = ${window_end}::timestamptz
    LIMIT 1
  `;
  if (runRows.length === 0) {
    throw new ToolUserError(
      `Automation run ${runId} does not own the submitted period.`,
      409
    );
  }

  // Manual-open runs (no agent, no device pin) pend for any connected MCP
  // client — there is no claim step, so the completing client transitions the
  // run pending->running here. Claimed only after the period check above, so a
  // client submitting a stale token leaves the run pending and retryable rather
  // than stranding it 'running' until the stale sweeper times it out.
  // Best-effort and race-safe: concurrent completers both see an active run,
  // and the completion transition below is idempotent. Addressed runs (agent
  // dispatch / device lane) never match this filter, so an external client
  // cannot hijack a dispatched run.
  await sql`
    UPDATE runs
    SET status = 'running',
        claimed_at = COALESCE(claimed_at, current_timestamp)
    WHERE id = ${runId}
      AND automation_id = ${automationId}
      AND run_type = ${callerRunType}
      AND status = 'pending'
      AND (approved_input->>'agent_id' IS NULL OR approved_input->>'agent_id' = '')
      AND (approved_input->>'device_worker_id' IS NULL OR approved_input->>'device_worker_id' = '')
  `;
  if (snapshotVersionId == null && runRows[0].version_id != null) {
    snapshotVersionId = Number(runRows[0].version_id);
  }
  const approvedInput = runRows[0].approved_input;
  if (approvedInput && typeof approvedInput === 'object') {
    const input = approvedInput as {
      trigger_signal?: unknown;
      trigger_signals?: unknown[];
    };
    runTriggerSignals = automationTriggerSignals(input);
  }

  // The version row must belong to this automation's group — prevents pinning
  // to another group's version via a forged template_version_id arg.
  const automationRows = await sql`
    SELECT
      i.id,
      i.schedule,
      i.entity_ids,
      i.organization_id,
      i.created_by,
      wv.id as version_id,
      wv.outputs
    FROM automations i
    LEFT JOIN automation_versions wv
      ON wv.id = COALESCE(${snapshotVersionId}::bigint, i.current_version_id)
     AND wv.automation_id = i.automation_group_id
    WHERE i.id = ${automationId}
    LIMIT 1
  `;

  if (automationRows.length === 0) {
    throw new ToolUserError(
      `Automation ${automationId} not found. ` +
        'It may have been deleted. Use client.automations.list() via query_sdk to see available Automations.',
      404
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
    WHERE cc.automation_id = ${automationId}
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
    automationRows[0].version_id != null ? Number(automationRows[0].version_id) : null;
  const outputs = parseJson(automationRows[0].outputs) as Outputs | null;

  // When everything this completion writes happened — see
  // `automationOutputOccurredAt` for why `window_end` alone hid the row.
  //
  // Clamping does NOT keep the output out of its own window; the future stamp
  // was silently buying that. That job moves to the self-exclusion in
  // `execute-data-sources.ts`. The two changes are a pair, neither safe alone.
  const producedAt = automationOutputOccurredAt(window_end);

  // The org + bound parent entity the promoted child entities hang under. The
  // automation's first bound entity is the parent; unbound automations promote at the
  // root (parent_id NULL). `entities.created_by` is NOT NULL with an
  // ON DELETE RESTRICT FK to user(id); the automation's own `created_by` is a
  // guaranteed-live user (same FK), so it's the correct attribution.
  const automationOrgId = automationRows[0].organization_id as string;
  const automationCreatedBy = (automationRows[0].created_by as string | null) ?? null;
  const workspaceEventCausality = deriveWorkspaceEventCausality(
    runTriggerSignals,
    Number(automationId)
  );
  // entity_ids is bigint[]; the prod pool runs fetch_types:false, so postgres.js
  // hands it back as the literal string "{4}" (NOT a JS array) — parse it.
  const boundEntityIds = parsePgNumberArray(automationRows[0].entity_ids);
  const parentEntityId = boundEntityIds.length > 0 ? boundEntityIds[0] : null;

  // ============================================
  // STEP 2.5: Validate extracted_data against the extraction schema.
  // The schema is composed from declared outputs and the optional reaction
  // input. Entity schemas still live on their entity types; event outputs use
  // the standard event draft. The worker and completion share this helper.
  // ============================================
  const extractionSchema: Record<string, any> | null = await deriveAutomationExtractionSchema(
    getDb(),
    automationOrgId,
    outputs,
    automationId
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

      throw new ToolUserError(
        `extracted_data does not match the Automation\'s extraction contract (derived from its entity type or reaction \`input\` schema).\n\n` +
          `Validation errors:\n${errorMessages.join('\n')}\n\n` +
          'Expected schema requires:\n' +
          `  - Required fields: ${JSON.stringify(extractionSchema.required || [])}\n` +
          `  - Top-level properties: ${Object.keys(extractionSchema.properties || {}).join(', ')}\n\n` +
          `Received top-level keys: ${Object.keys(extractedData).join(', ')}\n\n` +
          'Please ensure your LLM output matches the template schema exactly.',
        400
      );
    }

    logger.info('[complete_window] extracted_data validated against template schema successfully');
  }

  // JSON Schema maxLength counts characters, while durable stable-key storage
  // is bounded in UTF-8 bytes and also rejects blank strings. Enforce the exact
  // encoder contract before opening the completion transaction or writing the
  // run so invalid model output is an actionable 422, not a mid-write error.
  validateEntityOutputKeys(extractedData, outputs);

  // ============================================
  // STEP 3: Resolve the exact content IDs analyzed by the worker
  // ============================================
  const perTokenIds = tokenPayloads.map((token) => {
    if (!Array.isArray(token.content_ids)) {
      throw new ToolUserError(
        'Invalid window_token: content_ids is required. Get a fresh token from read_knowledge({ automation_id: ... }).'
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
          'Get a fresh token from read_knowledge({ automation_id: ... }).'
      );
    }
    return ids;
  });

  const batchContentIds = [...new Set(perTokenIds.flat())];
  const summedContentCount = perTokenIds.reduce((sum, ids) => sum + ids.length, 0);
  if (batchContentIds.length !== summedContentCount) {
    throw new ToolUserError(
      'window_tokens contain overlapping content IDs. Pass each read_knowledge page token once.',
      409
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
  // STEP 5: Capture mode — an eval replay records its output, never commits it
  // ============================================
  // Everything above is validation and reads, so a capture run takes exactly
  // the same 400s a live run would and only the side effect diverges.
  // Everything below is writes: the result run, entity promotion,
  // output events, classifications, the schedule cursor, and the reaction
  // script.
  //
  // This return is load-bearing, not defensive. An eval replays the SAME window
  // as the run it scores. Returning here keeps the replay read-only and prevents
  // the reaction script from firing.
  //
  // The extraction is what PR 3 scores, so it is persisted where a captured
  // payload already belongs: `runs.dry_run_preview` (see
  // 20260731020000_runs_dry_run.sql). The `run_type` guard on the UPDATE means
  // a capture claim can never stamp a real Automation run.
  if (ctx.executionMode === 'capture') {
    // MERGE, never assign. The capture guard appends `side_effects` to this
    // same column during the turn, and finalize runs last — assigning here
    // deletes every side effect the agent attempted first.
    await sql`
      UPDATE runs
      SET dry_run = true,
          dry_run_preview = coalesce(dry_run_preview, '{}'::jsonb) || ${sql.json({
            captured: 'complete_window',
            automation_id: String(automationId),
            window_start,
            window_end,
            granularity,
            extracted_data: cleanedExtractedData as never,
            content_ids: batchContentIds.slice(0, CAPTURE_PREVIEW_CONTENT_CAP),
            content_linked: batchContentIds.length,
            content_ids_truncated: batchContentIds.length > CAPTURE_PREVIEW_CONTENT_CAP,
          })}::jsonb
      WHERE id = ${runId}
        AND run_type = ${AUTOMATION_EVAL_RUN_TYPE}
    `;
    logger.info(
      {
        evalCapture: true,
        runId,
        automationId,
        window_start,
        window_end,
        contentLinked: batchContentIds.length,
      },
      '[evals] Recorded a complete_window extraction without writing it'
    );
    return {
      action: 'complete_window' as const,
      automation_id: String(automationId),
      run_id: runId,
      window_start,
      window_end,
      content_linked: 0,
      completed_now: false,
      reaction_status: 'skipped' as const,
      captured: true as const,
    };
  }

  // ============================================
  // STEP 6: Wrap all DB operations in a transaction
  // If classification processing fails (e.g., embeddings service unavailable),
  // the entire operation rolls back - no corrupted data is saved.
  //
  // Transaction for data writes.
  // ============================================
  // Owned-field changes and policy-held creates an automation proposed but couldn't
  // apply; surfaced out of the transaction as deferred approvals and flushed once
  // the window commits.
  let deferredApprovals: DeferredMutation[] = [];
  const result = await sql.begin(async (tx) => {
    const [lockedRun] = await tx`
      SELECT status
      FROM runs
      WHERE id = ${runId}
        AND organization_id = ${automationOrgId}
        AND automation_id = ${automationId}
        AND run_type = ${AUTOMATION_RUN_TYPE}
      FOR UPDATE
    `;
    if (!lockedRun) {
      throw new ToolUserError(`Automation run ${runId} not found.`, 404);
    }
    if (lockedRun.status === 'completed') {
      return {
        action: 'complete_window' as const,
        automation_id: String(automationId),
        run_id: runId,
        window_start,
        window_end,
        content_linked: 0,
        completed_now: false,
      };
    }
    if (lockedRun.status !== 'running' && lockedRun.status !== 'claimed') {
      throw new ToolUserError(`Automation run ${runId} is no longer completable.`, 409);
    }

    // ============================================
    // STEP 8: Link content to window (bulk INSERT)
    // Build VALUES clause for bulk insert
    // ============================================
    if (batchContentIds.length > 0) {
      let nextWindowEventId = await getNextNumericId(tx, 'automation_run_events');
      const valuePlaceholders: string[] = [];
      const insertParams: unknown[] = [];
      let pIdx = 1;
      for (const contentId of batchContentIds) {
        valuePlaceholders.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, NOW())`);
        insertParams.push(nextWindowEventId, runId, contentId, Number(automationId));
        nextWindowEventId += 1;
        pIdx += 4;
      }

      await tx.unsafe(
        `INSERT INTO automation_run_events (id, run_id, event_id, automation_id, created_at)
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
    // STEP 8.5: Persist declared entity and event outputs atomically with the run.
    // ============================================
    const entityChanges = [] as Array<{
      entityId: number;
      name: string;
      kind: 'created' | 'updated' | 'denied';
      applied: Record<string, unknown>;
      denied?: { source: 'policy' | 'rule'; reason: string };
    }>;
    const subscribedWorkspaceEventTypes = await findSubscribedWorkspaceEventTypes(
      automationOrgId,
      Object.values(outputs ?? {}).flatMap((output) =>
        'event' in output ? [output.event] : []
      ),
      tx
    );
    const workspaceEventActivations: WorkspaceEventActivationTaskPayload[] = [];
    for (const [outputName, output] of Object.entries(outputs ?? {})) {
      if ('entity' in output) {
        const promote = await promoteAutomationEntityOutput({
          tx,
          extractedData,
          outputName,
          output,
          automationId: Number(automationId),
          organizationId: automationOrgId,
          runId,
          parentEntityId,
          createdBy: automationCreatedBy,
          validContentIds,
        });
        deferredApprovals.push(...promote.deferred);
        entityChanges.push(...promote.changes);
      } else {
        const persistedEvents = await persistAutomationEventOutput({
          tx,
          rows: extractedData[outputName],
          outputName,
          output,
          automationId: Number(automationId),
          versionId: resolvedVersionId,
          organizationId: automationOrgId,
          runId,
          boundEntityIds,
          validContentIds,
          occurredAt: producedAt,
          createdBy: automationCreatedBy,
        });
        for (const event of persistedEvents) {
          if (
            event.change === 'unchanged' ||
            event.change === 'state_updated' ||
            !subscribedWorkspaceEventTypes.has(output.event)
          ) {
            continue;
          }
          workspaceEventActivations.push({
            organizationId: automationOrgId,
            eventId: Number(event.id),
            rootEventIds:
              workspaceEventCausality.rootEventIds.length > 0
                ? workspaceEventCausality.rootEventIds
                : [Number(event.id)],
            causalAutomationIds: workspaceEventCausality.causalAutomationIds,
            depth: workspaceEventCausality.depth,
          });
        }
      }
    }
    await enqueueWorkspaceEventActivations(tx, workspaceEventActivations);

    // One run-level change set covers every entity output.
    if (entityChanges.length > 0) {
      // Count each kind explicitly. Deriving one by subtraction silently
      // mislabels every kind added later — `denied` would have counted as
      // `updated`, reporting a refusal as a write.
      const createdCount = entityChanges.filter((c) => c.kind === 'created').length;
      const updatedCount = entityChanges.filter((c) => c.kind === 'updated').length;
      const deniedCount = entityChanges.filter((c) => c.kind === 'denied').length;
      const deniedSuffix = deniedCount > 0 ? ` + ${deniedCount} denied` : '';
      const changeSetIdempotencyKey = `automation:${automationId}:run:${runId}:change_set`;
      const findChangeSet = () => tx<{ id: number }>`
        SELECT id FROM events
        WHERE organization_id = ${automationOrgId}
          AND metadata->>'_lobu_idempotency_key' = ${changeSetIdempotencyKey}
        LIMIT 1
      `;
      if ((await findChangeSet()).length === 0) {
        try {
          await tx.savepoint((sp) =>
            insertEvent(
              {
                // A denial can carry no entity (a refused CREATE never got an
                // id), so the timeline links only the rows that exist.
                entityIds: entityChanges.map((c) => c.entityId).filter((id) => id > 0),
                organizationId: automationOrgId,
                originId: `run_${runId}_changeset`,
                title: `Automation applied ${createdCount} new + ${updatedCount} updated${deniedSuffix}`,
                content: `This run created ${createdCount} and updated ${updatedCount} entities${
                  deniedCount > 0 ? `; ${deniedCount} denied` : ''
                }.`,
                semanticType: 'change_set',
                runId,
                automationId: Number(automationId),
                automationVersionId: resolvedVersionId,
                metadata: {
                  _lobu_idempotency_key: changeSetIdempotencyKey,
                  kind: 'automation_change_set',
                  automation_id: Number(automationId),
                  created_count: createdCount,
                  updated_count: updatedCount,
                  denied_count: deniedCount,
                  changes: entityChanges,
                },
                createdBy: automationCreatedBy,
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
    await processAutomationClassifications(
      tx,
      automationId,
      runId,
      extractedData,
      classifiers,
      validContentIds,
      env
    );

    const [completedRun] = await tx`
      UPDATE runs
      SET status = 'completed',
          outcome = ${classifyRunOutcome({ status: "completed" })},
          action_output = ${tx.json(cleanedExtractedData)},
          approved_input = COALESCE(approved_input, '{}'::jsonb) || ${tx.json({
            window_start,
            window_end,
            granularity: timeGranularity,
          })}::jsonb,
          model_used = COALESCE(
            ${explicitProvenanceModel},
            NULLIF(model_used, 'external-client'),
            CASE
              WHEN dispatched_message_id IS NOT NULL THEN 'lobu-agent'
              ELSE 'external-client'
            END
          ),
          run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${tx.json({
            ...provenanceMetadata,
            content_analyzed: batchContentIds.length,
          })},
          completed_at = current_timestamp,
          error_message = NULL
      WHERE id = ${runId}
        AND automation_id = ${automationId}
        AND run_type = ${AUTOMATION_RUN_TYPE}
        AND status IN ('running', 'claimed')
      RETURNING approved_input->>'dispatch_source' AS dispatch_source
    `;
    if (!completedRun) {
      throw new ToolUserError(`Automation run ${runId} is no longer completable.`, 409);
    }

    // Advance the schedule only when we actually did new work. Idempotent
    // replays (no window created, no run transitioned) must not push
    // next_run_at forward, or each retry would shift the schedule.
    if (completedRun.dispatch_source !== 'event') {
      await advanceAutomationSchedule(tx, automationId);
    }

    logger.info(
      `[manage_automations] Completed run ${runId} for automation ${automationId} ` +
        `(${window_start} - ${window_end}), linked ${batchContentIds.length} content items`
    );

    return {
      action: 'complete_window' as const,
      automation_id: String(automationId),
      run_id: runId,
      window_start,
      window_end,
      content_linked: batchContentIds.length,
      completed_now: true,
    };
  });

  // Post-commit: flush any deferred approvals (owned-field changes + policy-held
  // creates) the automation couldn't apply inline. Done after the window transaction
  // so the durable approval (run + event + notify) is never rolled back with the
  // window, and a failure here never undoes the committed sync. Best-effort each.
  for (const d of deferredApprovals) {
    await d
      .queue(ctx, env)
      .catch((err) =>
        logger.error(
          { err, automationId, action: d.display.action },
          '[complete-window] failed to queue deferred entity approval'
        )
      );
  }

  // Execute the reaction script inline in the isolated reaction sandbox.
  // Fire on linked content OR on a freshly created window: device-run and
  // other self-sourcing automations link no server-side content — their signal
  // is the extracted_data itself, and the reaction script decides what to do
  // with it. Idempotent replays (no new window, nothing linked) still skip,
  // so a retried completion can't double-fire a reaction.
  let reactionStatus: 'success' | 'failed' | 'skipped' = 'skipped';
  let reactionError: string | undefined;

  // Fetch automation metadata once — used for both reaction script and auto-notify
  const automationMetaSql = getDb();
  const automationMetaRows = await automationMetaSql`
    SELECT w.reaction_script_compiled, w.entity_ids,
           w.organization_id, w.current_version_id,
           w.name, o.slug AS organization_slug,
           wv.version as automation_version
    FROM automations w
    JOIN organization o ON o.id = w.organization_id
    LEFT JOIN automation_versions wv ON w.current_version_id = wv.id
    WHERE w.id = ${result.automation_id}
  `;

  try {
    const sql = automationMetaSql;
    const scriptRows = automationMetaRows;
    if (
      result.completed_now &&
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

      // Fetch automation name from version, slug from template (pre-consolidation)
      const automationMeta = await sql`
        SELECT w.id, COALESCE(wv.name, 'automation-' || w.id) as name,
               COALESCE(w.slug, 'automation-' || w.id) as slug
        FROM automations w
        LEFT JOIN automation_versions wv ON w.current_version_id = wv.id
        WHERE w.id = ${result.automation_id}
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
          run_id: result.run_id,
          automation_id: Number(result.automation_id),
          window_start: result.window_start,
          window_end: result.window_end,
          granularity: timeGranularity,
          content_analyzed: batchContentIds.length,
        },
        automation: {
          id: Number(result.automation_id),
          slug: (automationMeta[0]?.slug ?? `automation-${result.automation_id}`) as string,
          name: (automationMeta[0]?.name ?? `automation-${result.automation_id}`) as string,
          version: Number(row.automation_version ?? 1),
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

        await trackAutomationReaction({
          organizationId: orgId,
          automationId: Number(result.automation_id),
          sourceRunId: result.run_id,
          reactionType: 'script_execution',
          toolName: 'reaction_executor',
          toolArgs: { attempt },
          toolResult: { success: execResult.success, error: execResult.error },
        });

        if (execResult.success) {
          reactionStatus = 'success';
          logger.info(
            {
              automation_id: result.automation_id,
              run_id: result.run_id,
              attempt,
            },
            'Reaction script executed successfully (inline)'
          );
          break;
        }

        // Deterministic script failures are NOT transient: retrying a timed-out
        // or quota-exhausted reaction re-burns the same 60s budget 3x and
        // stalls complete_window by ~3 minutes for zero chance of recovery
        // (run-script's error names are stable — TimeoutError, CompileError,
        // QuotaExceeded, OutputSizeExceeded, ValidationError, …). Only the transient
        // remainder (provider/network 5xx and similar) gets the retry loop.
        const isNonTransient = reactionErrorIsNonTransient(execResult.error);
        if (isNonTransient || attempt === MAX_ATTEMPTS) {
          reactionStatus = 'failed';
          reactionError = execResult.error;
          logger[isNonTransient ? 'warn' : 'error'](
            { automation_id: result.automation_id, attempt, error: execResult.error },
            isNonTransient
              ? 'Reaction script failed on a non-transient error; not retrying'
              : 'Reaction script failed after all retries'
          );
          break;
        }

        logger.warn(
          { automation_id: result.automation_id, attempt, error: execResult.error },
          'Reaction script failed, retrying...'
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } catch (err) {
    reactionStatus = 'failed';
    reactionError = getErrorMessage(err);
    logger.warn({ err }, '[manage_automations] Failed to execute reaction script');
  }

  return {
    ...result,
    reaction_status: reactionStatus,
    reaction_error: reactionError,
  };
}
