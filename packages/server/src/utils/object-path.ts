/**
 * Read a nested value from an object using a dot-notation path.
 *
 * Returns `undefined` when any segment is missing or a non-object is
 * encountered along the way.
 *
 * @example
 * getValueAtPath({ a: { b: 1 } }, 'a.b') // 1
 * getValueAtPath({ a: {} }, 'a.b.c')     // undefined
 */
export function getValueAtPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    // `segment in current` (not bare bracket access) so a missing key stops
    // traversal deterministically — matches the original keyed lookup and
    // avoids surprises on sparse arrays / absent intermediates.
    if (!(segment in (current as Record<string, unknown>))) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
