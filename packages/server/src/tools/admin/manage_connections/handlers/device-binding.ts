/**
 * Shared helpers for device-worker binding resolution and managed-connector detection.
 */

import { getDb } from '../../../../db/client';
import { getPrimaryAuthProfileForKind } from '../../../../utils/auth-profiles';
import type { ScopedConnectorDefinitionRow } from '../../../../catalog/connector-definitions';

// ============================================
// Managed-connector detection (public-org delegation)
// ============================================

/**
 * Is this connect happening against a MANAGED connector in a PUBLIC org?
 *
 * Managed connectors live in a `visibility='public'` org with a managed
 * org-level `oauth_app` profile (the client secret stays in the cloud). When a
 * member connects one here, the resulting connection must be CONSENT-ONLY: it
 * holds the OAuth grant for delegation (the local instance fetches a fresh
 * access token at runtime via /oauth/connection-token) but has NO feeds, so the
 * cloud never syncs a copy — the managed connector's data lives only on the
 * member's local instance.
 *
 * Signal (the cleanest available, no new schema): the org is public AND the
 * connector resolves to an org-level managed `oauth_app` profile for the OAuth
 * method's provider. We only mark consent-only on the OAuth path — env-key /
 * browser connectors aren't delegated this way.
 */
export async function isManagedPublicOrgConnect(params: {
  organizationId: string;
  connectorKey: string;
  provider: string;
}): Promise<boolean> {
  const sql = getDb();
  const orgRows = (await sql`
    SELECT visibility FROM "organization" WHERE id = ${params.organizationId} LIMIT 1
  `) as unknown as Array<{ visibility: string | null }>;
  if (orgRows[0]?.visibility !== 'public') return false;

  const managedApp = await getPrimaryAuthProfileForKind({
    organizationId: params.organizationId,
    connectorKey: params.connectorKey,
    profileKind: 'oauth_app',
    provider: params.provider,
  });
  return !!managedApp && managedApp.status === 'active';
}

// ============================================
// Device-worker binding resolution
// ============================================

/**
 * Validate + normalize a connection's device-worker binding (the "Run on"
 * target). Returns the resolved id (or `null` = serverless, in the Lobu server) or an error string.
 *
 *  - A connector that declares `required_capability` MUST be pinned to a device,
 *    and that device must currently advertise the capability.
 *  - Any other connector may optionally be pinned to a device (run-on-device).
 *  - The requester may only pin a device they own, and only into the workspace
 *    that device is attached to (device_workers.organization_id).
 */
export async function resolveDeviceBinding(params: {
  organizationId: string;
  userId: string | null | undefined;
  connector: ScopedConnectorDefinitionRow;
  deviceWorkerId: string | null | undefined;
}): Promise<{ error: string } | { deviceWorkerId: string | null }> {
  const sql = getDb();
  const requiredCapability = params.connector.required_capability ?? null;
  const deviceWorkerId = params.deviceWorkerId?.trim() || null;

  if (!deviceWorkerId) {
    if (requiredCapability) {
      return {
        error: `Connector '${params.connector.key}' runs on a device — pass device_worker_id for one of your devices attached to this workspace that advertises the '${requiredCapability}' permission.`,
      };
    }
    return { deviceWorkerId: null };
  }

  const rows = (await sql`
    SELECT dw.id, dw.user_id, dw.capabilities, dw.label, dw.organization_id
    FROM device_workers dw
    WHERE dw.id = ${deviceWorkerId}
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    user_id: string;
    capabilities: unknown;
    label: string | null;
    organization_id: string | null;
  }>;
  const device = rows[0];
  if (!device) {
    return { error: `Device worker '${deviceWorkerId}' not found.` };
  }
  if (!params.userId || device.user_id !== params.userId) {
    return { error: `You can only pin a device you own.` };
  }
  if (device.organization_id !== params.organizationId) {
    return {
      error: `Device '${device.label ?? deviceWorkerId}' isn't attached to this workspace. Re-attach it from the Devices page first.`,
    };
  }

  if (requiredCapability) {
    const caps = Array.isArray(device.capabilities) ? (device.capabilities as string[]) : [];
    if (!caps.includes(requiredCapability)) {
      return {
        error: `Device '${device.label ?? deviceWorkerId}' hasn't granted the '${requiredCapability}' permission required by '${params.connector.key}'.`,
      };
    }
  }

  return { deviceWorkerId };
}
