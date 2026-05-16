import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareSchemaVersions,
  readExpectedSchemaVersion,
} from '../schema-version-check';

describe('readExpectedSchemaVersion', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'schema-check-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the highest version prefix from migration filenames', () => {
    writeFileSync(path.join(dir, '20260512000000_first.sql'), '');
    writeFileSync(path.join(dir, '20260515150000_geo_enrichment.sql'), '');
    writeFileSync(path.join(dir, '20260516200000_events_search_tsv.sql'), '');
    expect(readExpectedSchemaVersion(dir)).toBe('20260516200000');
  });

  it('ignores non-migration files (no dbmate-style prefix)', () => {
    writeFileSync(path.join(dir, '20260512000000_real.sql'), '');
    writeFileSync(path.join(dir, 'README.md'), '');
    writeFileSync(path.join(dir, 'rollback.sql'), '');
    expect(readExpectedSchemaVersion(dir)).toBe('20260512000000');
  });

  it('returns null for an unreadable directory (treat as "no expectation")', () => {
    expect(readExpectedSchemaVersion(path.join(dir, 'does-not-exist'))).toBeNull();
  });

  it('returns null for an empty directory', () => {
    expect(readExpectedSchemaVersion(dir)).toBeNull();
  });
});

describe('compareSchemaVersions', () => {
  it('returns ok when applied >= expected', () => {
    expect(compareSchemaVersions('20260516200000', '20260516200000')).toEqual({
      kind: 'ok',
      expected: '20260516200000',
      applied: '20260516200000',
    });
    expect(compareSchemaVersions('20260516200000', '20260517000000')).toMatchObject({
      kind: 'ok',
    });
  });

  it('returns mismatch when applied is behind expected', () => {
    expect(compareSchemaVersions('20260516200000', '20260516120000')).toEqual({
      kind: 'mismatch',
      expected: '20260516200000',
      applied: '20260516120000',
    });
  });

  it('returns mismatch when no version is applied yet', () => {
    expect(compareSchemaVersions('20260516200000', null)).toEqual({
      kind: 'mismatch',
      expected: '20260516200000',
      applied: null,
    });
  });

  it('returns ok when expected is null (dev fallback / no migrations on disk)', () => {
    expect(compareSchemaVersions(null, null)).toMatchObject({ kind: 'ok' });
    expect(compareSchemaVersions(null, '20260516200000')).toMatchObject({ kind: 'ok' });
  });
});
