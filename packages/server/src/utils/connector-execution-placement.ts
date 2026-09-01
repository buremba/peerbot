import { pgTextArray } from '../db/client';

interface SqlTag<TFragment> {
  (strings: TemplateStringsArray, ...values: any[]): TFragment;
}

/**
 * Legacy connector identities that execute natively on a Chrome-extension
 * worker. Keep this list exact: these keys sit outside the reserved `chrome`
 * namespace, so adding one changes a Chrome pin from delegated browser
 * affinity into an execution pin.
 */
export const LEGACY_NATIVE_CHROME_EXTENSION_CONNECTORS: Readonly<
  Record<string, { requiredCapability: string }>
> = {
  'whatsapp.local': { requiredCapability: 'browser.whatsapp' },
};

export const LEGACY_NATIVE_CHROME_EXTENSION_CONNECTOR_KEYS = Object.keys(
  LEGACY_NATIVE_CHROME_EXTENSION_CONNECTORS
);

const LEGACY_NATIVE_CHROME_EXTENSION_CONNECTOR_KEY_SET: ReadonlySet<string> = new Set(
  LEGACY_NATIVE_CHROME_EXTENSION_CONNECTOR_KEYS
);

export function isLegacyNativeChromeExtensionConnectorKey(connectorKey: string): boolean {
  return LEGACY_NATIVE_CHROME_EXTENSION_CONNECTOR_KEY_SET.has(connectorKey);
}

export function legacyNativeChromeExtensionRequiredCapability(
  connectorKey: string
): string | null {
  return LEGACY_NATIVE_CHROME_EXTENSION_CONNECTORS[connectorKey]?.requiredCapability ?? null;
}

export function isChromeNamespaceConnectorKey(connectorKey: string): boolean {
  return connectorKey === 'chrome' || connectorKey.startsWith('chrome.');
}

/** Every `chrome.*` artifact identity the extension serves natively. */
export const DEVICE_MANIFEST_SOURCE_PREFIX = 'device-manifest://chrome-extension/';

/**
 * The reserved `chrome.*` namespace declares "the Owletto extension implements
 * this natively", and {@link isNativeChromeExtensionConnector} short-circuits
 * on it. A key installed there with supplied code is therefore unreachable in
 * both directions: the gateway withholds `compiled_code` from a native
 * connector, and the extension has no handler for a key it does not implement,
 * so every run dies with
 *
 *   Owletto for Chrome: unknown dispatch (connector='chrome.whatsapp', ...)
 *
 * Reject it at install instead of at first run. A connector that needs its own
 * code delivered belongs on an ordinary key with a `chrome-extension` platform
 * pin, which routes it through {@link isDelegatedBrowserAffinityConnector}.
 */
export function assertChromeNamespaceInstallIsDeviceManifest(facts: {
  connectorKey: string;
  sourcePath: string | null | undefined;
}): void {
  if (!isChromeNamespaceConnectorKey(facts.connectorKey)) return;
  if (facts.sourcePath?.startsWith(DEVICE_MANIFEST_SOURCE_PREFIX) === true) return;
  throw new Error(
    `Connector key '${facts.connectorKey}' is in the reserved 'chrome.*' namespace, which is ` +
      'only installable from an Owletto device manifest. A connector that ships its own code ' +
      'cannot live there: the gateway withholds the bundle from a native connector and the ' +
      'extension cannot dispatch a key it does not implement. Use a key outside the namespace ' +
      'and pin the connection to a chrome-extension device for browser access.'
  );
}

export function isLegacyNonManifestConnector(facts: {
  connectorKey: string;
  manifestBacked: boolean;
}): boolean {
  return (
    isLegacyNativeChromeExtensionConnectorKey(facts.connectorKey) && !facts.manifestBacked
  );
}

export interface ConnectorExecutionSourceFacts {
  connectorKey: string;
  connectorVersion: string;
  manifestBacked: boolean;
  artifactSourcePath: string | null | undefined;
}

/**
 * Whether the selected run artifact executes natively in Chrome.
 * The reserved Chrome namespace is intrinsically native. A legacy key is
 * native only while that exact artifact is the narrowly validated Chrome
 * manifest; compiled overrides and legacy platform definitions stay delegated.
 */
export function isNativeChromeExtensionConnector(facts: ConnectorExecutionSourceFacts): boolean {
  if (isChromeNamespaceConnectorKey(facts.connectorKey)) return true;
  if (!isLegacyNativeChromeExtensionConnectorKey(facts.connectorKey)) return false;
  return (
    facts.manifestBacked &&
    facts.artifactSourcePath ===
      `device-manifest://chrome-extension/${facts.connectorKey}@${facts.connectorVersion}`
  );
}

/** A Chrome pin on any other implementation delegates browser access; it does not host the parent run. */
export function isDelegatedBrowserAffinityConnector(
  platform: string | null | undefined,
  facts: ConnectorExecutionSourceFacts
): boolean {
  return platform === 'chrome-extension' && !isNativeChromeExtensionConnector(facts);
}

/** SQL equivalent of {@link isNativeChromeExtensionConnector}. */
export function nativeChromeExtensionConnectorSql<TFragment>(
  sql: SqlTag<TFragment>,
  refs: {
    connectorKey: TFragment;
    connectorVersion: TFragment;
    manifestBacked: TFragment;
    artifactSourcePath: TFragment;
  }
): TFragment {
  return sql`
    (
      ${refs.connectorKey} = 'chrome'
      OR ${refs.connectorKey} LIKE 'chrome.%'
      OR (
        ${refs.connectorKey} = ANY(
          ${pgTextArray([...LEGACY_NATIVE_CHROME_EXTENSION_CONNECTOR_KEYS])}::text[]
        )
        AND COALESCE(${refs.manifestBacked}, false)
        AND ${refs.artifactSourcePath} =
          'device-manifest://chrome-extension/' || ${refs.connectorKey} || '@' || ${refs.connectorVersion}
      )
    )
  `;
}

/** SQL equivalent of {@link isDelegatedBrowserAffinityConnector}. */
export function delegatedBrowserAffinitySql<TFragment>(
  sql: SqlTag<TFragment>,
  refs: {
    platform: TFragment;
    connectorKey: TFragment;
    connectorVersion: TFragment;
    manifestBacked: TFragment;
    artifactSourcePath: TFragment;
  }
): TFragment {
  return sql`
    ${refs.platform} = 'chrome-extension'
    AND NOT (${nativeChromeExtensionConnectorSql(sql, refs)})
  `;
}

export function legacyNonManifestConnectorSql<TFragment>(
  sql: SqlTag<TFragment>,
  refs: {
    connectorKey: TFragment;
    manifestBacked: TFragment;
    artifactCompiledCode: TFragment;
  }
): TFragment {
  return sql`
    ${refs.connectorKey} = ANY(
      ${pgTextArray([...LEGACY_NATIVE_CHROME_EXTENSION_CONNECTOR_KEYS])}::text[]
    )
    AND NOT COALESCE(${refs.manifestBacked}, false)
    AND NULLIF(BTRIM(${refs.artifactCompiledCode}), '') IS NOT NULL
  `;
}

/**
 * Resolve the selected artifact for an exact connector version. The
 * org-scoped artifact wins over the shared artifact,
 * matching connector execution resolution. The two partial unique indexes on
 * connector_versions bound this lookup to at most those two candidates.
 */
export function selectedConnectorVersionArtifactSql<TFragment>(
  sql: SqlTag<TFragment>,
  refs: { connectorKey: TFragment; version: TFragment; organizationId: TFragment }
): TFragment {
  return sql`
    SELECT
      cv.id AS artifact_row_id,
      cv.organization_id AS artifact_organization_id,
      COUNT(*) OVER ()::int AS artifact_row_count,
      (
        cv.source_path LIKE 'device-manifest://%'
        AND cv.compiled_code IS NULL
        AND cv.compile_config_hash IS NULL
        AND cv.source_code IS NULL
      ) AS manifest_backed,
      cv.compiled_code_hash AS artifact_hash,
      cv.source_path AS artifact_source_path,
      cv.compiled_code AS artifact_compiled_code,
      cv.compile_config_hash AS artifact_compile_config_hash,
      (cv.source_code IS NOT NULL) AS artifact_has_source_code
    FROM connector_versions cv
    WHERE cv.connector_key = ${refs.connectorKey}
      AND cv.version = ${refs.version}
      AND (
        cv.organization_id = ${refs.organizationId}
        OR cv.organization_id IS NULL
      )
    ORDER BY cv.organization_id NULLS LAST
    LIMIT 1
  `;
}
