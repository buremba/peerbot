/**
 * What the daemon ADVERTISES and what it can RUN are two independent lists, and
 * a device that offers a connector it cannot execute is the worst shape of all:
 * the gateway routes work to it and every run fails on arrival, while readiness
 * reports the device healthy. The manifest is generated from a shared contract
 * and the registry is hand-written per endpoint, so nothing but this test keeps
 * the two in step.
 */

import { describe, expect, test } from 'bun:test';
import { hasDaemonBuiltin } from '../daemon/builtins/index.js';
import { DEVICE_MANIFESTS_BY_PLATFORM } from '../daemon/device-manifests.js';

interface AdvertisedManifest {
  key: string;
  version: string;
  runtime: { platforms: string[] };
  actions_schema?: Record<string, unknown>;
}

describe('headless daemon manifests', () => {
  const manifests = (DEVICE_MANIFESTS_BY_PLATFORM.headless ??
    []) as AdvertisedManifest[];

  test('advertises at least one connector', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  test('every advertised action has a registered built-in', () => {
    for (const manifest of manifests) {
      const actions = Object.keys(manifest.actions_schema ?? {});
      expect(actions.length).toBeGreaterThan(0);
      for (const actionKey of actions) {
        expect({
          connector: manifest.key,
          action: actionKey,
          registered: hasDaemonBuiltin(manifest.key, actionKey),
        }).toEqual({ connector: manifest.key, action: actionKey, registered: true });
      }
    }
  });

  test('declares headless among its platforms and no implementation marker', () => {
    for (const manifest of manifests) {
      expect(manifest.runtime.platforms).toContain('headless');
      expect(manifest.runtime).not.toHaveProperty('execution');
    }
  });
});
