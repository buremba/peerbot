/// True iff `host` is a loopback address — accepts everything in `127.0.0.0/8`,
/// `::1`, `[::1]`, IPv4-mapped IPv6 loopback (`::ffff:127.x.y.z`), and the
/// literal `localhost`. Case-insensitive on the host portion.
///
/// Used by both `start-local.ts` and `server.ts` to enforce that
/// `LOBU_NO_AUTH=1` only ever serves on a loopback bind — refusing to start
/// when a production deployment accidentally has the env set.
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(h)) return true;
  if (/^::ffff:127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(h)) return true;
  return false;
}
