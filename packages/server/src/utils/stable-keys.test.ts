import { describe, expect, it } from 'vitest';
import type { KeyingConfig } from '../types/watchers';
import { computeStableKeys } from './stable-keys';

// Helper type for entities with dynamic keys
type EntityWithKey = Record<string, unknown>;

describe('computeStableKeys', () => {
  it('should compute stable keys for entities in an array', () => {
    const data: Record<string, unknown> = {
      problems: [
        { category: 'Stability', name: 'App Crashes' },
        { category: 'Performance', name: 'Slow Loading' },
      ],
    };

    const config: KeyingConfig = {
      entity_path: 'problems',
      key_fields: ['category', 'name'],
      key_output_field: 'problem_key',
    };

    computeStableKeys(data, config);

    const problems = data.problems as EntityWithKey[];
    expect(problems[0].problem_key).toBe('stability::app-crashes');
    expect(problems[1].problem_key).toBe('performance::slow-loading');
  });

  it('should handle special characters in field values', () => {
    const data: Record<string, unknown> = {
      problems: [{ category: 'UI/UX', name: "Can't Login!" }],
    };

    const config: KeyingConfig = {
      entity_path: 'problems',
      key_fields: ['category', 'name'],
      key_output_field: 'problem_key',
    };

    computeStableKeys(data, config);

    const problems = data.problems as EntityWithKey[];
    // Special chars removed (slashes stripped, apostrophes stripped)
    expect(problems[0].problem_key).toBe('uiux::cant-login');
  });

  it('should handle null/undefined field values', () => {
    const data: Record<string, unknown> = {
      problems: [
        { category: 'Stability', name: null },
        { category: undefined, name: 'App Crashes' },
      ],
    };

    const config: KeyingConfig = {
      entity_path: 'problems',
      key_fields: ['category', 'name'],
      key_output_field: 'problem_key',
    };

    computeStableKeys(data, config);

    const problems = data.problems as EntityWithKey[];
    expect(problems[0].problem_key).toBe('stability::');
    expect(problems[1].problem_key).toBe('::app-crashes');
  });

  it('should handle empty entity array', () => {
    const data = {
      problems: [],
    };

    const config: KeyingConfig = {
      entity_path: 'problems',
      key_fields: ['category', 'name'],
      key_output_field: 'problem_key',
    };

    computeStableKeys(data, config);

    expect(data.problems).toEqual([]);
  });

  it('should handle missing entity path gracefully', () => {
    const data = {
      other_field: 'value',
    };

    const config: KeyingConfig = {
      entity_path: 'problems',
      key_fields: ['category', 'name'],
      key_output_field: 'problem_key',
    };

    // Should not throw
    computeStableKeys(data as Record<string, unknown>, config);

    // Data should be unchanged
    expect(data).toEqual({ other_field: 'value' });
  });

  it('should handle nested entity path', () => {
    const data: Record<string, unknown> = {
      analysis: {
        results: {
          problems: [{ category: 'Bug', name: 'Memory Leak' }],
        },
      },
    };

    const config: KeyingConfig = {
      entity_path: 'analysis.results.problems',
      key_fields: ['category', 'name'],
      key_output_field: 'key',
    };

    computeStableKeys(data, config);

    const analysis = data.analysis as Record<string, unknown>;
    const results = analysis.results as Record<string, unknown>;
    const problems = results.problems as EntityWithKey[];
    expect(problems[0].key).toBe('bug::memory-leak');
  });

  it('should normalize whitespace and case consistently', () => {
    const data: Record<string, unknown> = {
      items: [
        { type: '  UPPERCASE  ', label: '  Multiple   Spaces  ' },
        { type: 'lowercase', label: 'normal' },
      ],
    };

    const config: KeyingConfig = {
      entity_path: 'items',
      key_fields: ['type', 'label'],
      key_output_field: 'item_key',
    };

    computeStableKeys(data, config);

    const items = data.items as EntityWithKey[];
    expect(items[0].item_key).toBe('uppercase::multiple-spaces');
    expect(items[1].item_key).toBe('lowercase::normal');
  });

  it('should use single key field correctly', () => {
    const data: Record<string, unknown> = {
      categories: [{ name: 'Performance Issues' }, { name: 'Security Bugs' }],
    };

    const config: KeyingConfig = {
      entity_path: 'categories',
      key_fields: ['name'],
      key_output_field: 'category_key',
    };

    computeStableKeys(data, config);

    const categories = data.categories as EntityWithKey[];
    expect(categories[0].category_key).toBe('performance-issues');
    expect(categories[1].category_key).toBe('security-bugs');
  });
});
