import { describe, expect, it } from 'vitest';
import { stripServerOnlyExecutionConfig } from '../watcher-execution-config';

describe('stripServerOnlyExecutionConfig', () => {
  it('removes server-only keys (finalize_nudges) but keeps device-worker fields', () => {
    // The device-worker strict-decodes execution_config; a server-only field it
    // doesn't know would brick the run. It must never reach the device payload.
    const out = stripServerOnlyExecutionConfig({
      timeout_seconds: 600,
      model: 'claude',
      finalize_nudges: 3,
    });
    expect(out).toEqual({ timeout_seconds: 600, model: 'claude' });
    expect(out).not.toHaveProperty('finalize_nudges');
  });

  it('returns null for an absent config and an empty object when there are no server-only keys', () => {
    expect(stripServerOnlyExecutionConfig(null)).toBeNull();
    expect(stripServerOnlyExecutionConfig(undefined)).toBeNull();
    expect(stripServerOnlyExecutionConfig({ model: 'claude' })).toEqual({
      model: 'claude',
    });
  });
});
