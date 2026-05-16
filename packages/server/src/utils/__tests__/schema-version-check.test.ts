import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../db/client';
import {
  assertSchemaUpToDate,
  compareSchemaVersions,
  readExpectedSchemaVersion,
} from '../schema-version-check';

/**
 * Build a stub DbClient that always returns the given `applied` version when
 * a tagged-template query runs. Just enough surface to satisfy the call site
 * in `assertSchemaUpToDate`.
 */
function makeStubDb(applied: string | null): DbClient {
  const fn = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    return Object.assign(Promise.resolve([{ version: applied }]), { count: 1 });
  }) as unknown as Sql;
  return fn as unknown as DbClient;
}

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

describe('assertSchemaUpToDate', () => {
  let dir: string;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'schema-check-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('throws in production when the migrations directory is missing (fail closed)', async () => {
    process.env.NODE_ENV = 'production';
    const missingDir = path.join(dir, 'does-not-exist');
    await expect(
      assertSchemaUpToDate(makeStubDb('20260516200000'), { migrationsDir: missingDir })
    ).rejects.toThrow(/missing db\/migrations/i);
  });

  it('passes in development when the migrations directory is missing (fail open for dev)', async () => {
    process.env.NODE_ENV = 'development';
    const missingDir = path.join(dir, 'does-not-exist');
    await expect(
      assertSchemaUpToDate(makeStubDb(null), { migrationsDir: missingDir })
    ).resolves.toBeUndefined();
  });

  it('throws when the database is behind the migrations directory', async () => {
    process.env.NODE_ENV = 'production';
    writeFileSync(path.join(dir, '20260516200000_events_search_tsv.sql'), '');
    await expect(
      assertSchemaUpToDate(makeStubDb('20260515120000'), { migrationsDir: dir })
    ).rejects.toThrow(/database is behind/i);
  });

  it('passes when the database is at the expected version', async () => {
    process.env.NODE_ENV = 'production';
    writeFileSync(path.join(dir, '20260516200000_events_search_tsv.sql'), '');
    await expect(
      assertSchemaUpToDate(makeStubDb('20260516200000'), { migrationsDir: dir })
    ).resolves.toBeUndefined();
  });
});
