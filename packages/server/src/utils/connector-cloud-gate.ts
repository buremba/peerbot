
export type ConnectorCloudAvailability =
  | { allowed: true }
  | { allowed: false; reason: 'cloud_restricted'; message: string };

/**
 * Connectors that open arbitrary outbound TCP (raw database sockets) and have no
 * tenant-supplied-URL egress hardening yet — resolve-then-pin IP, DNS-rebinding
 * guard, forced TLS, link-local/metadata + internal-CIDR blocking. Such a
 * connector is first-party / self-hosted only until its hardening lands, and
 * must NOT be installable by untrusted multi-tenant cloud tenants (plan §G).
 *
 * The set is currently EMPTY — it stays as the kill-switch/holding pen for
 * future warehouse connectors (Snowflake, BigQuery) until each ships its own
 * hardening. `postgres` graduated: its egress guard (db-egress-guard.ts)
 * classifies + rejects internal/metadata hosts under `block-private`, pins the
 * socket to the validated IP (DNS-rebind closed), and forces TLS. A per-org
 * destination allowlist is deliberately deferred as an enterprise policy
 * feature — block-private + pin + TLS is the platform boundary.
 */
export const CLOUD_RESTRICTED_CONNECTOR_KEYS: ReadonlySet<string> = new Set([]);

/**
 * Connectors that open a raw tenant-supplied DB socket and rely on the
 * connector-worker subprocess enforcing `block-private` egress (resolve-then-pin
 * IP, DNS-rebind guard, forced TLS, internal/metadata blocking). In cloud mode a
 * FLEET worker may only CLAIM a run for one of these connectors if it advertises
 * the `db_egress_hardening` capability — i.e. it is running the worker code that
 * folds in the gateway's authoritative `db_egress_policy`. This closes the
 * rolling-deploy gap where a NEW gateway could hand a claimed `postgres` run to
 * an OLD worker that ignores the policy and reopens private-IP/plaintext egress.
 *
 * Self-hosted (isCloudMode() false) is unaffected — the run is claimable by any
 * worker. An EMPTY set is a no-op. Future warehouse connectors (snowflake,
 * bigquery) join this set when they ship their own worker-side hardening.
 */
export const DB_EGRESS_HARDENED_CONNECTOR_KEYS: ReadonlySet<string> = new Set(['postgres']);

export function getConnectorCloudAvailability(
  _connectorKey: string | null | undefined
): ConnectorCloudAvailability {
  return { allowed: true };
}

/**
 * Connectors are allowed in Cloud mode; security is enforced by the Isolate sandbox.
 */
export function assertConnectorAllowedInCloud(_connectorKey: string | null | undefined): void {
  // Permitted in Cloud mode.
}
