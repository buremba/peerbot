import { describe, expect, it } from 'vitest';
import {
  assertChromeNamespaceInstallIsDeviceManifest,
  isChromeNamespaceConnectorKey,
  isDelegatedBrowserAffinityConnector,
} from '../../utils/connector-execution-placement';

describe('Chrome-extension connector execution placement', () => {
  it('recognizes exactly the reserved Chrome namespace', () => {
    expect(isChromeNamespaceConnectorKey('chrome')).toBe(true);
    expect(isChromeNamespaceConnectorKey('chrome.history')).toBe(true);
    // A prefix match is not a namespace match.
    expect(isChromeNamespaceConnectorKey('chromecast.demo')).toBe(false);
    expect(isChromeNamespaceConnectorKey('linkedin')).toBe(false);
    // `whatsapp.local` was the one connector outside the namespace that the
    // extension implemented natively. It has been retired; nothing may take
    // its place without going through the namespace.
    expect(isChromeNamespaceConnectorKey('whatsapp.local')).toBe(false);
    expect(isChromeNamespaceConnectorKey('whatsapp.web')).toBe(false);
  });

  it('treats a Chrome pin on any other connector as delegated browser affinity', () => {
    // Native: the extension hosts the run itself.
    expect(isDelegatedBrowserAffinityConnector('chrome-extension', 'chrome')).toBe(false);
    expect(isDelegatedBrowserAffinityConnector('chrome-extension', 'chrome.history')).toBe(
      false
    );
    // Delegated: the pin only lends the connector a browser; the parent run
    // stays on fleet.
    expect(isDelegatedBrowserAffinityConnector('chrome-extension', 'whatsapp.web')).toBe(true);
    expect(isDelegatedBrowserAffinityConnector('chrome-extension', 'linkedin')).toBe(true);
    expect(isDelegatedBrowserAffinityConnector('chrome-extension', 'chromecast.demo')).toBe(
      true
    );
  });

  it('is a Chrome-only classification', () => {
    expect(isDelegatedBrowserAffinityConnector('macos', 'linkedin')).toBe(false);
    expect(isDelegatedBrowserAffinityConnector('headless', 'linkedin')).toBe(false);
    expect(isDelegatedBrowserAffinityConnector(null, 'linkedin')).toBe(false);
    expect(isDelegatedBrowserAffinityConnector(undefined, 'linkedin')).toBe(false);
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
          assertChromeNamespaceInstallIsDeviceManifest({
            connectorKey,
            connectorVersion: '1.0.0',
            sourcePath: null,
          })
        ).not.toThrow();
      }
    });
  });
});
