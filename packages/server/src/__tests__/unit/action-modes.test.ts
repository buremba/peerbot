import { describe, expect, it } from 'bun:test';
import { defaultActionModeForOperation } from '../../operations/action-modes';

describe('operation action-mode defaults', () => {
  it('honors an explicit approval requirement even for a read-classified operation', () => {
    expect(
      defaultActionModeForOperation({
        kind: 'read',
        requires_approval: true,
      })
    ).toBe('approval');
  });
});
