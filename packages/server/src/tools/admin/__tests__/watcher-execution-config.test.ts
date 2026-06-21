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

  it('returns null for an absent config or one left empty after stripping', () => {
    expect(stripServerOnlyExecutionConfig(null)).toBeNull();
    expect(stripServerOnlyExecutionConfig(undefined)).toBeNull();
    // Only server-only keys → empty after strip → null ("use defaults"), not {}.
    expect(stripServerOnlyExecutionConfig({ finalize_nudges: 2 })).toBeNull();
    expect(stripServerOnlyExecutionConfig({ model: 'claude' })).toEqual({
      model: 'claude',
    });
  });
});
