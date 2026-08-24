import type { DbClient } from '../db/client';
import {
  type DeviceConnectorSource,
  getDeviceManifestSourcesForUser,
} from './device-manifests';

/**
 * One derived readiness model for manifest-backed device connectors.
 *
 * Nothing here is persisted. The worker's latest manifest, capabilities and
 * heartbeat remain the only facts; feeds, operations and source reads consume
 * this same projection so a permission change cannot produce three different
 * answers.
 */
export type DeviceConnectorReadinessState =
  | 'ready'
  | 'setup_required'
  | 'device_offline';

export interface DeviceConnectorReadiness {
  state: DeviceConnectorReadinessState;
  source: DeviceConnectorSource;
}

export interface DeviceConnectorReadinessTarget {
  ownerUserId: string | null;
  connectorKey: string;
}

export type DeviceConnectorReadinessIndex = Map<
  string,
  DeviceConnectorReadiness
>;

function readinessKey(ownerUserId: string, connectorKey: string): string {
  return `${ownerUserId}\u0000${connectorKey}`;
}

export function classifyDeviceConnectorReadiness(
  source: DeviceConnectorSource,
): DeviceConnectorReadiness {
  if (source.onlineAdvertiserDeviceIds.length > 0) {
    return { state: 'ready', source };
  }
  if (source.onlineManifestDeviceIds.length > 0) {
    return { state: 'setup_required', source };
  }
  return { state: 'device_offline', source };
}

/** Load each owner's manifest inventory once, then index the requested targets. */
export async function loadDeviceConnectorReadiness(params: {
  sql: DbClient;
  targets: readonly DeviceConnectorReadinessTarget[];
}): Promise<DeviceConnectorReadinessIndex> {
  const targets = params.targets.filter(
    (
      target,
    ): target is DeviceConnectorReadinessTarget & { ownerUserId: string } =>
      typeof target.ownerUserId === 'string' && target.ownerUserId.length > 0,
  );
  const requested = new Set(
    targets.map((target) =>
      readinessKey(target.ownerUserId, target.connectorKey),
    ),
  );
  const ownerUserIds = [
    ...new Set(targets.map((target) => target.ownerUserId)),
  ];
  const sourcesByOwner = await Promise.all(
    ownerUserIds.map(async (ownerUserId) => ({
      ownerUserId,
      sources: await getDeviceManifestSourcesForUser({
        sql: params.sql,
        userId: ownerUserId,
      }),
    })),
  );

  const readiness = new Map<string, DeviceConnectorReadiness>();
  for (const { ownerUserId, sources } of sourcesByOwner) {
    for (const source of sources) {
      const key = readinessKey(ownerUserId, source.key);
      if (requested.has(key))
        readiness.set(key, classifyDeviceConnectorReadiness(source));
    }
  }
  return readiness;
}

export function findDeviceConnectorReadiness(
  index: DeviceConnectorReadinessIndex,
  target: DeviceConnectorReadinessTarget,
): DeviceConnectorReadiness | undefined {
  if (!target.ownerUserId) return undefined;
  return index.get(readinessKey(target.ownerUserId, target.connectorKey));
}

export function describeDeviceConnectorSetupRequired(
  readiness: DeviceConnectorReadiness,
): string {
  return (
    `${readiness.source.metadata.name} is available on an online device, but setup is incomplete: ` +
    `'${readiness.source.requiredCapability}' has not been granted. ` +
    'Open the paired device app, finish setup, then retry.'
  );
}
