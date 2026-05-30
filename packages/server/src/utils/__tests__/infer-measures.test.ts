import { describe, expect, it } from 'vitest';
import { applyInferredMeasures, inferColumns } from '../infer-measures';

describe('inferColumns', () => {
  it('classifies aggregates → measures with the right re-agg rule', () => {
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
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.company_id).toEqual({ name: 'company_id', role: 'dimension' });
    expect(byName.currency.role).toBe('dimension');
    expect(byName.total).toEqual({ name: 'total', role: 'measure', reagg: 'additive' });
    expect(byName.n.reagg).toBe('additive');
    expect(byName.users.reagg).toBe('holistic'); // COUNT(DISTINCT ...)
    expect(byName.avgx.reagg).toBe('ratio'); // AVG → recompute sum/count
    expect(byName.last_d.reagg).toBe('extremum'); // MAX
    expect(byName.rate.reagg).toBe('ratio'); // a / b
  });

  it('returns [] for SELECT * and unparseable SQL (caller annotates explicitly)', () => {
    expect(inferColumns('SELECT * FROM events')).toEqual([]);
    expect(inferColumns('this is not sql')).toEqual([]);
  });
});

describe('applyInferredMeasures', () => {
  it('fills inferred roles but lets author-declared annotations win', () => {
    const schema = applyInferredMeasures(
      {
        type: 'object',
        // author overrides `spend` as a ratio; leaves `n` to inference
        properties: { spend: { 'x-measure': { reagg: 'ratio' } } },
      },
      'SELECT company_id, SUM(amount) AS spend, COUNT(*) AS n FROM events GROUP BY company_id'
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    // author's declaration preserved (not overwritten by inferred 'additive')
    expect((props.spend['x-measure'] as { reagg: string }).reagg).toBe('ratio');
    // inference filled `n`
    expect((props.n['x-measure'] as { reagg: string }).reagg).toBe('additive');
    // dimension inferred
    expect(props.company_id['x-dimension']).toBeDefined();
  });
});
