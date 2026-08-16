import { describe, expect, it } from 'bun:test';
import { buildEntityName } from '../../utils/promote-keyed-entities';
import type { EntityOutput } from '../../types/automations';

const base: EntityOutput = {
  entity: 'social-signal',
  key: ['source_origin_id'],
};

const row = {
  source_origin_id: 'li_home_DijYQTynIqrc0TEZ7DKkGr03_yFuvvOspQH46vLcMuk',
  author: 'Adam Cohen',
  platform: 'linkedin',
  priority: 'high',
};

describe('buildEntityName', () => {
  it('names from name fields when set, leaving the opaque key as identity only', () => {
    const name = buildEntityName(row, { ...base, name: ['author'] }, 'stable-abc');
    expect(name).toBe('Adam Cohen');
  });

  it('joins multiple name fields in the given order', () => {
    const name = buildEntityName(row, { ...base, name: ['author', 'platform'] }, 'stable-abc');
    expect(name).toBe('Adam Cohen · linkedin');
  });

  it('falls back to key fields when name is absent', () => {
    expect(buildEntityName(row, base, 'stable-abc')).toBe(row.source_origin_id);
  });

  it('falls back to key fields when name is present but empty', () => {
    const name = buildEntityName(row, { ...base, name: [] }, 'stable-abc');
    expect(name).toBe(row.source_origin_id);
  });

  it('skips name fields that carry no value rather than emitting a blank segment', () => {
    const name = buildEntityName(row, { ...base, name: ['missing', 'author'] }, 'stable-abc');
    expect(name).toBe('Adam Cohen');
  });

  it('falls back to the stable key when no name field resolves', () => {
    const name = buildEntityName(row, { ...base, name: ['nope'] }, 'stable-abc');
    expect(name).toBe('stable-abc');
  });
});
