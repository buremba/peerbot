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

    // Server-inferred annotations are flagged `inferred: true` so the apply
    // diff can ignore them; an author-declared annotation carries no flag.
    expect((props.n['x-measure'] as { inferred?: boolean }).inferred).toBe(true);
    expect((props.company_id['x-dimension'] as { inferred?: boolean }).inferred).toBe(true);
    expect(
      (props.spend['x-measure'] as { inferred?: boolean }).inferred
    ).toBeUndefined();
  });

  it('re-infers stale inferred annotations when the sql changes (round-trip robustness)', () => {
    // Simulate a non-CLI caller re-sending a read-back schema (which carries
    // server `inferred: true` annotations) alongside a CHANGED view.
    const readBack = {
      type: 'object',
      properties: {
        amt: { 'x-measure': { reagg: 'additive', inferred: true } }, // was SUM → now AVG
        old_dim: { 'x-dimension': { inferred: true } }, // column dropped in new sql
        note: { type: 'string', 'x-measure': { reagg: 'additive', inferred: true } }, // author key + stale inferred
      },
    };
    const out = applyInferredMeasures(
      readBack,
      'SELECT AVG(x) AS amt, note FROM events GROUP BY note'
    );
    const props = out.properties as Record<string, Record<string, unknown>>;
    // refreshed to the new sql, NOT frozen at the stale 'additive'
    expect((props.amt['x-measure'] as { reagg: string }).reagg).toBe('ratio');
    // a column the new sql no longer projects loses its stale annotation entirely
    expect(props.old_dim).toBeUndefined();
    // author-contributed keys survive; the stale inferred measure is replaced by
    // the correct inferred dimension
    expect(props.note.type).toBe('string');
    expect(props.note['x-dimension']).toBeDefined();
    expect(props.note['x-measure']).toBeUndefined();
  });
});
