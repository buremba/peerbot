import { describe, expect, it } from 'vitest';
import { validateDeviceConnectorManifests } from '../../worker-api/device-manifests';

/**
 * `runtime.execution` arrived with the daemon-builtin routing. This same
 * validator also runs over ALREADY-STORED manifests to rebuild a device's
 * claim authority (getDeviceManifestSourcesForUser), so anything it rejects
 * silently revokes that device's ability to claim — no error, the runs just
 * queue forever. Every headless daemon registered before this field existed
 * stored `runtime: { platforms: ['headless'] }` and nothing more, so requiring
 * the field would strip os.shell from the entire installed base the moment the
 * gateway deployed, ahead of any daemon upgrade.
 */
function headlessManifest(runtime: Record<string, unknown>) {
  return {
    key: 'os.shell',
    version: '0.1.0',
    name: 'Shell',
    required_capability: 'os.shell',
    runtime,
    auth_schema: { methods: [{ type: 'none' }] },
    actions_schema: { run: { key: 'run' } },
  };
}

function validateHeadless(runtime: Record<string, unknown>) {
  return validateDeviceConnectorManifests({
    platform: 'headless',
    capabilities: ['os.shell'],
    manifests: [headlessManifest(runtime)],
  });
}

describe('headless manifest runtime.execution', () => {
  it('accepts an absent execution — the pre-0.2.0 installed base keeps claiming', () => {
    const result = validateHeadless({ platforms: ['headless'] });
    expect(result.accepted).toBe(true);
    expect(result.manifests).toHaveLength(1);
    // Absent stays absent: it must NOT be rewritten to daemon_builtin, or the
    // manifest hash would change and the stored-vs-computed comparison in the
    // revalidation path would drop the authorization anyway.
    expect(result.manifests[0]?.manifest.runtime.execution).toBeUndefined();
  });

  it('accepts the explicit daemon_builtin a 0.2.0 daemon advertises', () => {
    const result = validateHeadless({
      platforms: ['headless'],
      execution: 'daemon_builtin',
    });
    expect(result.accepted).toBe(true);
    expect(result.manifests[0]?.manifest.runtime.execution).toBe('daemon_builtin');
  });

  it('still rejects bridge on headless — there is no bridge to route to', () => {
    const result = validateHeadless({ platforms: ['headless'], execution: 'bridge' });
    expect(result.accepted).toBe(false);
    expect(result.manifests).toHaveLength(0);
  });

  it('still rejects an unrecognised execution value', () => {
    const result = validateHeadless({ platforms: ['headless'], execution: 'wat' });
    expect(result.accepted).toBe(false);
    expect(result.manifests).toHaveLength(0);
  });

  it('keeps the hash of an absent-execution manifest stable across revalidation', () => {
    // The revalidation path drops any manifest whose recomputed hash differs
    // from the stored one, so a hash that moves is the same silent revocation
    // as an outright reject.
    const first = validateHeadless({ platforms: ['headless'] });
    const second = validateDeviceConnectorManifests({
      platform: 'headless',
      capabilities: ['os.shell'],
      manifests: [first.manifests[0]?.manifest as unknown as Record<string, unknown>],
    });
    expect(second.accepted).toBe(true);
    expect(second.manifests[0]?.manifest_hash).toBe(first.manifests[0]?.manifest_hash);
  });
});
