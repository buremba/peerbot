import { describe, expect, it } from 'bun:test';
import {
  DEVICE_ONLINE_WINDOW_SECONDS,
  describeDeviceLastSeen,
} from '../../utils/device-liveness';

const NOW = new Date('2026-08-05T14:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe('DEVICE_ONLINE_WINDOW_SECONDS', () => {
  it('leaves headroom over the worst measured healthy poll gap', () => {
    // Prod 2026-08-05: the slowest LIVE worker's max inter-poll gap was 11.6s.
    // A window at or under that would flap healthy devices to offline.
    expect(DEVICE_ONLINE_WINDOW_SECONDS).toBeGreaterThan(12 * 5);
  });

  it('stays within the dispatch queue budget by a small factor', () => {
    // QUEUE_BUDGET_MS is 60s (device-action-wait). "Online" has to imply a
    // dispatch right now stands a real chance of being claimed; the old
    // 20-minute window was 20x the budget and promised what dispatch could
    // not deliver.
    expect(DEVICE_ONLINE_WINDOW_SECONDS).toBeLessThanOrEqual(60 * 2);
  });
});

describe('describeDeviceLastSeen', () => {
  it('reports a never-seen device rather than pretending it is fresh', () => {
    expect(describeDeviceLastSeen(null, NOW)).toBe('has never polled');
    expect(describeDeviceLastSeen(undefined, NOW)).toBe('has never polled');
    expect(describeDeviceLastSeen('not-a-date', NOW)).toBe('has never polled');
  });

  it('uses seconds inside the first minute', () => {
    expect(describeDeviceLastSeen(ago(3), NOW)).toBe('last polled 3s ago');
    expect(describeDeviceLastSeen(ago(59), NOW)).toBe('last polled 59s ago');
  });

  it('rolls up to minutes, hours and days', () => {
    expect(describeDeviceLastSeen(ago(60), NOW)).toBe('last polled 1m ago');
    // The outage that motivated this: 18 minutes reported as online.
    expect(describeDeviceLastSeen(ago(18 * 60), NOW)).toBe('last polled 18m ago');
    expect(describeDeviceLastSeen(ago(2 * 3600), NOW)).toBe('last polled 2h ago');
    expect(describeDeviceLastSeen(ago(3 * 86400), NOW)).toBe('last polled 3d ago');
  });

  it('accepts a timestamp string, as postgres hands it back', () => {
    expect(describeDeviceLastSeen(ago(90).toISOString(), NOW)).toBe(
      'last polled 1m ago'
    );
  });

  it('treats clock skew into the future as just now, not a negative age', () => {
    expect(describeDeviceLastSeen(new Date(NOW.getTime() + 5_000), NOW)).toBe(
      'last polled just now'
    );
  });
});
