import { describe, expect, it } from 'vitest';
import {
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
});
