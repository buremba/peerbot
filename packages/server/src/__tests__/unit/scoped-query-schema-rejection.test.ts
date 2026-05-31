/**
 * Cross-org scoping guard: validateAndScopeQuery MUST reject schema-qualified
 * table references (`public.connections`, `pg_catalog.*`, …) anywhere in the
 * query.
 *
 * Why this is security-critical: org-scoping shadows UNQUALIFIED table names
 * with org-filtered CTEs. A schema-qualified reference resolves to the real
 * base table and bypasses the CTE → reads every org's rows. Regression guard:
 * the @polyglot-sql/sdk migration's first cut used `ast.getTables`, which only
 * returns the first FROM table — a schema-qualified table in a JOIN or subquery
 * slipped past and leaked. These reproducers were RED then; the raw-AST
 * recursion in extractTableRefs makes them GREEN.
 */

import { describe, expect, it } from 'bun:test';
import { validateAndScopeQuery } from '../../utils/execute-data-sources';
import { ADMIN_ONLY_QUERYABLE_TABLES, SAFE_COLUMN_DEFS } from '../../utils/table-schema';

const scope = (sql: string) =>
  validateAndScopeQuery(sql, 'org_test', { safeColumns: SAFE_COLUMN_DEFS });

// A non-admin caller passes the auth/identity tables as restricted.
const scopeAsMember = (sql: string) =>
  validateAndScopeQuery(sql, 'org_test', {
    safeColumns: SAFE_COLUMN_DEFS,
    restrictedTables: ADMIN_ONLY_QUERYABLE_TABLES,
  });

describe('validateAndScopeQuery — schema-qualified table rejection', () => {
  const leaks: Array<[string, string]> = [
    ['top-level', 'SELECT cc.payload_text FROM public.connections cc'],
    ['join 2nd table', 'SELECT * FROM entities e JOIN public.connections c ON c.id = e.id'],
    [
      'multi-join',
      'SELECT * FROM entities e JOIN public.connections c ON c.id = e.id JOIN public.events x ON x.id = e.id',
    ],
    [
      'subquery IN join',
      'SELECT id FROM entities WHERE id IN (SELECT id FROM entities e2 JOIN public.connections c ON true)',
    ],
    [
      'subquery EXISTS',
      'SELECT id FROM entities e WHERE EXISTS (SELECT 1 FROM public.connections c WHERE c.id = e.id)',
    ],
    ['UNION branch', 'SELECT id FROM entities UNION SELECT id FROM public.connections'],
    ['CTE body', 'WITH x AS (SELECT id FROM public.connections) SELECT * FROM x'],
    ['three-part name', 'SELECT * FROM entities e JOIN mydb.public.connections c ON true'],
  ];

  for (const [label, sql] of leaks) {
    it(`rejects a schema-qualified ref (${label})`, () => {
      expect(() => scope(sql)).toThrow(/schema-qualified/i);
    });
  }

  const clean: Array<[string, string]> = [
    ['plain', 'SELECT * FROM entities WHERE id > 0'],
    ['unqualified join', 'SELECT * FROM events ev JOIN entities en ON en.id = ANY(ev.entity_ids)'],
    [
      'jsonb aggregate view',
      "SELECT (metadata->>'vendor') AS v, SUM((metadata->>'amount')::numeric) AS s, COUNT(*) AS n FROM events GROUP BY 1",
    ],
    ['cte join', 'WITH c AS (SELECT id FROM events) SELECT * FROM c JOIN entities e ON e.id = c.id'],
    ['union', 'SELECT id FROM entities UNION SELECT id FROM events'],
  ];

  for (const [label, sql] of clean) {
    it(`scopes a clean query without error (${label})`, () => {
      const out = scope(sql);
      // every referenced base table is wrapped in an org-scoped CTE
      expect(out.sql).toContain('organization_id');
      expect(out.params[0]).toBe('org_test');
    });
  }
});

describe('validateAndScopeQuery — member table restriction (auth/identity admin-only)', () => {
  const blocked: Array<[string, string]> = [
    ['oauth_tokens', 'SELECT * FROM oauth_tokens'],
    ['oauth_clients', 'SELECT * FROM oauth_clients'],
    ['user roster', 'SELECT * FROM "user"'],
    ['joined oauth_tokens', 'SELECT * FROM entities e JOIN oauth_tokens t ON t.id = e.id'],
  ];
  for (const [label, sql] of blocked) {
    it(`blocks a non-admin from ${label}`, () => {
      expect(() => scopeAsMember(sql)).toThrow(/admin access/i);
    });
  }

  const allowed: Array<[string, string]> = [
    ['events', 'SELECT * FROM events'],
    ['entities', 'SELECT * FROM entities'],
    ['connections', 'SELECT * FROM connections'],
    ['feeds', 'SELECT * FROM feeds'],
  ];
  for (const [label, sql] of allowed) {
    it(`allows a non-admin to query ${label}`, () => {
      const out = scopeAsMember(sql);
      expect(out.sql).toContain('organization_id');
    });
  }

  it('allows an admin (no restriction) to query oauth_tokens', () => {
    const out = scope('SELECT * FROM oauth_tokens');
    expect(out.sql).toContain('organization_id');
  });
});
