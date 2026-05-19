/**
 * Best-effort JSON serializer for pre-tool arguments. Tool args can contain:
 *   - BigInt values -- native JSON.stringify throws ("Do not know how to
 *     serialize a BigInt")
 *   - Circular refs (object graphs, accidentally) -- throws
 *     "TypeError: Converting circular structure to JSON"
 *   - Functions / symbols / undefined at the TOP level -- JSON.stringify
 *     returns `undefined` (not a string!), or throws for a top-level symbol
 *
 * If a guardrail throws (sync or async), the runner logs and treats it as a
 * pass -- that quietly disables pii-scan / inline judges in exactly the
 * case where the input is weird enough to deserve closer inspection. So we
 * never throw from extraction, AND we never return a non-string -- callers
 * downstream invoke `.match(...)` on the result, which would throw if we
 * handed back `undefined`.
 *
 * Per-call cycle tracking via a fresh WeakSet so concurrent calls don't see
 * each other's nodes.
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
  let result: string | undefined;
  try {
    result = JSON.stringify(value, replacer);
  } catch {
    // Either a top-level symbol, an exotic host object the replacer didn't
    // catch, or JSON.stringify threw before reaching us.
    return "<unserializable>";
  }
  // `JSON.stringify(undefined)`, `JSON.stringify(()=>{})`, and similar
  // top-level non-serializable primitives return `undefined`, not a string.
  // Downstream code calls `.match()` / template-string interpolation on the
  // result, so we MUST hand back a string. Defensive `typeof` guard in case
  // the engine ever hands us something else.
  if (typeof result !== "string") return "<unserializable>";
  return result;
}
