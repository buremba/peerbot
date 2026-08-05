/**
 * Argument sanitizer behind the GENERIC audit summary fields (`args_sha256`,
 * `args_preview_redacted`). `run_sdk` and `query_sql` build their own payloads
 * and never reach it; every other tool does — including `query_sdk`, which is
 * summarized here AND separately retains its verbatim request.
 *
 * Contract: a generic entry persists the SHAPE of a call plus the parts of it
 * that are provably not caller content. Concretely, a leaf survives only when
 *
 *   - it is a boolean, null, or undefined (one bit / absence — structural), or
 *   - it sits at the TOP level under a key the tool's own input schema
 *     declares, AND the schema constrains that key to a closed set of literals
 *     (`const` / `enum` / a union of them), AND the value is a member of that
 *     set.
 *
 * The membership test is what makes the second case safe. Audit fires on
 * FAILED validation too, so an `action`-typed key can arrive carrying arbitrary
 * pasted text; comparing against the declared set means the retained value is
 * always one of N compile-time constants from our own schema, never something
 * the caller authored. A single non-literal branch anywhere in a key's schema
 * (e.g. a bare `Type.String()` in one union variant) collapses that key back to
 * name-only, because then no closed set exists to check against — as does any
 * composition we do not parse, since every tool schema is TypeBox and TypeBox
 * emits unions as `anyOf`.
 *
 * Everything else — free text, identifiers, numbers, nested objects — becomes
 * the sentinel. Identifier-shaped secrets (`sk-live-…`) are indistinguishable
 * from slugs, so no shape heuristic is applied. Repeated sentinel keys merge;
 * that collapse is part of recording shape, not content.
 */

import { REDACTED_SENTINEL } from '@lobu/core';

/** A closed set of declared literals, or null when the key is unconstrained. */
type DeclaredValues = Set<string | number> | null;

interface SchemaLike {
  properties?: Record<string, unknown>;
  anyOf?: unknown[];
  const?: unknown;
  enum?: unknown[];
}

function asSchema(value: unknown): SchemaLike | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as SchemaLike)
    : null;
}

/** Literal kinds worth retaining. Booleans and null survive on their own path. */
function isRetainableLiteral(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * The closed set of values a property schema allows, or null when it admits
 * anything (a plain string/number/object, or a union with one such branch).
 */
function literalValues(schema: unknown): DeclaredValues {
  const node = asSchema(schema);
  if (!node) return null;
  if (node.const !== undefined) {
    return isRetainableLiteral(node.const) ? new Set([node.const]) : null;
  }
  if (Array.isArray(node.enum)) {
    return node.enum.every(isRetainableLiteral)
      ? new Set(node.enum as Array<string | number>)
      : null;
  }
  const branches = node.anyOf;
  if (!Array.isArray(branches) || branches.length === 0) return null;
  const merged = new Set<string | number>();
  for (const branch of branches) {
    const values = literalValues(branch);
    // One open branch means the key is not literal-constrained after all.
    if (!values) return null;
    for (const value of values) merged.add(value);
  }
  return merged;
}

/**
 * Top-level keys the tool declares, mapped to their closed value set (null when
 * unconstrained). Union-schema tools (`Type.Union` of per-action variants)
 * expose their properties under `anyOf`, so variants are walked as well as the
 * root; a key declared by several variants keeps the union of their literals,
 * and drops to null the moment any variant leaves it open.
 */
function declaredArgShape(schema: unknown): Map<string, DeclaredValues> {
  const shape = new Map<string, DeclaredValues>();
  const root = asSchema(schema);
  if (!root) return shape;
  const variants = [root, ...(root.anyOf ?? []).map(asSchema)];
  for (const variant of variants) {
    if (!variant?.properties) continue;
    for (const [key, propSchema] of Object.entries(variant.properties)) {
      const values = literalValues(propSchema);
      if (!shape.has(key)) {
        shape.set(key, values);
        continue;
      }
      const existing = shape.get(key);
      if (existing == null || values == null) {
        shape.set(key, null);
        continue;
      }
      for (const value of values) existing.add(value);
    }
  }
  return shape;
}

function sanitizeLeaves(
  value: unknown,
  shape: ReadonlyMap<string, DeclaredValues>,
  topLevel: boolean
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLeaves(item, shape, false));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        const declared = topLevel && shape.has(key);
        const allowed = declared ? shape.get(key) : null;
        const retained =
          allowed && isRetainableLiteral(nested) && allowed.has(nested)
            ? nested
            : sanitizeLeaves(nested, shape, false);
        return [declared ? key : REDACTED_SENTINEL, retained];
      })
    );
  }
  if (typeof value === 'boolean' || value === null || value === undefined) return value;
  return REDACTED_SENTINEL;
}

/** Sanitize a generic tool call's args against the tool's own input schema. */
export function sanitizeAuditArgs(
  args: Record<string, unknown> | null | undefined,
  schema: unknown
): unknown {
  return sanitizeLeaves(args ?? {}, declaredArgShape(schema), true);
}
