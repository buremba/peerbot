/**
 * Feedback action handlers for manage_behaviors:
 *   submit_feedback, get_feedback, list_promoted
 */

import { getDb, parsePgNumberArray } from '../../../db/client';
import { parseJsonObject } from '@lobu/core';
import { ensureCanvasEntity, findCanvasHead } from '../../../utils/canvas-events';
import { ToolUserError } from '../../../utils/errors';
import { insertEvent } from '../../../utils/insert-event';
import { isUniqueViolation } from '../../../utils/pg-errors';
import logger from '../../../utils/logger';
import type { ToolContext } from '../../registry';
import type { ManageBehaviorsArgs, ManageBehaviorsResult } from '../manage_behaviors';

type CorrectionInput = {
  field_path: string;
  mutation?: 'set' | 'remove' | 'add';
  value?: unknown;
  note?: string;
};

/**
 * Segments that would let a caller-supplied field_path walk or assign onto the
 * prototype chain instead of the payload's own data (prototype pollution).
 * field_path is user input — a path like `__proto__.polluted` must be a no-op.
 */
function isForbiddenPathSegment(segment: string | number): boolean {
  return (
    segment === '__proto__' ||
    segment === 'constructor' ||
    segment === 'prototype'
  );
}

/**
 * Parse a correction field_path into path segments, supporting dot notation and
 * array-index brackets: `problems[0].severity` → ['problems', 0, 'severity'].
 * Returns null when any segment targets the prototype chain — callers treat it
 * as an inapplicable path (the advisory event still records the intent).
 */
function parseFieldPath(path: string): (string | number)[] | null {
  const segments: (string | number)[] = [];
  for (const part of path.split('.')) {
    const match = part.match(/^([^[\]]*)((\[\d+\])*)$/);
    if (!match) {
      segments.push(part);
      continue;
    }
    const [, key, indices] = match;
    if (key) segments.push(key);
    if (indices) {
      for (const idx of indices.matchAll(/\[(\d+)\]/g)) {
        segments.push(Number(idx[1]));
      }
    }
  }
  if (segments.some(isForbiddenPathSegment)) {
    return null;
  }
  return segments;
}

/**
 * Apply a single set/remove/add correction and return a new payload. Mirrors
 * the advisory correction semantics:
 *   - set:    write `value` at the path (creating intermediate objects/arrays).
 *   - remove: delete the array element / object key at the path.
 *   - add:    push `value` onto the array at the path (creating it if absent).
 * Best-effort: a path that can't be traversed is a no-op (the advisory event
 * still records the intent).
 */
function applyCorrectionToData(
  data: Record<string, unknown>,
  fieldPath: string,
  mutation: 'set' | 'remove' | 'add',
  value: unknown
): Record<string, unknown> {
  const segments = parseFieldPath(fieldPath);
  if (segments == null || segments.length === 0) return data;
  const updated = applyCorrectionAt(data, segments, mutation, value);
  return updated != null && typeof updated === 'object' && !Array.isArray(updated)
    ? (updated as Record<string, unknown>)
    : data;
}

/**
 * Immutable path update. Object writes use computed object-literal properties,
 * whose `__proto__` semantics are ordinary own data properties rather than the
 * legacy prototype setter. The parser still rejects all prototype-chain names,
 * so forbidden paths remain inert and never reach this function.
 */
function applyCorrectionAt(
  current: unknown,
  segments: readonly (string | number)[],
  mutation: 'set' | 'remove' | 'add',
  value: unknown
): unknown {
  const segment = segments[0];
  if (segment == null || isForbiddenPathSegment(segment)) return current;
  const leaf = segments.length === 1;

  if (Array.isArray(current)) {
    if (typeof segment !== 'number' || !Number.isSafeInteger(segment) || segment < 0) {
      return current;
    }
    const copy = [...current];
    if (leaf) {
      if (mutation === 'remove') {
        copy.splice(segment, 1);
      } else if (mutation === 'add') {
        const target = copy[segment];
        copy[segment] = Array.isArray(target)
          ? [...target, value]
          : target == null
            ? [value]
            : [target, value];
      } else {
        copy[segment] = value;
      }
      return copy;
    }
    const existing = copy[segment];
    if (existing == null && mutation === 'remove') return current;
    const seed =
      existing == null ? (typeof segments[1] === 'number' ? [] : {}) : existing;
    copy[segment] = applyCorrectionAt(seed, segments.slice(1), mutation, value);
    return copy;
  }

  if (current == null || typeof current !== 'object') return current;
  const object = current as Record<string, unknown>;
  const key = String(segment);
  if (leaf) {
    if (mutation === 'remove') {
      if (!Object.hasOwn(object, key)) return current;
      const { [key]: removed, ...rest } = object;
      void removed;
      return rest;
    }
    if (mutation === 'add') {
      const target = Object.hasOwn(object, key) ? object[key] : undefined;
      return {
        ...object,
        [key]: Array.isArray(target)
          ? [...target, value]
          : target == null
            ? [value]
            : [target, value],
      };
    }
    return { ...object, [key]: value };
  }

  const existing = Object.hasOwn(object, key) ? object[key] : undefined;
  if (existing == null && mutation === 'remove') return current;
  const seed =
    existing == null ? (typeof segments[1] === 'number' ? [] : {}) : existing;
  return {
    ...object,
    [key]: applyCorrectionAt(seed, segments.slice(1), mutation, value),
  };
}

// ============================================
// handleSubmitFeedback
// ============================================

export async function handleSubmitFeedback(
  args: ManageBehaviorsArgs,
  ctx: ToolContext
): Promise<ManageBehaviorsResult> {
  if (!args.behavior_id) throw new Error('behavior_id is required');
  if (!args.window_id) throw new Error('window_id is required');
  if (!ctx.userId) {
    throw new Error('Authentication required to submit feedback');
  }
  const corrections = args.corrections as CorrectionInput[] | undefined;
  if (!Array.isArray(corrections) || corrections.length === 0) {
    throw new Error('corrections must be a non-empty array of {field_path, ...} entries');
  }

  for (const c of corrections) {
    if (!c.field_path || typeof c.field_path !== 'string') {
      throw new Error('each correction requires a string field_path');
    }
    const m = c.mutation ?? 'set';
    if (m !== 'set' && m !== 'remove' && m !== 'add') {
      throw new Error(`unsupported mutation "${m}" for ${c.field_path}`);
    }
    if ((m === 'set' || m === 'add') && c.value === undefined) {
      throw new Error(`${m} correction for ${c.field_path} requires a value`);
    }
  }

  const sql = getDb();
  const behaviorId = Number(args.behavior_id);

  // Scope to the caller's current org so a member of org A can't write
  // feedback against a behavior in org B by passing its behavior_id. window_id is
  // the canvas ROOT event id — canvas_windows resolves the period metadata.
  const windowCheck = await sql`
    SELECT ww.id, ww.granularity, ww.window_start, ww.window_end,
           w.organization_id, w.created_by, w.entity_ids
    FROM canvas_windows ww
    JOIN behaviors w ON w.id = ww.behavior_id
    WHERE ww.id = ${args.window_id}
      AND ww.behavior_id = ${behaviorId}
      AND w.organization_id = ${ctx.organizationId}
  `;
  if (windowCheck.length === 0) {
    throw new Error(`Window ${args.window_id} not found for Behavior ${behaviorId}`);
  }
  const organizationId = windowCheck[0].organization_id as string;
  const windowGranularity = windowCheck[0].granularity as string;
  const windowStart = new Date(windowCheck[0].window_start as string).toISOString();
  const windowEnd = new Date(windowCheck[0].window_end as string).toISOString();

  // Correction-events (P1): every submit emits a correction event directly to the events spine
  // (semantic_type='correction'). The correction EVENT's id is the feedback id
  // (origin_id stays NULL); historical rows carry origin_id 'wwff_<seq>' from the
  // retired sequence and readers still parse those.
  // One transaction so a partial failure never leaks half-applied corrections.
  // Advisory correction events and canvas materialization commit in ONE
  // transaction so a surfaced 409 rolls back BOTH: the caller sees a clean
  // conflict, retries, and the advisory events are recorded exactly once
  // (committing them before a 409 would double-record on retry). Materialization
  // itself runs in a SAVEPOINT: any non-conflict failure rolls back only the
  // canvas write and the advisory events still commit (materialization is
  // additive; the advisory 'correction' events keep feeding
  // getRecentFeedbackSummary into future runs regardless).
  const feedbackIds = await sql.begin(async (tx) => {
    const ids: number[] = [];
    for (const c of corrections) {
      const mutation = c.mutation ?? 'set';
      const correctedValueJson =
        mutation === 'remove' || c.value === undefined ? null : tx.json(c.value);
      const [row] = await tx`
        INSERT INTO events (
          organization_id, semantic_type, entity_ids, metadata,
          created_by, occurred_at, created_at
        )
        SELECT
          ${organizationId}, 'correction', '{}'::bigint[],
          jsonb_build_object(
            'window_id', ${args.window_id}::bigint,
            'behavior_id', ${behaviorId}::bigint,
            'field_path', ${c.field_path}::text,
            'mutation', ${mutation}::text,
            'corrected_value', ${correctedValueJson}::jsonb,
            'note', ${c.note ?? null}::text
          ),
          (SELECT u.id FROM "user" u WHERE u.id = ${ctx.userId}),
          NOW(), NOW()
        RETURNING id
      `;
      ids.push(Number(row.id));
    }

    // Materialize the corrections onto the canvas so the user sees their edit
    // immediately: apply the set/remove/add mutations to the current chain
    // HEAD's payload_data and insert ONE superseding canvas_state event
    // authored by the user. If no chain exists yet (pre-backfill window), skip
    // gracefully. The concurrent-edit loser hits idx_events_superseded_by →
    // 409 (same handling as save_content.ts).
    try {
      await tx.savepoint(async (sp) => {
        const spSql = sp as unknown as typeof tx;
        const head = await findCanvasHead(spSql, {
          behaviorId,
          granularity: windowGranularity,
          windowStart,
        });
        if (!head) {
          logger.info(
            { behaviorId, windowId: args.window_id },
            '[submit_feedback] no canvas_state chain yet — skipping materialization'
          );
          return;
        }

        let nextPayload = structuredClone(head.payloadData);
        for (const c of corrections) {
          nextPayload = applyCorrectionToData(
            nextPayload,
            c.field_path,
            c.mutation ?? 'set',
            c.value
          );
        }

        const parentEntityId = parsePgNumberArray(windowCheck[0].entity_ids)[0] ?? null;
        const canvasEntityId = await ensureCanvasEntity({
          tx: spSql,
          behaviorId,
          organizationId,
          parentEntityId,
          createdBy: (windowCheck[0].created_by as string | null) ?? ctx.userId ?? null,
        });

        try {
          await insertEvent(
            {
              entityIds: canvasEntityId != null ? [canvasEntityId] : [],
              organizationId,
              originId: `canvas_${crypto.randomUUID()}`,
              payloadType: 'json_template',
              payloadData: nextPayload,
              semanticType: 'canvas_state',
              metadata: {
                behavior_id: behaviorId,
                granularity: windowGranularity,
                window_start: windowStart,
                window_end: windowEnd,
                root_event_id: head.rootEventId,
                correction: true,
              },
              occurredAt: windowEnd,
              createdBy: ctx.userId,
              supersedesEventId: head.id,
            },
            { sql: spSql }
          );
        } catch (err) {
          if (isUniqueViolation(err, 'idx_events_superseded_by')) {
            throw new ToolUserError(
              `Canvas for Behavior ${behaviorId} was concurrently updated. Reload the latest state and retry.`,
              409
            );
          }
          throw err;
        }
      });
    } catch (err) {
      // 409 (concurrent edit) aborts the whole transaction — advisory events
      // included — so the caller's retry re-records exactly once. Anything else
      // rolled back to the savepoint only: keep the advisory events.
      if (err instanceof ToolUserError) throw err;
      logger.warn(
        { err, behaviorId, windowId: args.window_id },
        '[submit_feedback] canvas materialization failed (advisory events kept)'
      );
    }

    return ids;
  });

  return {
    action: 'submit_feedback',
    behavior_id: args.behavior_id,
    window_id: args.window_id,
    feedback_ids: feedbackIds,
  };
}

// ============================================
// handleGetFeedback
// ============================================

export async function handleGetFeedback(
  args: ManageBehaviorsArgs,
  ctx: ToolContext
): Promise<ManageBehaviorsResult> {
  if (!args.behavior_id) throw new Error('behavior_id is required');

  const sql = getDb();
  const behaviorId = Number(args.behavior_id);
  const limit = args.limit ?? 50;

  // Scope to the caller's current org so a member of org A can't enumerate feedback for a behavior
  // in org B by passing its behavior_id. Correction-events (P1): read from the events spine
  // (semantic_type='correction'); the feedback id is the event id for current rows,
  // or recovered from origin_id 'wwff_<id>' for historical (pre-3b) rows.
  // created_by is the author user id, or NULL once that user is deleted (events.created_by FK
  // SET NULL) — the dangling-id behavior the retired table had is intentionally not reproduced.
  // A correction's metadata.window_id is the canvas ROOT event id; the
  // canvas_windows view resolves the period (LEFT JOIN — tombstoned roots null).
  const feedback = args.window_id
    ? await sql`
        SELECT COALESCE((substring(e.origin_id from 6))::bigint, e.id) AS id,
               (e.metadata->>'window_id')::bigint AS window_id,
               e.metadata->>'field_path' AS field_path, e.metadata->>'mutation' AS mutation,
               e.metadata->'corrected_value' AS corrected_value, e.metadata->>'note' AS note,
               e.created_by, e.created_at, w.window_start, w.window_end
        FROM events e
        LEFT JOIN canvas_windows w
          ON w.id = (e.metadata->>'window_id')::bigint
        WHERE e.semantic_type = 'correction'
          AND (e.metadata->>'behavior_id')::bigint = ${behaviorId}
          AND (e.metadata->>'window_id')::bigint = ${args.window_id}
          AND e.organization_id = ${ctx.organizationId}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT COALESCE((substring(e.origin_id from 6))::bigint, e.id) AS id,
               (e.metadata->>'window_id')::bigint AS window_id,
               e.metadata->>'field_path' AS field_path, e.metadata->>'mutation' AS mutation,
               e.metadata->'corrected_value' AS corrected_value, e.metadata->>'note' AS note,
               e.created_by, e.created_at, w.window_start, w.window_end
        FROM events e
        LEFT JOIN canvas_windows w
          ON w.id = (e.metadata->>'window_id')::bigint
        WHERE e.semantic_type = 'correction'
          AND (e.metadata->>'behavior_id')::bigint = ${behaviorId}
          AND e.organization_id = ${ctx.organizationId}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `;

  return {
    action: 'get_feedback',
    behavior_id: args.behavior_id,
    feedback: feedback.map((row) => ({
      id: Number(row.id),
      window_id: Number(row.window_id),
      field_path: row.field_path as string,
      mutation: row.mutation as 'set' | 'remove' | 'add',
      corrected_value: row.corrected_value as unknown,
      note: row.note as string | null,
      created_by: row.created_by as string,
      created_at: (row.created_at as Date).toISOString(),
      window_start: row.window_start ? (row.window_start as Date).toISOString() : undefined,
      window_end: row.window_end ? (row.window_end as Date).toISOString() : undefined,
    })),
  };
}

// ============================================
// handleListPromoted
// ============================================

/**
 * List the entities a behavior promoted (its keyed children) — the behavior's
 * durable product. Each row carries the entity's metadata (the extracted
 * field values) plus `field_controls` (which fields a human already owns).
 * The web activity view uses only the count + entity_type for its outputs
 * strip; field ownership/corrections live on the entity page. Promoted
 * children stamp `metadata.behavior_id` / `source='behavior_promotion'` at
 * promotion time.
 *
 * Org-scoped so a member of org A can't enumerate org B's promoted entities by
 * passing a behavior_id (auth also gates on requireBehaviorAccess 'read').
 */
export async function handleListPromoted(
  args: ManageBehaviorsArgs,
  ctx: ToolContext
): Promise<ManageBehaviorsResult> {
  if (!args.behavior_id) throw new Error('behavior_id is required');

  const sql = getDb();
  const behaviorId = String(Number(args.behavior_id));
  const limit = args.limit ?? 200;

  const rows = await sql`
    SELECT e.id, e.name, et.slug AS entity_type, e.metadata, e.field_controls
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${ctx.organizationId}
      AND e.deleted_at IS NULL
      AND e.metadata->>'source' = 'behavior_promotion'
      AND e.metadata->>'behavior_id' = ${behaviorId}
    ORDER BY e.name
    LIMIT ${limit}
  `;

  return {
    action: 'list_promoted',
    behavior_id: args.behavior_id,
    entities: rows.map((row) => {
      const metadata = parseJsonObject(row.metadata);
      const fieldControls = parseJsonObject(row.field_controls);
      const windowIdRaw = metadata.window_id;
      const stableKeyRaw = metadata.stable_key;
      return {
        id: Number(row.id),
        name: row.name as string,
        entity_type: row.entity_type as string,
        metadata,
        field_controls: fieldControls,
        window_id:
          windowIdRaw == null || windowIdRaw === '' ? null : Number(windowIdRaw),
        stable_key: stableKeyRaw == null ? null : String(stableKeyRaw),
      };
    }),
  };
}
