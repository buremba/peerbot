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
 * CRITICAL: the guard itself must be bounded. It does a single iterative
 * traversal (explicit stack, no recursion) that enforces depth, node-count, and
 * an approximate byte budget *together*, bailing the instant any limit is
 * crossed. It never calls `JSON.stringify` on the whole value — doing so would
 * itself be the DoS for a deeply-nested or huge input. The traversal visits at
 * most `maxNodes` values, never descends past `maxDepth`, and stops accumulating
 * bytes the moment `maxBytes` is exceeded, so it runs in O(min(nodes, maxNodes))
 * time with bounded stack and cannot itself be exploited.
 */

interface MetadataLimits {
  /** Maximum nesting depth (object/array levels) before bailing. */
  maxDepth: number;
  /** Maximum number of values visited (keys + array elements) before bailing. */
  maxNodes: number;
  /** Maximum approximate size in UTF-8 bytes (keys + primitive values). */
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
 *   256 KiB is comfortably above any honest payload. We accumulate an
 *   approximate byte count during the same traversal (key + primitive value
 *   lengths) and bail as soon as it is crossed — no full serialization pass.
 */
export const DEFAULT_METADATA_LIMITS: MetadataLimits = {
  maxDepth: 32,
  maxNodes: 10_000,
  maxBytes: 262_144,
};

/**
 * Approximate UTF-8 byte size of a primitive JSON value. Used to accumulate a
 * running byte budget cheaply during traversal without serializing the whole
 * structure. Strings dominate real payloads; numbers/booleans/null contribute a
 * small constant. This is an estimate (it ignores quotes/commas/braces), but it
 * only needs to be order-of-magnitude accurate to gate a 256 KiB ceiling.
 *
 * For strings we first compare the cheap UTF-16 length against the remaining
 * budget: a UTF-8 byte count is always >= the UTF-16 code-unit count, so if the
 * code-unit length already blows the budget we reject without paying for a full
 * `Buffer.byteLength` scan of a multi-megabyte attacker string.
 */
function primitiveByteSize(
  value: string | number | boolean | null,
  remainingBudget: number
): number {
  if (typeof value === 'string') {
    if (value.length > remainingBudget) {
      // Lower bound already exceeds the budget — no need to measure exactly.
      return value.length;
    }
    return Buffer.byteLength(value, 'utf8');
  }
  // number / boolean / null — bounded constant.
  return String(value).length;
}

/**
 * Allocation-free emptiness check for a plain object. `Object.keys(o).length`
 * materializes the whole key array just to test for zero — a needless O(keys)
 * allocation on untrusted input. `for...in` with the first own key short-circuits.
 */
export function isEmptyObject(o: Record<string, unknown>): boolean {
  for (const key in o) {
    if (Object.hasOwn(o, key)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns true if `value` exceeds any of the given limits.
 *
 * Single iterative pass enforcing all three limits together; returns true the
 * moment any is crossed. See the file header for why this is itself bounded.
 */
export function exceedsValidationLimits(
  value: unknown,
  limits: MetadataLimits = DEFAULT_METADATA_LIMITS
): boolean {
  const { maxDepth, maxNodes, maxBytes } = limits;

  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  let visited = 0;
  let bytes = 0;

  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: stack.length > 0 guards this.
    const { node, depth } = stack.pop()!;

    // Depth is checked first and before any per-node work, so a pathologically
    // deep chain bails immediately at maxDepth rather than being traversed.
    if (depth > maxDepth) {
      return true;
    }

    if (node === null || typeof node !== 'object') {
      // Primitive: count toward the byte budget. `undefined` carries no JSON
      // weight (it's dropped on serialize/persist), so skip it; everything else
      // (string/number/boolean/null) contributes.
      if (node !== undefined) {
        bytes += primitiveByteSize(
          node as string | number | boolean | null,
          maxBytes - bytes
        );
        if (bytes > maxBytes) {
          return true;
        }
      }
      continue;
    }

    const childDepth = depth + 1;

    if (Array.isArray(node)) {
      // Count each element as we go, bailing the moment maxNodes is crossed —
      // never materializing a derived array of the children.
      for (const child of node) {
        if (++visited > maxNodes) {
          return true;
        }
        if (child !== null && typeof child === 'object') {
          stack.push({ node: child, depth: childDepth });
        } else {
          bytes += primitiveByteSize(
            child as string | number | boolean | null,
            maxBytes - bytes
          );
          if (bytes > maxBytes) {
            return true;
          }
        }
      }
      continue;
    }

    // Plain object: iterate own enumerable keys with `for...in` so we never
    // allocate an Object.entries/keys array up front for an attacker with huge
    // fan-out — each key is counted incrementally and we bail at the first
    // limit crossed.
    const obj = node as Record<string, unknown>;
    for (const key in obj) {
      if (!Object.hasOwn(obj, key)) {
        continue;
      }
      if (++visited > maxNodes) {
        return true;
      }
      bytes += primitiveByteSize(key, maxBytes - bytes);
      if (bytes > maxBytes) {
        return true;
      }
      const child = obj[key];
      if (child !== null && typeof child === 'object') {
        stack.push({ node: child, depth: childDepth });
      } else {
        bytes += primitiveByteSize(
          child as string | number | boolean | null,
          maxBytes - bytes
        );
        if (bytes > maxBytes) {
          return true;
        }
      }
    }
  }

  return false;
}
