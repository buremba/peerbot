import type { DbClient } from '../db/client';
import { pgTextArray } from '../db/client';
import { isCloudMode } from '../utils/cloud-mode';
import { DB_EGRESS_HARDENED_CONNECTOR_KEYS } from '../utils/connector-cloud-gate';

type SqlFragment = ReturnType<DbClient>;

export interface ConnectorClaimContext {
  isUserScopedWorker: boolean;
  deviceWorkerId: string | null;
  authorizedCapabilities: string[];
  capabilityMatchSet: string[];
  orgScopeIds: string[];
  baseOrgScopeIds: string[];
  workerHardensDbEgress: boolean;
}

interface ConnectorClaimLaneRefs {
  runType: SqlFragment;
  connectorKey: SqlFragment;
  organizationId: SqlFragment;
  activationKind: SqlFragment;
  activatedAt: SqlFragment;
  connectionDeviceWorkerId: SqlFragment;
  pinPlatform: SqlFragment;
  requiredCapability: SqlFragment;
}

/**
 * Shared connector-run claim predicate. worker-api/poll.ts uses it to claim
 * queued connector work; check-due-feeds.ts applies the same predicate to a
 * prospective scheduled sync before creating its run. Keep every fleet,
 * capability, device-pin, browser-affinity, and DB-egress decision here so a
 * scheduler-admitted sync is claimable by the poller that materialized it.
 */
export function connectorClaimLaneSql(
  sql: DbClient,
  context: ConnectorClaimContext,
  refs: ConnectorClaimLaneRefs
): SqlFragment {
  const dbEgressHardenedKeys = pgTextArray([...DB_EGRESS_HARDENED_CONNECTOR_KEYS]);
  const pageActivated = sql`
    ${refs.activationKind} = 'page_visit'
    AND ${refs.activatedAt} IS NOT NULL
  `;

  return sql`
    (
      -- Trusted/anonymous fleet worker. Execution-pinned connections stay on
      -- their exact device; browser-affinity parent runs stay on fleet.
      (
        ${!context.isUserScopedWorker}
        AND COALESCE(${refs.requiredCapability}, '') = ANY(
          ${pgTextArray(context.capabilityMatchSet)}::text[]
        )
        AND (
          ${!isCloudMode()}
          OR ${context.workerHardensDbEgress}
          OR NOT (${refs.connectorKey} = ANY(${dbEgressHardenedKeys}::text[]))
        )
        AND (
          (${pageActivated})
          OR ${refs.connectionDeviceWorkerId} IS NULL
          OR (
            ${refs.pinPlatform} = 'chrome-extension'
            AND ${refs.runType} IN ('sync', 'auth', 'embed_backfill')
            AND ${refs.connectorKey} NOT LIKE 'chrome%'
          )
        )
      )
      -- User-scoped worker claiming an unpinned capability connector in its
      -- base org scope. Page-activated work is handled by the fleet parent.
      OR (
        ${context.isUserScopedWorker}
        AND ${refs.requiredCapability} IS NOT NULL
        AND ${refs.requiredCapability} = ANY(
          ${pgTextArray(context.authorizedCapabilities)}::text[]
        )
        AND ${refs.connectionDeviceWorkerId} IS NULL
        AND NOT COALESCE(${pageActivated}, false)
        AND ${refs.organizationId} = ANY(${pgTextArray(context.baseOrgScopeIds)}::text[])
      )
      -- Exact execution pin. A chrome-extension pin on a non-chrome parent is
      -- browser affinity, so sync/auth/embed_backfill stay on fleet instead.
      OR (
        ${context.isUserScopedWorker}
        AND ${context.deviceWorkerId}::uuid IS NOT NULL
        AND ${refs.connectionDeviceWorkerId} = ${context.deviceWorkerId}::uuid
        AND NOT COALESCE(${pageActivated}, false)
        AND (
          ${refs.requiredCapability} IS NULL
          OR ${refs.requiredCapability} = ANY(
            ${pgTextArray(context.authorizedCapabilities)}::text[]
          )
        )
        AND ${refs.organizationId} = ANY(${pgTextArray(context.orgScopeIds)}::text[])
        AND NOT (
          ${refs.pinPlatform} = 'chrome-extension'
          AND ${refs.runType} IN ('sync', 'auth', 'embed_backfill')
          AND ${refs.connectorKey} NOT LIKE 'chrome%'
        )
      )
    )
  `;
}
