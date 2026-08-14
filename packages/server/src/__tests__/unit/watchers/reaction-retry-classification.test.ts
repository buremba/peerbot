import { describe, expect, it } from 'bun:test';
import { reactionErrorIsNonTransient } from '../../../tools/admin/manage_behaviors/complete-window';

describe('reactionErrorIsNonTransient', () => {
  it('classifies deterministic sandbox failures as non-retryable', () => {
    expect(reactionErrorIsNonTransient('TimeoutError: script exceeded 60000ms wall-clock budget')).toBe(true);
    expect(reactionErrorIsNonTransient('CompileError: failed to bundle')).toBe(true);
    expect(reactionErrorIsNonTransient('QuotaExceeded: SDK call quota reached')).toBe(true);
    expect(reactionErrorIsNonTransient('OutputSizeExceeded: bridge message exceeded bytes')).toBe(true);
    expect(reactionErrorIsNonTransient('ValidationError: invalid SDK arguments')).toBe(true);
    expect(reactionErrorIsNonTransient('McpScopeRequiredError: mcp:write is required')).toBe(true);
    expect(reactionErrorIsNonTransient('ScriptError: Script must `export default` an async function')).toBe(true);
    expect(reactionErrorIsNonTransient('ScriptError: CrossOrgAccessDenied: unavailable')).toBe(true);
  });

  it('leaves transient errors retryable', () => {
    expect(reactionErrorIsNonTransient('Error: upstream returned 503')).toBe(false);
    expect(reactionErrorIsNonTransient('FetchError: network connection lost')).toBe(false);
    expect(reactionErrorIsNonTransient(undefined)).toBe(false);
  });
});
