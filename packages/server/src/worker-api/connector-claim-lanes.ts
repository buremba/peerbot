import type { DbClient } from '../db/client';
import { pgTextArray } from '../db/client';
import { isCloudMode } from '../utils/cloud-mode';
import { DB_EGRESS_HARDENED_CONNECTOR_KEYS } from '../utils/connector-cloud-gate';
import {
  delegatedBrowserAffinitySql,
  legacyNonManifestConnectorSql,
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
  /** Capacity advertised for each execution backend by this worker. */
  backendCapacity?: Record<string, number>;
}

/** A backend is claimable only when this poll explicitly advertises capacity. */
export function hasPositiveBackendCapacity(
  capacity: Record<string, number> | undefined,
  backend: string
): boolean {
  return Number.isFinite(capacity?.[backend]) && (capacity?.[backend] ?? 0) > 0;
}

interface ConnectorClaimLaneRefs {
  connectorKey: SqlFragment;
  connectorVersion: SqlFragment;
  organizationId: SqlFragment;
  activationKind: SqlFragment;
  activatedAt: SqlFragment;
  connectionDeviceWorkerId: SqlFragment;
  pinPlatform: SqlFragment;
  runRequiredCapability: SqlFragment;
  runManifestBacked: SqlFragment;
  runManifestHash: SqlFragment;
  runArtifactSourcePath: SqlFragment;
  runArtifactCompiledCode: SqlFragment;
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
        AND auth_item->>'runtimeExecution' = 'daemon_builtin'
    )
  `;
  const exactNativeBridgeAuthorization = sql`
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${sql.json(context.manifestClaimAuthorizations)}::jsonb) auth_item
      WHERE auth_item->>'connectorKey' = ${refs.connectorKey}
        AND auth_item->>'connectorVersion' = ${refs.connectorVersion}
        AND auth_item->>'manifestHash' = ${refs.runManifestHash}
        AND auth_item->>'sourcePath' = ${refs.runArtifactSourcePath}
        AND auth_item->>'runtimeExecution' = 'bridge'
    )
  `;
  const delegatedBrowserAffinity = delegatedBrowserAffinitySql(sql, {
    platform: refs.pinPlatform,
    connectorKey: refs.connectorKey,
    connectorVersion: refs.connectorVersion,
    manifestBacked: refs.runManifestBacked,
    artifactSourcePath: refs.runArtifactSourcePath,
  });
  // During a manifest-to-compiled cutover the active definition can still
  // advertise its former device capability. The selected artifact is the
  // execution truth: fleet workers do not advertise browser/OS capabilities,
  // so a non-manifest legacy artifact must not inherit that stale gate.
  const legacyFleetArtifact = legacyNonManifestConnectorSql(sql, {
    connectorKey: refs.connectorKey,
    manifestBacked: refs.runManifestBacked,
    artifactCompiledCode: refs.runArtifactCompiledCode,
  });
  // A worker may be able to run the daemon-owned backend while its connector
  // compiler/SDK runtime is unavailable. Never let a compiled artifact enter
  // any claim lane unless that backend was explicitly advertised as ready.
  const compiledBackendReady = hasPositiveBackendCapacity(context.backendCapacity, 'compiled_connector');
  const daemonBuiltinReady = hasPositiveBackendCapacity(context.backendCapacity, 'daemon_builtin');
  // Keep this guard outside the individual lanes: every lane must advertise
  // the backend that the selected artifact actually needs. Historical
  // manifest artifacts have no run_runtime, so daemon_builtin is derived only
  // from the exact retained authorization above; unknown headless artifacts
  // therefore fail closed.
  const selectedBackendReady = sql`
    (
      (
        NOT COALESCE(${refs.runManifestBacked}, false)
        AND ${compiledBackendReady}
      )
      OR (
        COALESCE(${refs.runManifestBacked}, false)
        AND (
          (
            ${refs.runRuntime}->>'execution' = 'daemon_builtin'
            AND ${daemonBuiltinReady}
          )
          OR ${refs.runRuntime}->>'execution' = 'bridge'
          OR (
            ${refs.runRuntime} IS NULL
            AND (${exactDaemonBuiltinAuthorization})
            AND ${daemonBuiltinReady}
          )
          OR (
            ${refs.runRuntime} IS NULL
            AND (${exactNativeBridgeAuthorization})
          )
        )
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
          OR (${legacyFleetArtifact})
        )
        -- The empty capability match is the anonymous fleet lane. A legacy
        -- whatsapp.local row must still have a runnable selected artifact;
        -- otherwise it would be claimed and fail only after becoming running.
        AND (
          NOT (${refs.connectorKey} = ANY(
            ${pgTextArray(['whatsapp.local'])}::text[]
          ))
          OR (${legacyFleetArtifact})
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
        AND (
          (
            COALESCE(${refs.runManifestBacked}, false)
            AND (${manifestAuthorization})
          )
          OR (
            NOT COALESCE(${refs.runManifestBacked}, false)
            AND NOT (${legacyFleetArtifact})
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
        AND ${refs.connectionDeviceWorkerId} = ${context.deviceWorkerId}::uuid
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
