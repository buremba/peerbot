import { isCloudMode } from './cloud-mode';

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

export function getConnectorCloudAvailability(
  connectorKey: string | null | undefined
): ConnectorCloudAvailability {
  if (connectorKey && CLOUD_RESTRICTED_CONNECTOR_KEYS.has(connectorKey) && isCloudMode()) {
    return {
      allowed: false,
      reason: 'cloud_restricted',
      message: `The '${connectorKey}' connector is not available on Lobu Cloud yet — it requires a self-hosted or single-tenant deployment. Reach out for enterprise database connectivity.`,
    };
  }
  return { allowed: true };
}

/**
 * Hard gate: throw when an org tries to create/use a cloud-restricted connector
 * while the gateway runs in multi-tenant cloud mode. Self-hosted (isCloudMode()
 * false) is unaffected — the operator's DATABASE_URL is a trusted secret.
 */
export function assertConnectorAllowedInCloud(connectorKey: string | null | undefined): void {
  const availability = getConnectorCloudAvailability(connectorKey);
  if (!availability.allowed) throw new Error(availability.message);
}
