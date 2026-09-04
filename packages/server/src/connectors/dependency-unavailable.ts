/**
 * Internal marker for connector failures caused by a temporarily unavailable
 * execution dependency. Workers already round-trip connector error strings, so
 * this stays server-local rather than widening the public worker/SDK protocol.
 */
const PREFIX = "[lobu:dependency_unavailable:";

export function dependencyUnavailableError(reason: string, message: string): string {
  return `${PREFIX}${reason}] ${message}`;
}

export function parseDependencyUnavailableError(
  value: string | null | undefined
): { reason: string; message: string } | null {
  if (!value?.startsWith(PREFIX)) return null;
  const end = value.indexOf("] ", PREFIX.length);
  if (end < 0) return null;
  const reason = value.slice(PREFIX.length, end).trim();
  if (!reason) return null;
  return { reason, message: value.slice(end + 2) };
}
