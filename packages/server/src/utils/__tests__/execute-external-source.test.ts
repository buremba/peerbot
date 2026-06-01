import { afterEach, describe, expect, it } from 'vitest';
import { assertExternalReadQuery, executeExternalSource } from '../execute-external-source';

describe('assertExternalReadQuery (external read-only gate)', () => {
  it('accepts a plain SELECT', () => {
    expect(() => assertExternalReadQuery('SELECT id, email FROM users')).not.toThrow();
  });

  it('accepts a WITH … SELECT (CTE)', () => {
    expect(() =>
      assertExternalReadQuery('WITH x AS (SELECT 1 AS n) SELECT * FROM x')
    ).not.toThrow();
  });

  it('rejects an empty query', () => {
    expect(() => assertExternalReadQuery('   ')).toThrow(/empty/i);
  });

  it('rejects a non-SELECT (UPDATE)', () => {
    expect(() => assertExternalReadQuery("UPDATE users SET email = NULL")).toThrow(
      /SELECT \/ WITH/i
    );
  });

  it('rejects INSERT / DELETE / DDL', () => {
    expect(() => assertExternalReadQuery("INSERT INTO t VALUES (1)")).toThrow();
    expect(() => assertExternalReadQuery("DELETE FROM t")).toThrow();
    expect(() => assertExternalReadQuery("DROP TABLE t")).toThrow();
  });

  it('rejects multiple statements (trailing DML)', () => {
    expect(() => assertExternalReadQuery('SELECT 1; DROP TABLE t')).toThrow(
      /single statement/i
    );
  });

  it('rejects forbidden ops (COPY / CALL / DO)', () => {
    expect(() => assertExternalReadQuery("COPY t TO PROGRAM 'sh'")).toThrow();
    expect(() => assertExternalReadQuery('CALL do_thing()')).toThrow();
    expect(() => assertExternalReadQuery('DO $$ BEGIN END $$')).toThrow();
  });

  it('rejects a data-modifying CTE (defense-in-depth)', () => {
    expect(() =>
      assertExternalReadQuery('WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM x')
    ).toThrow(/data-modifying/i);
    expect(() =>
      assertExternalReadQuery('WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d')
    ).toThrow(/data-modifying/i);
  });
});

describe('executeExternalSource cloud-mode gate (§G SSRF)', () => {
  afterEach(() => {
    process.env.LOBU_CLOUD_MODE = undefined;
  });

  it('refuses to run under LOBU_CLOUD_MODE before touching any DB', async () => {
    process.env.LOBU_CLOUD_MODE = '1';
    await expect(
      executeExternalSource({ organizationId: 'org', connectionSlug: 'c' }, 'SELECT 1')
    ).rejects.toThrow(/Lobu Cloud/i);
  });
});
