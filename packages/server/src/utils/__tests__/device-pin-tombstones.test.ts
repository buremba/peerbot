import { describe, expect, it } from 'bun:test';
import {
	connectionHasLiveDevicePin,
	DEVICE_MOVED_TOMBSTONE,
	DEVICE_PIN_TOMBSTONE_MESSAGES,
	DEVICE_REMOVED_TOMBSTONE,
	effectiveConnectionErrorMessage,
	isDevicePinTombstone,
} from '../device-pin-tombstones';

describe('device-pin-tombstones', () => {
	it('recognizes only the canonical stamp strings', () => {
		expect(isDevicePinTombstone(DEVICE_REMOVED_TOMBSTONE)).toBe(true);
		expect(isDevicePinTombstone(DEVICE_MOVED_TOMBSTONE)).toBe(true);
		expect(isDevicePinTombstone('Authentication failed')).toBe(false);
		expect(isDevicePinTombstone(null)).toBe(false);
		expect(isDevicePinTombstone(undefined)).toBe(false);
		expect(DEVICE_PIN_TOMBSTONE_MESSAGES).toContain(DEVICE_REMOVED_TOMBSTONE);
		expect(DEVICE_PIN_TOMBSTONE_MESSAGES).toContain(DEVICE_MOVED_TOMBSTONE);
	});

	it('detects a live pin from device join fields', () => {
		expect(
			connectionHasLiveDevicePin({
				device_worker_id: 'uuid',
				device_last_seen_at: new Date().toISOString(),
			}),
		).toBe(true);
		expect(
			connectionHasLiveDevicePin({
				device_worker_id: 'uuid',
				device_worker_handle: 'chrome-abc',
			}),
		).toBe(true);
		expect(
			connectionHasLiveDevicePin({
				device_worker_id: 'uuid',
				device_label: 'MacBook',
			}),
		).toBe(true);
		expect(
			connectionHasLiveDevicePin({
				device_worker_id: 'uuid',
				device_last_seen_at: null,
				device_worker_handle: null,
				device_label: null,
			}),
		).toBe(false);
		expect(
			connectionHasLiveDevicePin({
				device_worker_id: null,
				device_last_seen_at: new Date().toISOString(),
			}),
		).toBe(false);
	});

	it('suppresses tombstone when device is re-pinned (the UI gap)', () => {
		expect(
			effectiveConnectionErrorMessage({
				error_message: DEVICE_REMOVED_TOMBSTONE,
				device_worker_id: '709f0d3a-56d6-4f70-b778-4ba10afa8985',
				device_last_seen_at: '2026-07-18T13:51:00Z',
				device_label: "Burak's MacBook Chrome",
			}),
		).toBeNull();

		// Still torn down: tombstone + no live device row
		expect(
			effectiveConnectionErrorMessage({
				error_message: DEVICE_REMOVED_TOMBSTONE,
				device_worker_id: null,
			}),
		).toBe(DEVICE_REMOVED_TOMBSTONE);

		// Unrelated errors still surface even when pinned
		expect(
			effectiveConnectionErrorMessage({
				error_message: 'OAuth token expired',
				device_worker_id: 'uuid',
				device_last_seen_at: '2026-07-18T13:51:00Z',
			}),
		).toBe('OAuth token expired');
	});
});
