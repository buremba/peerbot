/**
 * Single chokepoint for tool-arg validation (lobu#1137).
 *
 * Tool handlers are wrapped with `withValidatedArgs` at their definition
 * (`defineActionTool`) or export site, so every entry path — executeTool
 * (MCP + REST), direct REST handler calls, and the sandbox SDK namespaces —
 * runs the same coerce-then-validate pipeline. This is deliberately a leaf
 * module (typebox + errors only): the registry imports tool modules which
 * import the sandbox namespaces, so anything heavier here would close an
 * import cycle.
 *
 * Coercion before validation (`Value.Convert`) is load-bearing: the callers
 * of this boundary are LLMs and external MCP clients,
 * and the historical failure class was round-trip type drift (a list action
 * returns `watcher_id` as a number, the update schema gates on Type.String —
 * see #1131). Coercing `123` → `"123"` and `"5"` → `5` makes that whole
 * class a non-issue instead of a per-tool audit.
 */

import type { TSchema } from '@sinclair/typebox';
import { FormatRegistry } from '@sinclair/typebox';
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { ToolUserError } from '../utils/errors';

// typebox's Value.Check FAILS (returns false) on any `format` constraint that
// isn't registered — there is no permissive default. `manage_schedules` gates
// ids with `format: 'uuid'`, so without this registration every pause/cancel
// would 400 the moment validation runs.
if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

interface SchemaWithVariants {
  anyOf?: Array<{ properties?: { action?: { const?: unknown } } }>;
}

/**
 * For a `Type.Union` of per-action variants, validation must dispatch on the
 * `action` literal and check ONLY the matched variant: the schema advertised
 * to MCP clients is the FLATTENED union (registry `flattenUnionSchema`), so a
 * call that is valid against the advertised schema can carry fields from any
 * variant — naive full-union checking would reject it, and TypeBox's union
 * errors ("Expected union value") name no field anyway.
 */
function unionVariants(schema: TSchema): TSchema[] | null {
  const anyOf = (schema as SchemaWithVariants).anyOf;
  if (!Array.isArray(anyOf) || anyOf.length === 0) return null;
  if (!anyOf.every((v) => v.properties?.action?.const !== undefined)) return null;
  return anyOf as unknown as TSchema[];
}

function actionOf(variant: TSchema): string {
  return String(
    (variant as { properties?: { action?: { const?: unknown } } }).properties?.action?.const
  );
}

/**
 * Normalize in-process arg values to their wire (JSON) equivalents before
 * coercion. Wire callers can only send JSON, but direct callers (REST param
 * builders, sandbox namespaces, tests feeding a tool's output back into its
 * input) pass richer values that JSON.stringify would have flattened:
 *
 * - Keys with `undefined` values mean "absent" and are dropped —
 *   `Value.Convert` would wrap an explicitly-undefined Optional(Array) key
 *   into `[undefined]` and fail validation. Array ELEMENTS are not dropped;
 *   an `undefined` element is a genuine caller bug and must fail.
 * - `Date` instances become ISO strings — e.g. read_knowledge returns
 *   `occurred_at` as a Date and its own cursor inputs
 *   (`before_occurred_at`) are Type.String; the list→page round trip must
 *   survive validation.
 */
function normalizeArgs(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeArgs);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) out[k] = normalizeArgs(v);
      }
      return out;
    }
  }
  return value;
}

const compiledCache = new Map<TSchema, TypeCheck<TSchema>>();

function compileSchema(schema: TSchema): TypeCheck<TSchema> {
  let compiled = compiledCache.get(schema);
  if (!compiled) {
    compiled = TypeCompiler.Compile(schema);
    compiledCache.set(schema, compiled);
  }
  return compiled;
}

function checkAgainst(toolName: string, schema: TSchema, args: unknown): unknown {
  // Convert returns a coerced copy — the handler must receive it, otherwise
  // coercion would satisfy the validator but the handler would still see the
  // raw value. Deliberately NO `Value.Default`: schema `default:` annotations
  // are client-facing documentation, and handlers apply their own defaults
  // via `??`. Materializing them here changes behavior — e.g. read_knowledge
  // declares `sort_by: { default: 'score' }` while its include_superseded
  // path requires sort_by to be UNSET; injecting the default broke it.
  const coerced = Value.Convert(schema, normalizeArgs(args));
  const validator = compileSchema(schema);
  if (validator.Check(coerced)) return coerced;

  // Deduplicate by path — TypeBox emits both `Expected required property` and
  // `Expected <type>` against the same missing field, which would otherwise
  // duplicate the field name in the error message.
  const seen = new Set<string>();
  const errs: string[] = [];
  for (const e of validator.Errors(coerced)) {
    const path = e.path || '/';
    if (seen.has(path)) continue;
    seen.add(path);
    errs.push(`${path}: ${e.message}`);
    if (errs.length >= 3) break;
  }
  throw new ToolUserError(`Invalid arguments for ${toolName}: ${errs.join('; ')}`);
}

/**
 * Validate (and coerce) `args` against a tool's TypeBox input schema.
 * Returns the value the handler must receive. Throws `ToolUserError` (400)
 * naming the offending fields on mismatch.
 */
export function validateToolArgs(toolName: string, schema: TSchema, args: unknown): unknown {
  const variants = unionVariants(schema);
  if (variants) {
    const action =
      args && typeof args === 'object' ? (args as Record<string, unknown>).action : undefined;
    const variant = variants.find((v) => actionOf(v) === action);
    if (!variant) {
      const actions = variants.map(actionOf).join(', ');
      throw new ToolUserError(
        `Invalid arguments for ${toolName}: action must be one of: ${actions} (got ${JSON.stringify(action)})`
      );
    }
    return checkAgainst(toolName, variant, args);
  }
  return checkAgainst(toolName, schema, args);
}

const VALIDATED_BRAND = Symbol.for('lobu.validated-tool-handler');

interface BrandedHandler {
  [VALIDATED_BRAND]?: string;
}

/** The tool name a handler was wrapped for, or undefined if unwrapped. */
export function validatedToolName(handler: unknown): string | undefined {
  return (handler as BrandedHandler)?.[VALIDATED_BRAND];
}

/**
 * Wrap a tool handler so its first argument is coerced + validated against
 * `schema` before the handler runs. Signature-preserving: remaining params
 * are forwarded untouched, so it fits both the registry `(args, env, ctx)`
 * shape and divergent ones like `listOrganizations`. Compiles eagerly — a
 * schema TypeCompiler can't handle must explode at module load, not silently
 * skip validation at call time.
 */
export function withValidatedArgs<A, R extends unknown[], T>(
  toolName: string,
  schema: TSchema,
  handler: (args: A, ...rest: R) => Promise<T>
): (args: A, ...rest: R) => Promise<T> {
  for (const s of unionVariants(schema) ?? [schema]) {
    compileSchema(s);
  }
  // `async` so a validation failure REJECTS the returned promise instead of
  // throwing synchronously — callers (`await`, `.rejects`, .catch chains)
  // treat tool handlers as promise-returning and a sync throw would escape
  // them.
  const wrapped = async (args: A, ...rest: R): Promise<T> =>
    handler(validateToolArgs(toolName, schema, args) as A, ...rest);
  (wrapped as BrandedHandler)[VALIDATED_BRAND] = toolName;
  return wrapped;
}
