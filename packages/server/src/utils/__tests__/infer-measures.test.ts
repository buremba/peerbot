import { describe, expect, it } from 'vitest';
import { inferColumns, measureColumns } from '../infer-measures';

describe('inferColumns', () => {
  it('classifies aggregates / computed columns as measures, plain columns as dimensions', () => {
    const cols = inferColumns(
      `SELECT company_id, currency,
              SUM(amount)        AS total,
              COUNT(*)           AS n,
              COUNT(DISTINCT u)  AS users,
              AVG(x)             AS avgx,
              MAX(d)             AS last_d,
              num / den          AS rate
       FROM events GROUP BY company_id, currency`
    );
    const role = Object.fromEntries(cols.map((c) => [c.name, c.role]));
    expect(role.company_id).toBe('dimension');
    expect(role.currency).toBe('dimension');
    expect(role.total).toBe('measure');
    expect(role.n).toBe('measure');
    expect(role.users).toBe('measure'); // COUNT(DISTINCT …)
    expect(role.avgx).toBe('measure');
    expect(role.last_d).toBe('measure'); // MAX
    expect(role.rate).toBe('measure'); // a / b
  });

  it('treats generic aggregates (bool_or, jsonb_agg, percentile … WITHIN GROUP) as measures', () => {
    // Regression: these report as polyglot's generic `aggregate_function` /
    // `within_group` node types and were previously misclassified as dimensions.
    const role = Object.fromEntries(
      inferColumns(
        `SELECT g,
                bool_or(flag) AS any_flag,
                jsonb_agg(x) AS xs,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS median_v
         FROM events GROUP BY g`
      ).map((c) => [c.name, c.role])
    );
    expect(role.g).toBe('dimension');
    expect(role.any_flag).toBe('measure');
    expect(role.xs).toBe('measure');
    expect(role.median_v).toBe('measure');
  });

  it('sees through casts/parens to the underlying aggregate', () => {
    // Regression: a cast wraps the aggregate node, so checking only the top
    // node type reported `COUNT(*)::int` / `SUM(x)::numeric` as dimensions.
    const role = Object.fromEntries(
      inferColumns(
        `SELECT g,
                COUNT(*)::int            AS n,
                SUM(amount)::numeric     AS total,
                (AVG(x))::float8         AS avgx,
                (metadata->>'amount')::numeric AS amt
         FROM events GROUP BY g`
      ).map((c) => [c.name, c.role])
    );
    expect(role.g).toBe('dimension');
    expect(role.n).toBe('measure');
    expect(role.total).toBe('measure');
    expect(role.avgx).toBe('measure');
    // a cast of a NON-aggregate stays a dimension (no false positive)
    expect(role.amt).toBe('dimension');
  });

  it('returns [] for non-SELECT roots and genuinely unparseable SQL', () => {
    // SELECT * → handled (star projection, no named columns)
    expect(inferColumns('SELECT * FROM events')).toEqual([]);
    // These parse SUCCESSFULLY to a non-`select` root, so they hit the
    // non-select guard (not the parse-failure branch):
    expect(inferColumns('this is not sql')).toEqual([]); // parses as a `not` node
    expect(inferColumns('DROP TABLE x')).toEqual([]); // parses as `drop_table`
    // These FAIL to parse → exercise the `!res.success` fail-open branch:
    expect(inferColumns('SELECT (')).toEqual([]);
    expect(inferColumns('SELECT FROM')).toEqual([]);
  });
});

describe('measureColumns', () => {
  it('returns just the measure column names', () => {
    expect(
      measureColumns('SELECT company_id, SUM(amount) AS spend, COUNT(*) AS n FROM events GROUP BY 1').sort()
    ).toEqual(['n', 'spend']);
  });
});
