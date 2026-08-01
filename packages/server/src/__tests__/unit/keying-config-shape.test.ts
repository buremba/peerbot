import { describe, expect, it } from 'bun:test';
import { assertKeyingConfigShape } from '../../tools/admin/manage_behaviors/shared';

const valid = {
  entity_path: 'items',
  key_fields: ['source_origin_id'],
  key_output_field: 'stable_key',
};

describe('assertKeyingConfigShape', () => {
  it('accepts a minimal valid config', () => {
    expect(() => assertKeyingConfigShape(valid)).not.toThrow();
  });

  it('accepts the optional entity_type and name_fields', () => {
    expect(() =>
      assertKeyingConfigShape({
        ...valid,
        entity_type: 'social-signal',
        name_fields: ['author'],
      })
    ).not.toThrow();
  });

  it('treats null/undefined as "not supplied" so inherited configs are untouched', () => {
    expect(() => assertKeyingConfigShape(null)).not.toThrow();
    expect(() => assertKeyingConfigShape(undefined)).not.toThrow();
  });

  it('rejects a missing required field', () => {
    expect(() => assertKeyingConfigShape({ entity_path: 'items' })).toThrow(/Invalid keying_config/);
  });

  it('rejects a misspelled key field name rather than silently ignoring it', () => {
    // The whole point of typing this: `keyFields` used to be accepted and then
    // dropped, disabling validation and promotion with no error.
    expect(() =>
      assertKeyingConfigShape({
        entity_path: 'items',
        keyFields: ['source_origin_id'],
        key_output_field: 'stable_key',
      })
    ).toThrow(/Invalid keying_config/);
  });

  it('rejects an empty key_fields array', () => {
    expect(() => assertKeyingConfigShape({ ...valid, key_fields: [] })).toThrow(
      /Invalid keying_config/
    );
  });

  it('rejects a wrongly-typed field', () => {
    expect(() => assertKeyingConfigShape({ ...valid, entity_path: 42 })).toThrow(
      /Invalid keying_config/
    );
  });

  it('reports the offending path in the message', () => {
    expect(() => assertKeyingConfigShape({ ...valid, key_output_field: '' })).toThrow(
      /key_output_field/
    );
  });
});
