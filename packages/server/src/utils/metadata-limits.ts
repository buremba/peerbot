/**
 * Bounded input guard for untrusted metadata.
 *
 * Entity/event metadata arrives from agent tool calls and the public REST
 * surface, so it is attacker-controllable. Before handing it to AJV for JSON
 * Schema validation we reject anything pathologically deep, wide, or large.
 * This is a defense-in-depth DoS guard: even though the AJV instance used for
 * these paths runs with `allErrors: false` (fail-fast), validating a giant or
 * deeply-nested object still costs CPU/memory proportional to the input, and a
 * malformed schema could amplify it. Bounding the input first caps that cost.
 *
 * CRITICAL: the guard itself must be bounded. The traversal is iterative (an
 * explicit stack, no recursion) and bails the instant any limit is crossed, so
 * the guard can never become the DoS it defends against — it visits at most
 * `maxNodes` nodes and never descends past `maxDepth`.
 */

export interface MetadataLimits {
  /** Maximum nesting depth (object/array levels) before bailing. */
  maxDepth: number;
  /** Maximum number of values visited (keys + array elements) before bailing. */
  maxNodes: number;
  /** Maximum serialized size in UTF-8 bytes. */
  maxBytes: number;
}

/**
 * Default limits for untrusted metadata.
 *
 * - maxDepth 32: legitimate entity/event metadata is shallow (a handful of
 *   nested objects); 32 is generous headroom while staying far below the call
 *   stack / AJV recursion danger zone.
 * - maxNodes 10_000: a real metadata blob has tens to low-hundreds of fields;
 *   10k caps adversarial fan-out (e.g. 10k sibling keys crafted to maximize
 *   AJV error allocation) without rejecting any plausible payload.
 * - maxBytes 262_144 (256 KiB): metadata is descriptive, not bulk storage;
 *   256 KiB is comfortably above any honest payload and the byte check is the
 *   cheap first gate (one JSON.stringify) that short-circuits huge inputs
 *   before any traversal.
 */
export const DEFAULT_METADATA_LIMITS: MetadataLimits = {
  maxDepth: 32,
  maxNodes: 10_000,
  maxBytes: 262_144,
};

/**
 * Returns true if `value` exceeds any of the given limits.
 *
 * The traversal is iterative and short-circuits: it stops and returns true as
 * soon as a limit is crossed, visiting at most `maxNodes` values and never
 * recording a frame deeper than `maxDepth`. This guarantees the guard runs in
 * O(min(nodes, maxNodes)) time and bounded stack, so it cannot itself be a DoS.
 */
export function exceedsValidationLimits(
  value: unknown,
  limits: MetadataLimits = DEFAULT_METADATA_LIMITS
): boolean {
  const { maxDepth, maxNodes, maxBytes } = limits;

  // Cheap first gate: serialized size. A single pass that short-circuits huge
  // payloads before any structural traversal. Unserializable values (cycles,
  // BigInt) throw — treat those as exceeding limits since they can't be
  // validated or persisted anyway.
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return true;
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return true;
  }

  // Iterative depth/node-count traversal with an explicit stack.
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  let visited = 0;

  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: stack.length > 0 guards this.
    const { node, depth } = stack.pop()!;

    if (depth > maxDepth) {
      return true;
    }

    if (node === null || typeof node !== 'object') {
      continue;
    }

    const children = Array.isArray(node) ? node : Object.values(node);
    visited += children.length;
    if (visited > maxNodes) {
      return true;
    }

    const childDepth = depth + 1;
    for (const child of children) {
      // Only push container children — primitives are counted above and need
      // no further traversal, keeping the stack small.
      if (child !== null && typeof child === 'object') {
        stack.push({ node: child, depth: childDepth });
      }
    }
  }

  return false;
}
