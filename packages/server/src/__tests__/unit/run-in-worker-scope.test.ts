import { describe, expect, it } from 'vitest';
import { runInWorkerScope } from '../../utils/device-claimable-orgs';

const base = { organization_id: 'orgB', device_owner: null, watcher_device_owner: null };

describe('runInWorkerScope', () => {
  it('in scope when the run org is in the base scope', () => {
    expect(runInWorkerScope(base, { workerUserId: 'u1', orgIds: ['orgB'] })).toBe(true);
  });

  it('in scope when the worker owns the run\'s pinned connection device', () => {
    expect(
      runInWorkerScope(
        { ...base, device_owner: 'u1' },
        { workerUserId: 'u1', orgIds: ['orgA'] }
      )
    ).toBe(true);
  });

  it('in scope when the worker owns the run\'s pinned watcher device (cross-org)', () => {
    expect(
      runInWorkerScope(
        { ...base, watcher_device_owner: 'u1' },
        { workerUserId: 'u1', orgIds: ['orgA'] }
      )
    ).toBe(true);
  });

  it('forbidden when org is out of scope and the worker owns neither pinned device', () => {
    expect(
      runInWorkerScope(
        { ...base, device_owner: 'someone-else', watcher_device_owner: 'someone-else' },
        { workerUserId: 'u1', orgIds: ['orgA'] }
      )
    ).toBe(false);
  });

  it('forbidden when there is no worker user and the org is out of scope', () => {
    expect(
      runInWorkerScope({ ...base, watcher_device_owner: 'u1' }, { workerUserId: null, orgIds: [] })
    ).toBe(false);
  });
});
