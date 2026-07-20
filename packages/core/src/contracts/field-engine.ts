/**
 * Schema-driven editable-field engine.
 *
 * A create/update MCP tool used to restate every editable field by hand in
 * ~7 places (the create write, the update guards, the update write, the
 * applied-check, the proposal build, the pre-image capture, the proposal→args
 * remap). Adding a field meant editing all of them — and forgetting one is the
 * exact bug class behind silently-dropped fields.
 *
 * Instead, the Typebox contract schema is the single source of truth: each
 * editable property carries an `x-lobu-field` annotation, and this engine reads
 * those annotations to drive create / update / proposal / pre-image uniformly.
 * Add a field once (annotate it in the schema) and every path picks it up.
 *
 * This module is pure and DB-agnostic — it decides WHICH fields participate and
 * HOW the update/proposal/pre-image bookkeeping folds, but the caller supplies
 * the actual read/write closures (which touch the DB) via a binding table. Core
 * therefore stays free of server/DB imports.
 */

import type { TObject, TSchema } from "@sinclair/typebox";

/**
 * Per-field metadata carried on a Typebox property as `x-lobu-field`. `store`
 * distinguishes where the value lives so the caller's binding can route the
 * write (an `agents` column vs. the settings row's `models[0]`, etc.).
 * `emptyClears` marks a field whose empty-string input means "reset to default"
 * rather than "write empty".
 */
export interface LobuFieldMeta {
  /** Logical storage location; interpreted by the caller's binding table. */
  store: string;
  /** True when an empty-string value means "clear back to default". */
  emptyClears?: boolean;
}

/** A schema property paired with its `x-lobu-field` metadata. */
export interface LobuField {
  key: string;
  meta: LobuFieldMeta;
}

const FIELD_KEYWORD = "x-lobu-field";

/**
 * Collect the editable fields of a Typebox object schema in declaration order —
 * i.e. every property annotated with `x-lobu-field`. Properties without the
 * annotation (e.g. `action`, `agent_id`) are control/identity args, not
 * editable content, and are skipped.
 */
export function collectLobuFields(schema: TObject): LobuField[] {
  const out: LobuField[] = [];
  for (const [key, prop] of Object.entries(schema.properties)) {
    const meta = (prop as TSchema & Record<string, unknown>)[FIELD_KEYWORD] as
      | LobuFieldMeta
      | undefined;
    if (meta && typeof meta.store === "string") {
      out.push({ key, meta });
    }
  }
  return out;
}

/**
 * The fields an incoming args object actually requests to change: those present
 * (`!== undefined`) among the schema's editable fields. `args` is the flat MCP
 * argument object; `read` extracts a field's value from it.
 */
export function requestedFields(
  fields: LobuField[],
  args: Record<string, unknown>
): LobuField[] {
  return fields.filter((f) => args[f.key] !== undefined);
}
