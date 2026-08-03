import { describe, expect, it } from 'vitest';
import { computeStableKey } from './stable-keys';

describe('computeStableKey', () => {
  it('combines normalized key fields deterministically', () => {
    expect(
      computeStableKey(
        { category: 'Stability', name: 'App Crashes' },
        ['category', 'name']
      )
    ).toBe('stability::app-crashes');
  });

  it('removes special characters using the persisted key algorithm', () => {
    expect(computeStableKey({ category: 'UI/UX', name: "Can't Login!" }, ['category', 'name']))
      .toBe('uiux::cant-login');
  });

  it('keeps empty composite segments so partial identities remain stable', () => {
    expect(computeStableKey({ category: 'Stability', name: null }, ['category', 'name']))
      .toBe('stability::');
    expect(computeStableKey({ category: undefined, name: 'App Crashes' }, ['category', 'name']))
      .toBe('::app-crashes');
  });

  it('normalizes whitespace, underscores, and case', () => {
    expect(
      computeStableKey(
        { type: '  UPPER_CASE  ', label: '  Multiple   Spaces  ' },
        ['type', 'label']
      )
    ).toBe('upper-case::multiple-spaces');
  });

  it('does not mutate the model output', () => {
    const row = { name: 'Performance Issues' };
    expect(computeStableKey(row, ['name'])).toBe('performance-issues');
    expect(row).toEqual({ name: 'Performance Issues' });
  });
});
