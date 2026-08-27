import { parseJsonObject } from '@lobu/core';

/** Reserved connection-config key written only by an explicit user delete. */
export const DEVICE_AUTOWIRE_SUPPRESSION_KEY =
	'__lobu_device_autowire_suppressed';

export const DEVICE_AUTOWIRE_SUPPRESSION_ERROR =
	'The device auto-wire suppression marker is reserved for connection deletion.';

/**
 * SQL fragment (no bound parameters) that resolves TRUE when the `connections`
 * row aliased `c` belongs to an active device-connector definition: the
 * definition declares a `required_capability` and its selected version carries
 * no compiled or source bytes (a device manifest, or a bundled runtime-only
 * catalog entry). `archiveVanishedDeviceConnectorDefinitions` in
 * `worker-api/device-reconcile.ts` applies the same artifact test inline (once
 * to pick candidates, once to re-check under the UPDATE) but keys off `cd`
 * rather than a `connections` row, so it cannot share this fragment; a change
 * to the artifact test has to land in all three places.
 */
export const IS_DEVICE_CONNECTOR_SQL = /* sql */ `COALESCE((
  SELECT cd.required_capability IS NOT NULL
    AND COALESCE((
      SELECT CASE
        WHEN cv.organization_id IS NOT NULL
          THEN cv.source_path LIKE 'device-manifest://%'
        ELSE cv.source_path IS NOT NULL
          AND cv.compiled_code IS NULL
          AND cv.source_code IS NULL
      END
      FROM connector_versions cv
      WHERE cv.connector_key = cd.key
        AND cv.version = cd.version
        AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
      ORDER BY cv.organization_id NULLS LAST
      LIMIT 1
    ), false)
  FROM connector_definitions cd
  WHERE cd.organization_id = c.organization_id
    AND cd.key = c.connector_key
    AND cd.status = 'active'
  LIMIT 1
), false)`;

export type DeviceAutowireIdentityRow = {
	auth_profile_id: number | string | null;
	app_auth_profile_id: number | string | null;
	/** Owner of the personal org this connection lives in, or null for a shared org. */
	autowire_user_id: string | null;
	is_device_connector: boolean;
};

/**
 * True when the row is exactly what `ensureDeviceConnectorWired` auto-creates:
 * a credential-free connection to an active device connector inside its owner's
 * personal org. A device pin is deliberately NOT required — multi-device
 * auto-wiring leaves the connection unpinned.
 */
export function isDeviceAutowireIdentity(
	row: DeviceAutowireIdentityRow,
): row is DeviceAutowireIdentityRow & { autowire_user_id: string } {
	return (
		row.auth_profile_id == null &&
		row.app_auth_profile_id == null &&
		row.autowire_user_id != null &&
		row.is_device_connector
	);
}

/** The marker patch a delete merges into the tombstoned row's config. */
export const DEVICE_AUTOWIRE_SUPPRESSION_PATCH: Record<string, unknown> = {
	[DEVICE_AUTOWIRE_SUPPRESSION_KEY]: true,
};

export function hasDeviceAutowireSuppressionMarker(config: unknown): boolean {
	return Object.hasOwn(
		parseJsonObject(config),
		DEVICE_AUTOWIRE_SUPPRESSION_KEY,
	);
}
