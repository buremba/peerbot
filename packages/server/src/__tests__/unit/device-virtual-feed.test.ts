/**
 * Pure helpers of the device-backed virtual-feed seam.
 *
 * These are the parts that decide what a caller GETS, with no database in the
 * way: the row-window clamp (a live read must never become an unbounded scan on
 * someone's laptop) and the device-reply normalizer (a device is an
 * untrusted-SHAPE producer — `runs.action_output` is arbitrary JSON, so a
 * malformed reply has to surface as an error rather than as "no messages").
 */

import { describe, expect, it } from 'bun:test';
import {
  DEVICE_VIRTUAL_FEED_DEFAULT_LIMIT,
  DEVICE_VIRTUAL_FEED_MAX_LIMIT,
  DEVICE_VIRTUAL_FEED_MAX_OFFSET,
  clampDeviceVirtualFeedWindow,
  deliver,
  isMetadataOnlyDeviceConnector,
  normalizeDeviceVirtualFeedOutput,
} from '../../lib/device-virtual-feed';
import { DEVICE_VIRTUAL_FEED_ACTION_KEY } from '../../lib/device-virtual-feed-protocol';
import {
  RESERVED_ACTION_KEY_PREFIX,
  validateDeviceConnectorManifests,
} from '../../worker-api/device-manifests';

describe('device virtual feed — reserved action key', () => {
  it('lives in the gateway-reserved namespace so a manifest can never claim it', () => {
    expect(DEVICE_VIRTUAL_FEED_ACTION_KEY.startsWith(RESERVED_ACTION_KEY_PREFIX)).toBe(true);
  });

  // The collision this closes: the gateway dispatches the reserved key itself,
  // so a connector declaring the same string would shadow a read seam with a
  // user-invokable operation — and `manage_operations.execute` would happily
  // run it.
  it('rejects a manifest whose actions_schema claims the reserved prefix', () => {
    const result = validateDeviceConnectorManifests({
      platform: 'macos',
      capabilities: ['whatsapp_local'],
      manifests: [
        {
          key: 'whatsapp.local',
          version: '9.9.9',
          name: 'Impostor',
          required_capability: 'whatsapp_local',
          runtime: { platforms: ['macos'] },
          actions_schema: { [DEVICE_VIRTUAL_FEED_ACTION_KEY]: { key: DEVICE_VIRTUAL_FEED_ACTION_KEY } },
        },
      ],
    });
    expect(result.manifests).toHaveLength(0);
    expect(result.accepted).toBe(false);
  });

  it('still accepts a manifest declaring ordinary actions', () => {
    const result = validateDeviceConnectorManifests({
      platform: 'macos',
      capabilities: ['whatsapp_local'],
      manifests: [
        {
          key: 'whatsapp.local',
          version: '9.9.9',
          name: 'Fine',
          required_capability: 'whatsapp_local',
          runtime: { platforms: ['macos'] },
          actions_schema: { send_message: { key: 'send_message' } },
        },
      ],
    });
    expect(result.accepted).toBe(true);
    expect(result.manifests).toHaveLength(1);
  });
});

describe('device virtual feed — outcome mapping', () => {
  const params = {
    organizationId: 'org-1',
    feedId: 7,
    feedKey: 'messages_live',
    feedConfig: {},
    connectionId: 3,
    connectorKey: 'whatsapp.local',
    deviceWorkerId: null,
    requiredCapability: 'whatsapp_local',
  };

  it('returns the device rows on success', () => {
    expect(
      deliver(params, { status: 'completed', output: { rows: [{ id: 'wa-1' }] } }).rows
    ).toEqual([{ id: 'wa-1' }]);
  });

  it('names the feed and the device in a failure', () => {
    expect(() =>
      deliver(params, { status: 'failed', error_message: 'Full Disk Access denied' })
    ).toThrow(/feed 'messages_live' failed on the paired device: Full Disk Access denied/);
  });

  // Only reachable in production after the full 60s queue budget, so it is
  // pinned here rather than waited for. The phase-specific budget travels in
  // `error_message` (the waiter's job), not in `deliver`'s prefix.
  it('reports a timeout as a timeout', () => {
    expect(() =>
      deliver(params, { status: 'timeout', error_message: 'no device claimed the run' })
    ).toThrow(/timed out: no device claimed the run/);
  });
});

describe('device virtual feed — connector routing', () => {
  it('routes a METADATA-ONLY native connector to the device', () => {
    expect(isMetadataOnlyDeviceConnector({ platforms: ['macos'] }, false)).toBe(true);
  });

  it('leaves a fleet connector on the compiled pushdown path', () => {
    expect(isMetadataOnlyDeviceConnector(null, false)).toBe(false);
    expect(isMetadataOnlyDeviceConnector(undefined, false)).toBe(false);
  });

  // `runtime` is descriptive metadata (platforms, nix inputs), not a durable
  // "device-only" claim. A connector that carries it AND ships a bundle has a
  // real `query()`/`search()` on the server, which is a strictly better read
  // path than a device round-trip — routing it to a device would demote it and
  // fail outright wherever no device is paired.
  it('keeps a COMPILED connector on the pushdown even when it declares a runtime', () => {
    expect(isMetadataOnlyDeviceConnector({ platforms: ['macos'] }, true)).toBe(false);
    expect(isMetadataOnlyDeviceConnector({ nix: { packages: ['ffmpeg'] } }, true)).toBe(false);
  });
});

describe('device virtual feed — row window', () => {
  it('defaults when the caller names no window', () => {
    expect(clampDeviceVirtualFeedWindow(undefined, undefined)).toEqual({
      limit: DEVICE_VIRTUAL_FEED_DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it('caps limit AND offset — an unbounded offset is a full archive scan per request', () => {
    expect(clampDeviceVirtualFeedWindow(10_000, 10_000_000)).toEqual({
      limit: DEVICE_VIRTUAL_FEED_MAX_LIMIT,
      offset: DEVICE_VIRTUAL_FEED_MAX_OFFSET,
    });
  });

  it('floors a nonsensical window instead of passing it through', () => {
    expect(clampDeviceVirtualFeedWindow(0, -5)).toEqual({ limit: 1, offset: 0 });
    expect(clampDeviceVirtualFeedWindow(Number.NaN, Number.NaN)).toEqual({
      limit: DEVICE_VIRTUAL_FEED_DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it('truncates a fractional window rather than sending a float to the device', () => {
    expect(clampDeviceVirtualFeedWindow(10.9, 3.7)).toEqual({ limit: 10, offset: 3 });
  });
});

describe('device virtual feed — device reply normalization', () => {
  it('passes through rows, columns and total', () => {
    expect(
      normalizeDeviceVirtualFeedOutput({
        rows: [{ id: 'wa-1', text: 'hi' }],
        columns: [{ name: 'id', type: 'text' }],
        total: 42,
      })
    ).toEqual({
      rows: [{ id: 'wa-1', text: 'hi' }],
      columns: [{ name: 'id', type: 'text' }],
      total: 42,
    });
  });

  it('defaults a column with no declared type instead of dropping the column', () => {
    expect(normalizeDeviceVirtualFeedOutput({ rows: [], columns: [{ name: 'id' }] }).columns).toEqual(
      [{ name: 'id', type: 'text' }]
    );
  });

  it('drops a column entry that names nothing', () => {
    expect(
      normalizeDeviceVirtualFeedOutput({ rows: [], columns: [{ type: 'text' }, 'nope', null] }).columns
    ).toEqual([]);
  });

  it('omits a non-numeric total rather than coercing it', () => {
    expect(normalizeDeviceVirtualFeedOutput({ rows: [], total: 'lots' }).total).toBeUndefined();
  });

  // The failure this prevents: a device that replies `{}` or `{rows: null}`
  // would otherwise read as an authoritative empty result — "you have no
  // WhatsApp messages about the invoice" — when the truth is that the read
  // never happened.
  it.each([
    ['null', null],
    ['a scalar', 'rows'],
    ['an array', [{ id: 1 }]],
    ['an object with no rows', {}],
    ['an object whose rows is not an array', { rows: 'nope' }],
    ['an object with a non-object row', { rows: [{ id: 1 }, 'nope'] }],
  ])('throws on %s instead of reporting an empty result', (_label, output) => {
    expect(() => normalizeDeviceVirtualFeedOutput(output)).toThrow(/malformed/);
  });
});
