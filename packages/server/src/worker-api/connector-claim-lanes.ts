import { EXECUTION_BACKENDS } from '@lobu/core/contracts/worker/protocol';
import type { DbClient } from '../db/client';
import { pgTextArray } from '../db/client';
import { isCloudMode } from '../utils/cloud-mode';
import { DB_EGRESS_HARDENED_CONNECTOR_KEYS } from '../utils/connector-cloud-gate';
import {
  delegatedBrowserAffinitySql,
  chromeNamespaceConnectorSql,
} from '../utils/connector-execution-placement';
import type { ManifestClaimAuthorization } from './device-manifests';

type SqlFragment = ReturnType<DbClient>;

export interface ConnectorClaimContext {
  isUserScopedWorker: boolean;
  deviceWorkerId: string | null;
  workerPlatform: string | null;
  authorizedCapabilities: string[];
  capabilityMatchSet: string[];
  /** Successfully reconciled winning manifest identities advertised by this exact device. */
  manifestClaimAuthorizations: ManifestClaimAuthorization[];
  /** Legacy clients without connector_manifests may claim only hashless, platform-matching artifacts. */
  allowLegacyManifestCapabilityClaims: boolean;
  orgScopeIds: string[];
  baseOrgScopeIds: string[];
  workerHardensDbEgress: boolean;
  /**
   * Capacity advertised for each execution backend by this worker. Required:
   * an omitted map reads as zero capacity for every backend, so the worker
   * claims nothing at all and nothing anywhere reports why.
   */
  backendCapacity: Record<string, number>;
}

/** A backend is claimable only when this poll explicitly advertises capacity. */
function hasPositiveBackendCapacity(
  capacity: Record<string, number>,
  backend: string
): boolean {
  const value = capacity[backend];
  return typeof value === 'number' && value > 0;
}

interface ConnectorClaimLaneRefs {
  connectorKey: SqlFragment;
  connectorVersion: SqlFragment;
  organizationId: SqlFragment;
  activationKind: SqlFragment;
  activatedAt: SqlFragment;
  connectionDeviceWorkerId: SqlFragment;
  runTargetDeviceWorkerId?: SqlFragment;
  pinPlatform: SqlFragment;
  runRequiredCapability: SqlFragment;
  runManifestBacked: SqlFragment;
  runManifestHash: SqlFragment;
  runArtifactSourcePath: SqlFragment;
  runRuntime: SqlFragment;
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
  const exactManifestAuthorization = sql`
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        ${sql.json(context.manifestClaimAuthorizations)}::jsonb
      ) auth_item
      WHERE auth_item->>'connectorKey' = ${refs.connectorKey}
        AND auth_item->>'connectorVersion' = ${refs.connectorVersion}
        AND auth_item->>'manifestHash' = ${refs.runManifestHash}
        AND auth_item->>'sourcePath' = ${refs.runArtifactSourcePath}
    )
  `;
  const legacyHashlessManifestAuthorization = sql`
    ${context.allowLegacyManifestCapabilityClaims}
    AND ${refs.runManifestHash} IS NULL
    AND ${refs.runRequiredCapability} IS NOT NULL
    AND ${refs.runRequiredCapability} = ANY(
      ${pgTextArray(context.authorizedCapabilities)}::text[]
    )
    -- A legacy capability poll may retain the pre-bridge metadata-only
    -- contract, but it must never authorize a bridge execution. A
    -- hash-attested historical artifact has no active definition runtime, so
    -- it still requires the exact retained manifest authorization above.
    AND COALESCE(${refs.runRuntime}->>'execution', '') <> 'bridge'
    AND (
      NOT COALESCE(${refs.runManifestBacked}, false)
      OR ${refs.runRuntime} IS NOT NULL
    )
    AND ${context.workerPlatform ?? ''}::text NOT IN ('headless', 'chrome-extension')
    AND COALESCE(
      ${refs.runRuntime}->'platforms' ? ${context.workerPlatform ?? ''}::text,
      false
    )
  `;
  const manifestAuthorization = sql`
    (${exactManifestAuthorization})
    OR (${legacyHashlessManifestAuthorization})
  `;
  const exactDaemonBuiltinAuthorization = sql`
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${sql.json(context.manifestClaimAuthorizations)}::jsonb) auth_item
      WHERE auth_item->>'connectorKey' = ${refs.connectorKey}
        AND auth_item->>'connectorVersion' = ${refs.connectorVersion}
        AND auth_item->>'manifestHash' = ${refs.runManifestHash}
        AND auth_item->>'sourcePath' = ${refs.runArtifactSourcePath}
        AND auth_item->>'runtimeExecution' = ${EXECUTION_BACKENDS.daemonBuiltin}
    )
  `;
  const delegatedBrowserAffinity = delegatedBrowserAffinitySql(sql, {
    platform: refs.pinPlatform,
    connectorKey: refs.connectorKey,
  });
  // A worker may be able to run the daemon-owned backend while its connector
  // compiler/SDK runtime is unavailable. Never let a compiled artifact enter
  // any claim lane unless that backend was explicitly advertised as ready.
  const compiledBackendReady = hasPositiveBackendCapacity(
    context.backendCapacity,
    EXECUTION_BACKENDS.compiledConnector
  );
  const daemonBuiltinReady = hasPositiveBackendCapacity(
    context.backendCapacity,
    EXECUTION_BACKENDS.daemonBuiltin
  );
  // A chrome-namespace execution runs inside the advertising extension, so it
  // needs no server-side backend at all.
  const chromeNamespaceExecution = chromeNamespaceConnectorSql(sql, {
    connectorKey: refs.connectorKey,
  });
  // Keep this guard outside the individual lanes: every lane must advertise
  // the backend that the selected artifact actually needs. A manifest-backed
  // artifact executes on the device that advertised the manifest, so the only
  // server-side backend it can need is the daemon-owned one. Historical
  // manifest artifacts carry no run_runtime, so daemon_builtin is derived from
  // the exact retained authorization; an unrecognised execution kind fails
  // closed rather than inheriting the unrestricted branch.
  const selectedBackendReady = sql`
    (
      ${chromeNamespaceExecution}
      OR (
        NOT COALESCE(${refs.runManifestBacked}, false)
        AND ${compiledBackendReady}
      )
      OR (
        COALESCE(${refs.runManifestBacked}, false)
        AND CASE
          WHEN ${refs.runRuntime}->>'execution' = ${EXECUTION_BACKENDS.daemonBuiltin} THEN ${daemonBuiltinReady}
          WHEN ${refs.runRuntime}->>'execution' = 'bridge' THEN true
          WHEN ${refs.runRuntime}->>'execution' IS NULL
            THEN NOT (${exactDaemonBuiltinAuthorization}) OR ${daemonBuiltinReady}
          ELSE false
        END
      )
    )
  `;

  return sql`
    (
      ${selectedBackendReady}
      AND (
        -- Trusted/anonymous fleet worker. Execution-pinned connections stay on
        -- their exact device; browser-affinity parent runs stay on fleet.
        (
          ${!context.isUserScopedWorker}
          AND (
            COALESCE(${refs.runRequiredCapability}, '') = ANY(
              ${pgTextArray(context.capabilityMatchSet)}::text[]
            )
          )
          AND NOT COALESCE(${refs.runManifestBacked}, false)
          AND (
            ${!isCloudMode()}
            OR ${context.workerHardensDbEgress}
            OR NOT (${refs.connectorKey} = ANY(${dbEgressHardenedKeys}::text[]))
          )
          AND (
            (${pageActivated})
            OR ${refs.connectionDeviceWorkerId} IS NULL
            OR (
              ${delegatedBrowserAffinity}
            )
          )
        )
        -- User-scoped worker claiming an unpinned capability connector in its
        -- base org scope. Page-activated work is handled by the fleet parent.
        OR (
          ${context.isUserScopedWorker}
          AND ${refs.connectionDeviceWorkerId} IS NULL
          AND (${refs.runTargetDeviceWorkerId ?? sql`NULL`}::uuid IS NULL)
          AND (
            (
              COALESCE(${refs.runManifestBacked}, false)
              AND (${manifestAuthorization})
            )
            OR (
              NOT COALESCE(${refs.runManifestBacked}, false)
              AND ${refs.runRequiredCapability} IS NOT NULL
              AND ${refs.runRequiredCapability} = ANY(
                ${pgTextArray(context.authorizedCapabilities)}::text[]
              )
            )
          )
          AND NOT COALESCE(${pageActivated}, false)
          AND ${refs.organizationId} = ANY(${pgTextArray(context.baseOrgScopeIds)}::text[])
        )
        -- Exact execution pin. A chrome-extension pin on a connector that does
        -- not execute natively in the extension is delegated browser affinity,
        -- so its parent connector work stays on fleet instead.
        OR (
          ${context.isUserScopedWorker}
          AND ${context.deviceWorkerId}::uuid IS NOT NULL
          AND COALESCE(${refs.runTargetDeviceWorkerId ?? sql`NULL`}::uuid, ${refs.connectionDeviceWorkerId}) = ${context.deviceWorkerId}::uuid
          AND (
            NOT COALESCE(${refs.runManifestBacked}, false)
            OR (${manifestAuthorization})
          )
          AND NOT COALESCE(${pageActivated}, false)
          AND (
            ${refs.runRequiredCapability} IS NULL
            OR ${refs.runRequiredCapability} = ANY(
              ${pgTextArray(context.authorizedCapabilities)}::text[]
            )
          )
          AND ${refs.organizationId} = ANY(${pgTextArray(context.orgScopeIds)}::text[])
          AND NOT (${delegatedBrowserAffinity})
        )
      )
    )
  `;
}
