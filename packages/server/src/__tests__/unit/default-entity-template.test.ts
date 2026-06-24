import { describe, expect, it } from 'vitest';
import { buildDefaultEntityTemplate } from '../../utils/default-entity-template';

describe('buildDefaultEntityTemplate', () => {
  it('returns null for a schema with no properties', () => {
    expect(buildDefaultEntityTemplate(null)).toBeNull();
    expect(buildDefaultEntityTemplate({})).toBeNull();
    expect(buildDefaultEntityTemplate({ type: 'object', properties: {} })).toBeNull();
  });

  it('builds a card with one data-bound row per property', () => {
    const tpl = buildDefaultEntityTemplate({
      type: 'object',
      properties: {
        stage: { title: 'Deal Stage' },
        amount: {},
      },
    });
    expect(tpl).not.toBeNull();
    const json = JSON.stringify(tpl);
    // root is a card carrying a table → tbody → rows
    expect(tpl?.type).toBe('card');
    // a data binding for each field key
    expect(json).toContain('"path":"stage"');
    expect(json).toContain('"path":"amount"');
    // labels: explicit title, else title-cased key
    expect(json).toContain('Deal Stage');
    expect(json).toContain('Amount');
  });

  it('honors x-table-column ordering and x-table-label, and skips x-hidden', () => {
    const tpl = buildDefaultEntityTemplate({
      properties: {
        second: { 'x-table-column': 2 },
        first: { 'x-table-column': 1, 'x-table-label': 'First Field' },
        secret: { 'x-hidden': true },
      },
    });
    const json = JSON.stringify(tpl);
    expect(json).not.toContain('"path":"secret"');
    expect(json).toContain('First Field');
    // first column precedes second in serialized order
    expect(json.indexOf('"path":"first"')).toBeLessThan(json.indexOf('"path":"second"'));
  });
});
