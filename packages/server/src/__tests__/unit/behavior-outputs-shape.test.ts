import { describe, expect, it } from 'bun:test';
import {
  BehaviorEntityOutputSchema,
  BehaviorEventOutputSchema,
} from '@lobu/core/contracts/tools/manage-behaviors';
import { Value } from '@sinclair/typebox/value';
import { assertOutputsShape, parseJsonInput } from '../../tools/admin/manage_behaviors/shared';

const valid = {
  items: { entity: 'social-signal', key: ['source_origin_id'] },
  alerts: { event: 'social_signal' },
};

describe('assertOutputsShape', () => {
  it('accepts entity and event outputs together', () => {
    expect(() => assertOutputsShape(valid)).not.toThrow();
  });

  it('accepts optional entity name fields', () => {
    expect(() =>
      assertOutputsShape({ items: { ...valid.items, name: ['author', 'platform'] } })
    ).not.toThrow();
  });

  it('accepts undefined and null for omit and explicit clear', () => {
    expect(() => assertOutputsShape(undefined)).not.toThrow();
    expect(() => assertOutputsShape(null)).not.toThrow();
  });

  it('rejects an empty outputs object and invalid output names', () => {
    expect(() => assertOutputsShape({})).toThrow(/Invalid outputs/);
    expect(() => assertOutputsShape({ 'nested.items': valid.items })).toThrow(/Invalid outputs/);
  });

  it('caps the number of named outputs per Behavior', () => {
    const outputs = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `output_${index}`,
        { event: 'observation' },
      ])
    );
    expect(() => assertOutputsShape(outputs)).toThrow(/Invalid outputs/);
  });

  it('requires exactly one output kind', () => {
    expect(() => assertOutputsShape({ items: { key: ['id'] } })).toThrow(/exactly one/);
    expect(() =>
      assertOutputsShape({ items: { entity: 'person', event: 'observation', key: ['id'] } })
    ).toThrow(/exactly one/);
  });

  it('rejects misspelled and prototype-named fields', () => {
    expect(() => assertOutputsShape({ items: { ...valid.items, keyFields: ['id'] } })).toThrow(
      /unknown field\(s\) keyFields/
    );
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const target = JSON.parse(JSON.stringify({ ...valid.items, [key]: 'x' }));
      expect(() => assertOutputsShape({ items: target })).toThrow(/unknown field/);
    }
  });

  it('publishes strict entity and event value schemas', () => {
    expect(
      Value.Check(BehaviorEntityOutputSchema, {
        entity: 'person',
        key: ['id'],
        event: 'observation',
      })
    ).toBe(false);
    expect(
      Value.Check(BehaviorEventOutputSchema, {
        event: 'observation',
        typo: true,
      })
    ).toBe(false);
  });

  it('rejects empty keys and organization guidance events', () => {
    expect(() => assertOutputsShape({ items: { entity: 'person', key: [] } })).toThrow(
      /Invalid outputs/
    );
    expect(() => assertOutputsShape({ items: { event: 'guidance' } })).toThrow(/cannot author/);
  });

  it('rejects surrounding whitespace in persisted output references', () => {
    expect(() => assertOutputsShape({ alerts: { event: ' observation ' } })).toThrow(
      /surrounding whitespace/
    );
    expect(() =>
      assertOutputsShape({ items: { entity: ' person ', key: ['id'] } })
    ).toThrow(/surrounding whitespace/);
  });

  it('enforces the same contract for serialized wire input', () => {
    const parsed = parseJsonInput(JSON.stringify(valid), 'outputs');
    expect(() => assertOutputsShape(parsed)).not.toThrow();
    expect(() =>
      assertOutputsShape(parseJsonInput('{"items":{"entity":"person"}}', 'outputs'))
    ).toThrow(/Invalid outputs/);
  });
});
