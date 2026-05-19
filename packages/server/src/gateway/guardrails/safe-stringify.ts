/**
 * Best-effort JSON serializer for pre-tool arguments. Tool args can contain:
 *   - BigInt values -- native JSON.stringify throws ("Do not know how to
 *     serialize a BigInt")
 *   - Circular refs (object graphs, accidentally) -- throws
 *     "TypeError: Converting circular structure to JSON"
 *   - Functions / symbols -- silently dropped by JSON.stringify, harmless
 *
 * If a guardrail throws (sync or async), the runner logs and treats it as a
 * pass -- that quietly disables pii-scan / inline judges in exactly the
 * case where the input is weird enough to deserve closer inspection. So we
 * never throw from extraction; on any failure we fall back to the
 * placeholder string so downstream regex / judge logic still runs (and the
 * regex won't match a literal "<unserializable>" anyway, so this fails
 * "no PII detected" which the operator can spot via guardrail audit logs).
 *
 * Per-call cycle tracking via a fresh WeakSet so concurrent calls don't see
 * each other's nodes -- a module-level WeakSet would never get pruned
 * within a single call either (we'd still need to clear between calls).
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, v: unknown): unknown => {
    if (typeof v === "bigint") {
      return v.toString();
    }
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "<circular>";
      seen.add(v);
    }
    return v;
  };
  try {
    return JSON.stringify(value, replacer);
  } catch {
    // Either an exotic host object the replacer didn't catch, or
    // JSON.stringify threw before reaching us. Either way, swallow so the
    // guardrail doesn't fail-open.
    return "<unserializable>";
  }
}
