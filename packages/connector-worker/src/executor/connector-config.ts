/**
 * Runtime config merge shared by every executor lane.
 *
 * Lives in its own side-effect-free module so the host can build the merged
 * config and hand it to the guest without importing the executor.
 */

/**
 * Keys the trusted gateway sets on `job.env` that a tenant's connection/feed
 * `job.config` must NEVER be able to override. Normal precedence is
 * config-wins (a connector's config legitimately shadows ambient env), but a
 * security control injected by the gateway is authoritative. `job.env` carries
 * trusted deployment controls while `job.config` is tenant-supplied, so merge
 * config over env and then re-assert these keys from env.
 *
 * `LOBU_DB_EGRESS_POLICY`: the DB egress boundary (private-IP block + IP pin +
 * forced TLS). The in-process paths already inject it last into `job.config`
 * (feed-sync / connector-pushdown); the out-of-process worker delivers it via
 * `job.env`, and this is where it must beat tenant config.
 *
 * `LOBU_DB_EGRESS_ALLOW_HOSTS`: operator-owned exceptions to that boundary,
 * delivered through the same authoritative paths.
 */
const GATEWAY_AUTHORITATIVE_CONFIG_KEYS = [
  'LOBU_DB_EGRESS_POLICY',
  'LOBU_DB_EGRESS_ALLOW_HOSTS',
] as const;

/**
 * Merge the connector's runtime config with config-wins precedence for normal
 * keys, but force the gateway's authoritative security keys to win. Used at
 * every executor entry point so a tenant-controlled config cannot downgrade a
 * gateway-injected control (e.g. flipping block-private → allow-private).
 */
export function buildConnectorConfig(job: {
  env?: Record<string, string | undefined>;
  config?: Record<string, unknown>;
}): Record<string, unknown> {
  const env = job.env ?? {};
  const config = job.config ?? {};
  const merged: Record<string, unknown> = { ...env, ...config };
  for (const key of GATEWAY_AUTHORITATIVE_CONFIG_KEYS) {
    if (key in env && env[key] !== undefined) merged[key] = env[key];
  }
  return merged;
}
