import { describe, expect, it } from 'bun:test';
import { buildEntityName } from '../../utils/promote-keyed-entities';
import type { KeyingConfig } from '../../types/behaviors';

const base: KeyingConfig = {
  entity_path: 'items',
  key_fields: ['source_origin_id'],
  key_output_field: 'stable_key',
  entity_type: 'social-signal',
};

const row = {
  source_origin_id: 'li_home_DijYQTynIqrc0TEZ7DKkGr03_yFuvvOspQH46vLcMuk',
  author: 'Adam Cohen',
  platform: 'linkedin',
  priority: 'high',
};

describe('buildEntityName', () => {
  it('names from name_fields when set, leaving the opaque key as identity only', () => {
    const name = buildEntityName(row, { ...base, name_fields: ['author'] }, 'stable-abc');
    expect(name).toBe('Adam Cohen');
  });

  it('joins multiple name_fields in the given order', () => {
    const name = buildEntityName(row, { ...base, name_fields: ['author', 'platform'] }, 'stable-abc');
    expect(name).toBe('Adam Cohen · linkedin');
  });

  it('falls back to key_fields when name_fields is absent', () => {
    expect(buildEntityName(row, base, 'stable-abc')).toBe(row.source_origin_id);
  });

  it('falls back to key_fields when name_fields is present but empty', () => {
    const name = buildEntityName(row, { ...base, name_fields: [] }, 'stable-abc');
    expect(name).toBe(row.source_origin_id);
  });

  it('skips name_fields that carry no value rather than emitting a blank segment', () => {
    const name = buildEntityName(row, { ...base, name_fields: ['missing', 'author'] }, 'stable-abc');
    expect(name).toBe('Adam Cohen');
  });

  it('falls back to the stable key when no name field resolves', () => {
    const name = buildEntityName(row, { ...base, name_fields: ['nope'] }, 'stable-abc');
    expect(name).toBe('stable-abc');
  });
});
