/**
 * Shared entity field-merge primitive for the watcher<->human feedback loop.
 *
 * The value lives in `entities.metadata`; per-field ownership lives in the sparse
 * `entities.field_controls` jsonb column (a key present = that field is human-owned).
 * This is the SINGLE write path for both human edits and watcher promotion:
 *   - source='human'  : writes every changed field AND marks it owned (note/set_by/set_at).
 *   - source='watcher': writes only fields that are NOT human-owned; owned fields are
 *     returned in `blocked` (the caller emits an approval) and never overwritten.
 *
 * The risky decision logic is the pure `computeFieldMerge` — unit-tested without a DB.
 * `mergeEntityFields` is the thin DB wrapper: it locks the entity row FOR UPDATE inside
 * the caller's transaction, applies the merge, and persists metadata + field_controls
 * atomically. Callers own the audit `'change'` event (handleUpdate / promotion emit it).
 */

import type { DbClient } from '../db/client';

export type FieldWriteSource = 'human' | 'watcher';

/** Per-field ownership marker stored under entities.field_controls[field]. */
export interface FieldControl {
  note?: string | null;
  set_by?: string | null;
  set_at?: string;
}

export interface AppliedChange {
  old: unknown;
  new: unknown;
}
export interface BlockedChange {
  current: unknown;
  proposed: unknown;
}
export interface StaleChange {
  /** The live value the proposal was based on (proposal.current snapshot). */
  expected: unknown;
  /** The value actually in metadata now — a human moved it since the proposal. */
  live: unknown;
}

export interface FieldMergeResult {
  /** Fields whose value changed and were written to metadata. */
  applied: Record<string, AppliedChange>;
  /** Owned fields a watcher tried to change — NOT written; surface as an approval. */
  blocked: Record<string, BlockedChange>;
  /** Fields skipped because the live value drifted from the proposal's snapshot
   *  (a human re-edited the field after the proposal was queued). NOT written. */
  stale: Record<string, StaleChange>;
  /** Fields whose CURRENT value a human affirmed — value unchanged, but ownership
   *  is now claimed so a watcher can't silently overwrite it. */
  affirmed: string[];
  nextMetadata: Record<string, unknown>;
  nextControls: Record<string, FieldControl>;
  changed: boolean;
}

/** Order-insensitive value comparison for change detection. */
function sameValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Pure merge decision. Given the current metadata + ownership controls, decide which
 * proposed `fields` get applied vs blocked, and produce the next metadata/controls.
 * No DB, no I/O — the unit-tested heart of the feedback loop's correctness.
 */
export function computeFieldMerge(args: {
  metadata: Record<string, unknown>;
  controls: Record<string, FieldControl>;
  fields: Record<string, unknown>;
  source: FieldWriteSource;
  actorId: string | null;
  note: string | null;
  nowIso: string;
  /** When provided (deferred apply of a queued proposal), each field is written only
   *  if its live metadata value still equals the snapshot the proposal was built on.
   *  A drifted field is skipped (`stale`) so a stale approval can't clobber a value
   *  the human moved after the proposal was queued. */
  expectedCurrent?: Record<string, unknown> | null;
  /** Fields (source='human' only) whose CURRENT value the human approves as-is:
   *  no value change, but ownership is claimed so a watcher can't later overwrite
   *  it without an approval. This is the "approve" half of the per-item recap
   *  feedback loop — affirming a value is NOT a no-op the way re-setting an
   *  unchanged value is. */
  affirm?: string[];
}): FieldMergeResult {
  const { metadata, controls, fields, source, actorId, note, nowIso, expectedCurrent, affirm } =
    args;
  const nextMetadata: Record<string, unknown> = { ...metadata };
  const nextControls: Record<string, FieldControl> = { ...controls };
  const applied: Record<string, AppliedChange> = {};
  const blocked: Record<string, BlockedChange> = {};
  const stale: Record<string, StaleChange> = {};
  const affirmed: string[] = [];

  for (const [field, value] of Object.entries(fields)) {
    const current = metadata[field];
    const owned = Object.hasOwn(controls, field);

    // Deferred-apply staleness guard: the human re-edited the field after this
    // proposal was queued, so the proposal is based on an outdated value — skip it.
    if (expectedCurrent && Object.hasOwn(expectedCurrent, field)) {
      if (!sameValue(current, expectedCurrent[field])) {
        stale[field] = { expected: expectedCurrent[field] ?? null, live: current ?? null };
        continue;
      }
    }

    // A watcher must never overwrite a human-owned field — propose instead.
    if (source === 'watcher' && owned) {
      if (!sameValue(current, value)) {
        blocked[field] = { current: current ?? null, proposed: value };
      }
      continue;
    }

    if (sameValue(current, value)) continue;

    applied[field] = { old: current ?? null, new: value };
    nextMetadata[field] = value;
    // A human edit claims ownership of the field it sets.
    if (source === 'human') {
      nextControls[field] = { note, set_by: actorId, set_at: nowIso };
    }
  }

  // Approve/affirm: claim ownership of a field's current value without changing
  // it. Only humans can affirm; a field already written above is skipped (the
  // set already claimed it). Marking an owned-but-unchanged field is idempotent
  // (it refreshes set_by/set_at/note), so re-approving is safe.
  if (source === 'human' && affirm) {
    for (const field of affirm) {
      if (Object.hasOwn(applied, field)) continue;
      if (!Object.hasOwn(metadata, field)) continue;
      nextControls[field] = { note, set_by: actorId, set_at: nowIso };
      affirmed.push(field);
    }
  }

  return {
    applied,
    blocked,
    stale,
    affirmed,
    nextMetadata,
    nextControls,
    changed: Object.keys(applied).length > 0 || affirmed.length > 0,
  };
}

/**
 * DB wrapper: lock the entity row in the caller's transaction, apply the merge, and
 * persist metadata + field_controls atomically. Returns applied/blocked so the caller
 * can emit the audit event (human path) or the approval interactions (watcher path).
 */
export async function mergeEntityFields(params: {
  tx: DbClient;
  entityId: number;
  fields: Record<string, unknown>;
  source: FieldWriteSource;
  /** User id for a human edit; null/system otherwise. */
  actorId: string | null;
  note?: string | null;
  /** Snapshot the proposal was built on (deferred-apply staleness guard). */
  expectedCurrent?: Record<string, unknown> | null;
  /** Fields (human source) whose current value is approved as-is, claiming
   *  ownership without a value change. */
  affirm?: string[];
}): Promise<FieldMergeResult> {
  const { tx, entityId, fields, source, actorId } = params;

  const rows = await tx<{ metadata: unknown; field_controls: unknown }>`
    SELECT metadata, field_controls FROM entities
    WHERE id = ${entityId} AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new Error(`Entity ${entityId} not found`);
  }

  const metadata = parseJsonObject(rows[0].metadata);
  const controls = parseJsonObject(rows[0].field_controls) as Record<string, FieldControl>;

  const merge = computeFieldMerge({
    metadata,
    controls,
    fields,
    source,
    actorId,
    note: params.note ?? null,
    nowIso: new Date().toISOString(),
    expectedCurrent: params.expectedCurrent ?? null,
    affirm: params.affirm,
  });

  if (merge.changed) {
    await tx`
      UPDATE entities
      SET metadata = ${tx.json(merge.nextMetadata)},
          field_controls = ${tx.json(merge.nextControls)},
          updated_at = current_timestamp
      WHERE id = ${entityId}
    `;
  }

  return merge;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}
