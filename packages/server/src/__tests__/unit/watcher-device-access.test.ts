/**
 * Unit coverage for the device-worker ownership gate on watcher pins
 * (watchers.device_worker_id). A device pin runs the watcher's agent CLI on the
 * device owner's machine, so a member-write actor must not be able to pin a
 * watcher to another user's device. This pins the pure decision matrix
 * (owner/admin/member/system × owned/foreign/missing device); the DB-backed
 * wrapper + persistence is exercised in the integration suite.
 */

import { describe, expect, it } from 'bun:test';
import {
  type DeviceWorkerAccessCaller,
  type DeviceWorkerOwnershipRow,
  evaluateDeviceWorkerAccess,
} from '../../tools/admin/watcher-device-access';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

const owner: DeviceWorkerAccessCaller = {
  memberRole: 'owner',
  userId: 'u-owner',
  organizationId: ORG,
  isAuthenticated: true,
};
const admin: DeviceWorkerAccessCaller = {
  memberRole: 'admin',
  userId: 'u-admin',
  organizationId: ORG,
  isAuthenticated: true,
};
const member: DeviceWorkerAccessCaller = {
  memberRole: 'member',
  userId: 'u-member',
  organizationId: ORG,
  isAuthenticated: true,
};
// apply / automation / default-provisioning: authenticated, no user/role.
const system: DeviceWorkerAccessCaller = {
  memberRole: null,
  userId: null,
  organizationId: ORG,
  isAuthenticated: true,
};

function device(
  overrides: Partial<DeviceWorkerOwnershipRow> = {}
): DeviceWorkerOwnershipRow {
  return { id: 'dev-1', user_id: 'u-member', organization_id: ORG, ...overrides };
}

describe('evaluateDeviceWorkerAccess — own device', () => {
  it('allows any caller to pin a device they own', () => {
    expect(evaluateDeviceWorkerAccess(device({ user_id: 'u-member' }), member)).toBeNull();
    expect(evaluateDeviceWorkerAccess(device({ user_id: 'u-owner' }), owner)).toBeNull();
    // Even when the owned device is attached to a different org.
    expect(
      evaluateDeviceWorkerAccess(
        device({ user_id: 'u-member', organization_id: OTHER_ORG }),
        member
      )
    ).toBeNull();
  });
});

describe('evaluateDeviceWorkerAccess — foreign device', () => {
  it("blocks a member from pinning another user's device", () => {
    const reason = evaluateDeviceWorkerAccess(
      device({ user_id: 'someone-else', organization_id: ORG }),
      member
    );
    expect(reason).toMatch(/device you own/i);
  });

  it('allows an org owner to pin a foreign device attached to their org', () => {
    expect(
      evaluateDeviceWorkerAccess(device({ user_id: 'someone-else', organization_id: ORG }), owner)
    ).toBeNull();
  });

  it('allows an org admin to pin a foreign device attached to their org', () => {
    expect(
      evaluateDeviceWorkerAccess(device({ user_id: 'someone-else', organization_id: ORG }), admin)
    ).toBeNull();
  });

  it('blocks an owner from pinning a device in another org', () => {
    const reason = evaluateDeviceWorkerAccess(
      device({ user_id: 'someone-else', organization_id: OTHER_ORG }),
      owner
    );
    expect(reason).toMatch(/device you own/i);
  });

  it('blocks an admin from pinning a device with no org attachment they do not own', () => {
    const reason = evaluateDeviceWorkerAccess(
      device({ user_id: 'someone-else', organization_id: null }),
      admin
    );
    expect(reason).toMatch(/device you own/i);
  });
});

describe('evaluateDeviceWorkerAccess — missing device', () => {
  it('rejects a non-member caller when the device row is absent', () => {
    expect(evaluateDeviceWorkerAccess(null, member)).toMatch(/not found or not accessible/i);
    expect(evaluateDeviceWorkerAccess(null, owner)).toMatch(/not found or not accessible/i);
  });
});

describe('evaluateDeviceWorkerAccess — system/internal caller', () => {
  it('allows system callers regardless of ownership', () => {
    expect(
      evaluateDeviceWorkerAccess(device({ user_id: 'whoever', organization_id: OTHER_ORG }), system)
    ).toBeNull();
  });

  it('allows system callers even when the device is missing', () => {
    expect(evaluateDeviceWorkerAccess(null, system)).toBeNull();
  });
});
