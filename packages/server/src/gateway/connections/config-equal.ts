/**
 * Stable canonical JSON serialization: object keys sorted recursively so two
 * structurally-equal configs serialize identically regardless of key insertion
 * order. Arrays preserve order (order is significant for things like scope
 * lists). Used by `configsEqual` to deep-compare nested config (Discord/Teams
 * OAuth blocks, scope arrays) — a shallow `!==` compares nested objects by
 * reference and never sees a changed inner field, so a stale config would
 * persist without restarting the adapter (and, conversely, an identical config
 * re-submitted as a fresh object would spuriously look "changed").
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(
          (value as Record<string, unknown>)[key]
        )}`
    );
  return `{${entries.join(",")}}`;
}

/**
 * Deep structural equality for plain config objects (nested-aware, key-order
 * independent). Shared by `ChatInstanceManager` (decides whether to restart an
 * adapter) and the agent-config update route (decides whether an update is a
 * noop). These two MUST agree: the route used to use a shallow compare, which
 * over-reported changes for nested config and triggered spurious restarts.
 */
export function configsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return stableStringify(a) === stableStringify(b);
}
