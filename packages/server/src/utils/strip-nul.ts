/**
 * Postgres text/jsonb columns cannot contain NUL (0x00): a string carrying one
 * raises unsupported-Unicode-escape (jsonb) or invalid-UTF8-0x00 (text).
 * External connector data (LinkedIn/Twitter takeout rows, browser scrapes)
 * routinely carries stray NULs, so every write boundary that persists worker-
 * or connector-supplied JSON must strip them first.
 *
 * stripNul handles one string; stripNulDeep walks plain objects/arrays (keys
 * included) and is the reusable chokepoint. Class instances and Dates pass
 * through untouched so callers do not lose prototype behavior.
 */
export const stripNul = (str: string): string =>
  str.indexOf("\u0000") === -1 ? str : str.replace(/\u0000/g, "");

export function stripNulDeep(value: unknown): unknown {
  if (typeof value === "string") return stripNul(value);
  if (Array.isArray(value)) return value.map(stripNulDeep);
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[stripNul(k)] = stripNulDeep(v);
      }
      return out;
    }
  }
  return value;
}
