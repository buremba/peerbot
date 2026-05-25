/**
 * Read `LOBU_CLOUD_MODE` from the env. Truthy values (`1`, `true`, `yes`,
 * case-insensitive) enable cloud-mode guardrails that don't apply to
 * self-hosters running the same gateway in a single-tenant install — e.g.
 * rejecting Telegram polling mode, and refusing to re-anchor an anonymous
 * worker poll to an existing device owner.
 *
 * Re-read on every call so a process (or test harness) can flip the flag
 * without a restart. All call sites are cold-path, so caching isn't worth it.
 */
export function isCloudMode(): boolean {
  const raw = process.env.LOBU_CLOUD_MODE;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
