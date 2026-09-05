import headlessDeviceConnectorManifests from './generated/headless-device-connector-manifests.json' with { type: 'json' };

/**
 * Device manifests this daemon declares on poll, keyed by the platform it
 * registered as.
 *
 * The contents are GENERATED from `@lobu/device-connectors`
 * (`bun run generate` there; CI re-checks it) rather than written here, because
 * a device contract is shared with every other endpoint that implements it —
 * `os.shell` also ships inside the Mac app. The manifest is hashed to form the
 * connector's identity and an organization elects exactly one manifest per
 * key, so two hand-maintained copies mean one endpoint wins the election and
 * the other silently stops being claimable. Generating both from one source
 * makes divergence impossible to express.
 *
 * The artifact is checked in rather than imported across the package boundary:
 * `@lobu/device-connectors` is private, while this package is published and
 * installed by the CLI, so a runtime dependency on it would not resolve.
 */
export const DEVICE_MANIFESTS_BY_PLATFORM: Record<string, unknown[]> = {
  headless: headlessDeviceConnectorManifests,
};
