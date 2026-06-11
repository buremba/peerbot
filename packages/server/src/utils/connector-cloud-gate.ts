import { isCloudMode } from './cloud-mode';

/**
 * Connectors that open arbitrary outbound TCP (raw database sockets) and have no
 * tenant-supplied-URL egress hardening yet — resolve-then-pin IP, DNS-rebinding
 * guard, link-local/metadata + internal-CIDR blocking. They are first-party /
 * self-hosted only until that hardening lands, and must NOT be installable by
 * untrusted multi-tenant cloud tenants (plan §G). Snowflake/BigQuery join this
 * set when they ship.
 */
export const CLOUD_RESTRICTED_CONNECTOR_KEYS: ReadonlySet<string> = new Set([
  'postgres',
]);

/**
 * Hard gate: throw when an org tries to create/use a cloud-restricted connector
 * while the gateway runs in multi-tenant cloud mode. Self-hosted (isCloudMode()
 * false) is unaffected — the operator's DATABASE_URL is a trusted secret.
 */
export function assertConnectorAllowedInCloud(connectorKey: string | null | undefined): void {
  if (connectorKey && CLOUD_RESTRICTED_CONNECTOR_KEYS.has(connectorKey) && isCloudMode()) {
    throw new Error(
      `The '${connectorKey}' connector is not available on Lobu Cloud yet — it requires a self-hosted or single-tenant deployment. Reach out for enterprise database connectivity.`
    );
  }
}
