import { describe, expect, it } from 'vitest';
import {
  assertChromeNamespaceInstallIsDeviceManifest,
  isDelegatedBrowserAffinityConnector,
  isChromeNamespaceConnectorKey,
  isLegacyNonManifestConnector,
  isLegacyNativeChromeExtensionConnectorKey,
  isNativeChromeExtensionConnector,
  legacyNativeChromeExtensionRequiredCapability,
  LEGACY_NATIVE_CHROME_EXTENSION_CONNECTORS,
  LEGACY_NATIVE_CHROME_EXTENSION_CONNECTOR_KEYS,
} from '../../utils/connector-execution-placement';

describe('Chrome-extension connector execution placement', () => {
  it('keeps the legacy native allowlist exact', () => {
    expect(LEGACY_NATIVE_CHROME_EXTENSION_CONNECTORS).toEqual({
      'whatsapp.local': { requiredCapability: 'browser.whatsapp' },
    });
    expect(LEGACY_NATIVE_CHROME_EXTENSION_CONNECTOR_KEYS).toEqual(['whatsapp.local']);
    expect(isLegacyNativeChromeExtensionConnectorKey('whatsapp.local')).toBe(true);
    expect(isLegacyNativeChromeExtensionConnectorKey('whatsapp')).toBe(false);
    expect(legacyNativeChromeExtensionRequiredCapability('whatsapp.local')).toBe(
      'browser.whatsapp'
    );
    expect(legacyNativeChromeExtensionRequiredCapability('whatsapp')).toBeNull();
  });

  it('recognizes only the exact Chrome namespace intrinsically', () => {
    expect(isChromeNamespaceConnectorKey('chrome')).toBe(true);
    expect(isChromeNamespaceConnectorKey('chrome.history')).toBe(true);
    expect(isChromeNamespaceConnectorKey('chromecast.demo')).toBe(false);
    expect(isChromeNamespaceConnectorKey('whatsapp.local')).toBe(false);
  });

  it('distinguishes legacy non-manifest artifacts from device manifests', () => {
    expect(
      isLegacyNonManifestConnector({ connectorKey: 'whatsapp.local', manifestBacked: false })
    ).toBe(true);
    expect(
      isLegacyNonManifestConnector({ connectorKey: 'whatsapp.local', manifestBacked: true })
    ).toBe(false);
    expect(
      isLegacyNonManifestConnector({ connectorKey: 'linkedin', manifestBacked: false })
    ).toBe(false);
  });

  it('requires the exact Chrome manifest source facts for the legacy key', () => {
    const chromeManifest = {
      connectorKey: 'whatsapp.local',
      connectorVersion: '2.0.0',
      manifestBacked: true,
      artifactSourcePath: 'device-manifest://chrome-extension/whatsapp.local@2.0.0',
    };
    expect(isNativeChromeExtensionConnector(chromeManifest)).toBe(true);
    expect(isNativeChromeExtensionConnector({ ...chromeManifest, manifestBacked: false })).toBe(false);
    expect(
      isNativeChromeExtensionConnector({
        ...chromeManifest,
        artifactSourcePath: 'device-manifest://macos/whatsapp.local@1.9.0',
      })
    ).toBe(false);
    expect(
      isNativeChromeExtensionConnector({
        ...chromeManifest,
        connectorVersion: '2.0.1',
      })
    ).toBe(false);
    expect(
      isNativeChromeExtensionConnector({
        ...chromeManifest,
        artifactSourcePath: 'org-overrides/whatsapp.ts',
      })
    ).toBe(false);
  });

  it('distinguishes delegated browser affinity from source-backed native execution', () => {
    const facts = {
      connectorKey: 'whatsapp.local',
      connectorVersion: '2.0.0',
      manifestBacked: true,
      artifactSourcePath: 'device-manifest://chrome-extension/whatsapp.local@2.0.0',
    };
    expect(isDelegatedBrowserAffinityConnector('chrome-extension', facts)).toBe(false);
    expect(
      isDelegatedBrowserAffinityConnector('chrome-extension', {
        ...facts,
        manifestBacked: false,
      })
    ).toBe(true);
    expect(
      isDelegatedBrowserAffinityConnector('chrome-extension', {
        ...facts,
        connectorKey: 'chromecast.demo',
      })
    ).toBe(true);
    expect(isDelegatedBrowserAffinityConnector('macos', facts)).toBe(false);
  });

  describe('reserved-namespace install guard', () => {
    it('admits a chrome.* key that arrives as a device manifest', () => {
      expect(() =>
        assertChromeNamespaceInstallIsDeviceManifest({
          connectorKey: 'chrome.history',
          connectorVersion: '1.0.0',
          sourcePath: 'device-manifest://chrome-extension/chrome.history@1.0.0',
          compiledCode: null,
          sourceCode: null,
        })
      ).not.toThrow();
      expect(() =>
        assertChromeNamespaceInstallIsDeviceManifest({
          connectorKey: 'chrome',
          connectorVersion: '1.0.0',
          sourcePath: 'device-manifest://chrome-extension/chrome@1.0.0',
          compiledCode: null,
          sourceCode: null,
        })
      ).not.toThrow();
    });

    it('rejects a chrome.* key that ships its own code', () => {
      // The exact shape that killed the chrome.whatsapp migration: the gateway
      // withholds the bundle from a "native" connector and the extension has no
      // handler, so the failure only surfaced as `unknown dispatch` at run time.
      expect(() =>
        assertChromeNamespaceInstallIsDeviceManifest({
          connectorKey: 'chrome.whatsapp',
          connectorVersion: '1.0.0',
          sourcePath: null,
        })
      ).toThrow(/reserved 'chrome\.\*' namespace/);
      expect(() =>
        assertChromeNamespaceInstallIsDeviceManifest({
          connectorKey: 'chrome.whatsapp',
          connectorVersion: '1.0.0',
          sourcePath: 'connectors/whatsapp-web.ts',
        })
      ).toThrow(/cannot live there/);
    });

    it('rejects a forged device-manifest path built from a source_url', () => {
      // resolveConnectorInstallSource derives a source_url install's path as
      // `url.pathname.replace(/^\//, '')`, so a URL whose pathname is
      // `/device-manifest://chrome-extension/chrome.whatsapp` yields a
      // sourcePath that satisfies any PREFIX test — while the very same install
      // compiles the caller's own source. Only exact `<key>@<version>` identity
      // closes it.
      expect(() =>
        assertChromeNamespaceInstallIsDeviceManifest({
          connectorKey: 'chrome.whatsapp',
          connectorVersion: '1.0.0',
          sourcePath: 'device-manifest://chrome-extension/chrome.whatsapp',
          compiledCode: 'export default class {}',
        })
      ).toThrow(/reserved 'chrome\.\*' namespace/);
      // A different key's manifest path must not admit this key either.
      expect(() =>
        assertChromeNamespaceInstallIsDeviceManifest({
          connectorKey: 'chrome.whatsapp',
          connectorVersion: '1.0.0',
          sourcePath: 'device-manifest://chrome-extension/chrome.history@1.0.0',
        })
      ).toThrow(/cannot live there/);
      // Nor may a stale version's path admit a different version.
      expect(() =>
        assertChromeNamespaceInstallIsDeviceManifest({
          connectorKey: 'chrome.history',
          connectorVersion: '2.0.0',
          sourcePath: 'device-manifest://chrome-extension/chrome.history@1.0.0',
        })
      ).toThrow(/cannot live there/);
    });

    it('rejects an exact manifest identity that still carries a payload', () => {
      // A device manifest carries an identity, never a payload. Checking the
      // code independently means the guard states the real invariant instead of
      // trusting the path string to imply it.
      for (const payload of [
        { compiledCode: 'export default class {}' },
        { sourceCode: 'export default class {}' },
      ]) {
        expect(() =>
          assertChromeNamespaceInstallIsDeviceManifest({
            connectorKey: 'chrome.history',
            connectorVersion: '1.0.0',
            sourcePath: 'device-manifest://chrome-extension/chrome.history@1.0.0',
            ...payload,
          })
        ).toThrow(/reserved 'chrome\.\*' namespace/);
      }
    });

    it('leaves keys outside the namespace alone', () => {
      for (const connectorKey of ['whatsapp.web', 'chromecast.demo', 'x', 'linkedin']) {
        expect(() =>
          assertChromeNamespaceInstallIsDeviceManifest({ connectorKey, sourcePath: null })
        ).not.toThrow();
      }
    });
  });
});
