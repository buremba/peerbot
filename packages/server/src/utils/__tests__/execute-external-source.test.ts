import { describe, expect, it } from 'vitest';
import { assertExternalReadQuery } from '../execute-external-source';

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
});
