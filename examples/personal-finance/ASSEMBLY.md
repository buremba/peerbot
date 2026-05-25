# SA100 Assembly Playbook

When the user asks to "assemble my Self Assessment", "prepare my return", or similar for a given tax year, run the queries in this file via `query_sql`, apply the calculations below, and produce the markdown output shown at the bottom.

Do not guess. If a required field is missing (e.g. employer PAYE reference, acquisition cost on a disposal), surface it as a gap in the "⚠️ Gaps to resolve" section of the output rather than fabricating a value.

## Tax-year constants

| Constant | 2024-25 | 2025-26 |
|---|---|---|
| Personal allowance | £12,570 | £12,570 |
| Basic-rate band top | £50,270 | £50,270 |
| Higher-rate band top | £125,140 | £125,140 |
| Additional-rate threshold | £125,140 | £125,140 |
| Dividend allowance | £500 | £500 |
| Personal savings allowance (basic rate) | £1,000 | £1,000 |
| Personal savings allowance (higher rate) | £500 | £500 |
| Personal savings allowance (additional rate) | £0 | £0 |
| CGT annual exempt amount | £3,000 | £3,000 |
| CGT residential rate (basic) | 18% | 18% |
| CGT residential rate (higher) | 24% | 24% |
| CGT other asset rate (basic) | 10% | 18% |
| CGT other asset rate (higher) | 20% | 24% |
| Dividend rate (basic) | 8.75% | 8.75% |
| Dividend rate (higher) | 33.75% | 33.75% |
| Dividend rate (additional) | 39.35% | 39.35% |

Sources: gov.uk/income-tax-rates, gov.uk/capital-gains-tax/allowances, gov.uk/tax-on-dividends. Update these if HMRC revises them for a new fiscal year.

## Queries

`$TAX_YEAR_ID` below is the `entities.id` of the active `tax_year` row (resolve once, reuse in every query). All queries are org-scoped automatically — no need to filter by organization_id.

### 0. Resolve the tax year + the user's $member + their identifiers

```sql
SELECT id, name, (metadata->>'year_label') AS year_label,
       (metadata->>'start')::date AS start_date,
       (metadata->>'end')::date AS end_date,
       (metadata->>'residence_status') AS residence_status
FROM entities
WHERE entity_type = 'tax_year'
  AND metadata->>'year_label' = '2025-26';
```

```sql
-- $MEMBER_ID is the user's $member entity in their personal org.
SELECT id, name, (metadata->>'display_name') AS display_name
FROM entities
WHERE entity_type = '$member'
  AND deleted_at IS NULL
LIMIT 1;
```

```sql
-- HMRC identifiers live in entity_identities, NOT metadata.
SELECT namespace, identifier
FROM entity_identities
WHERE entity_id = $MEMBER_ID
  AND namespace IN ('hmrc_utr', 'hmrc_ni_number')
  AND deleted_at IS NULL;
```

### 1. SA100 main — dividends & interest

```sql
SELECT
  e.id,
  e.name AS source,
  (e.metadata->>'type') AS src_type,
  (e.metadata->>'country') AS country,
  COALESCE((r.metadata->>'gross_amount')::numeric, t.amount::numeric) AS gross,
  COALESCE((r.metadata->>'tax_deducted')::numeric, 0) AS tax_deducted,
  (t.metadata->>'date')::date AS tx_date
FROM entities t
JOIN entity_relationships fr ON fr.from_entity_id = t.id
  AND fr.relationship_type_slug = 'for_tax_year'
  AND fr.to_entity_id = $TAX_YEAR_ID
JOIN entity_relationships ir ON ir.from_entity_id = t.id
  AND ir.relationship_type_slug = 'income_from'
JOIN entities e ON e.id = ir.to_entity_id
LEFT JOIN entity_relationships r ON r.id = ir.id
WHERE t.entity_type = 'transaction'
  AND (e.metadata->>'type') IN ('dividend','interest');
```

### 2. SA102 — employment income (per employer)

Employer is a `company` entity. PAYE ref lives on the `employed_by` relationship's metadata (since one company can pay one person via different PAYE schemes — e.g. a director who's also a regular PAYE employee). Director status is the `director_of` relationship between the user's `$member` and the company.

```sql
SELECT
  emp.name AS employer,
  (er.metadata->>'paye_reference') AS paye_ref,
  EXISTS(
    SELECT 1 FROM entity_relationships dr
    WHERE dr.relationship_type_slug = 'director_of'
      AND dr.from_entity_id = $MEMBER_ID
      AND dr.to_entity_id = emp.id
  ) AS director,
  SUM(COALESCE((ir.metadata->>'gross_amount')::numeric, t.amount::numeric)) AS gross_pay,
  SUM(COALESCE((ir.metadata->>'tax_deducted')::numeric, 0)) AS tax_deducted
FROM entities t
JOIN entity_relationships fr ON fr.from_entity_id = t.id
  AND fr.relationship_type_slug = 'for_tax_year'
  AND fr.to_entity_id = $TAX_YEAR_ID
JOIN entity_relationships ir ON ir.from_entity_id = t.id
  AND ir.relationship_type_slug = 'income_from'
JOIN entities src ON src.id = ir.to_entity_id
  AND src.entity_type = 'income_source'
  AND (src.metadata->>'type') = 'employment'
JOIN entity_relationships er ON er.from_entity_id = src.id
  AND er.relationship_type_slug = 'employed_by'
JOIN entities emp ON emp.id = er.to_entity_id
  AND emp.entity_type = 'company'
WHERE t.entity_type = 'transaction'
GROUP BY emp.id, emp.name, er.metadata;
```

### 3. SA105 — UK property (per property)

Properties are filtered by `use IN ('let', 'FHL', 'commercial_let')` — primary residences and investment-held properties don't generate rental income. Joint ownership comes from `co_owned_by` rows; the user's share is the row whose `from_entity_id = $MEMBER_ID`.

```sql
SELECT
  p.name AS property,
  (p.metadata->>'address') AS address,
  (p.metadata->>'type') AS type,
  (p.metadata->>'use') AS use,
  COALESCE((co.metadata->>'share_pct')::numeric, 100) AS share_pct,
  SUM(CASE WHEN (t.metadata->>'tax_relevance') = 'income'
            THEN t.amount::numeric ELSE 0 END) AS rental_income_gross,
  (SELECT COALESCE(SUM((ex.metadata->>'amount')::numeric), 0)
   FROM entities ex
   JOIN entity_relationships eor ON eor.from_entity_id = ex.id
     AND eor.relationship_type_slug = 'expense_of'
     AND eor.to_entity_id = p.id
   JOIN entity_relationships fr2 ON fr2.from_entity_id = ex.id
     AND fr2.relationship_type_slug = 'for_tax_year'
     AND fr2.to_entity_id = $TAX_YEAR_ID
   WHERE ex.entity_type = 'expense'
     AND COALESCE(ex.metadata->>'tax_category', '') <> 'finance') AS allowable_expenses,
  (SELECT COALESCE(SUM((ex.metadata->>'amount')::numeric), 0)
   FROM entities ex
   JOIN entity_relationships eor ON eor.from_entity_id = ex.id
     AND eor.relationship_type_slug = 'expense_of'
     AND eor.to_entity_id = p.id
   JOIN entity_relationships fr2 ON fr2.from_entity_id = ex.id
     AND fr2.relationship_type_slug = 'for_tax_year'
     AND fr2.to_entity_id = $TAX_YEAR_ID
   WHERE ex.entity_type = 'expense'
     AND ex.metadata->>'tax_category' = 'finance') AS finance_costs
FROM entities p
LEFT JOIN entity_relationships co ON co.from_entity_id = p.id
  AND co.relationship_type_slug = 'co_owned_by'
  AND co.to_entity_id = $MEMBER_ID
LEFT JOIN entity_relationships own ON own.from_entity_id = p.id
  AND own.relationship_type_slug = 'owned_by'
  AND own.to_entity_id = $MEMBER_ID
LEFT JOIN entity_relationships acr ON acr.from_entity_id = p.id
  AND acr.relationship_type_slug = 'account_contains'
LEFT JOIN entities t ON t.id = acr.to_entity_id
  AND t.entity_type = 'transaction'
LEFT JOIN entity_relationships fr ON fr.from_entity_id = t.id
  AND fr.relationship_type_slug = 'for_tax_year'
  AND fr.to_entity_id = $TAX_YEAR_ID
WHERE p.entity_type = 'property'
  AND (p.metadata->>'country') = 'GB'
  AND (p.metadata->>'use') IN ('let', 'FHL', 'commercial_let')
  AND (own.id IS NOT NULL OR co.id IS NOT NULL)
GROUP BY p.id, p.name, p.metadata, co.metadata;
```

Note on SA105: mortgage interest on residential lets is NOT deductible as an expense. Instead it gives a basic-rate tax credit (20% of the lower of finance costs, rental profits, or adjusted total income). The query above splits expenses by `metadata.tax_category`: rows tagged `finance` go into `finance_costs` and are excluded from `allowable_expenses`. If a finance-cost row is mis-tagged it will silently slip into `allowable_expenses` — flag any expense referencing "mortgage", "interest" or "loan" in its description that isn't tagged `finance` as a gap.

### 4. SA108 — capital gains

```sql
SELECT
  e.id,
  (e.metadata->>'asset_description') AS asset,
  (e.metadata->>'asset_class') AS asset_class,
  (e.metadata->>'acquisition_date')::date AS acq_date,
  (e.metadata->>'acquisition_cost')::numeric AS acq_cost,
  (e.metadata->>'disposal_date')::date AS disp_date,
  (e.metadata->>'disposal_proceeds')::numeric AS proceeds,
  COALESCE((e.metadata->>'incidental_costs')::numeric, 0) AS incidentals,
  (e.metadata->>'relief_claimed') AS relief
FROM entities e
JOIN entity_relationships fr ON fr.from_entity_id = e.id
  AND fr.relationship_type_slug = 'for_tax_year'
  AND fr.to_entity_id = $TAX_YEAR_ID
WHERE e.entity_type = 'cgt_event'
ORDER BY (e.metadata->>'disposal_date')::date;
```

Per disposal: `gain = proceeds - acq_cost - incidentals`. Sum per asset class; apply the £3,000 annual exempt amount once across total gains; tax the remainder at the residential or other rates based on the user's marginal band.

### 5. Pension contributions + Gift Aid

```sql
SELECT
  (c.metadata->>'mechanism') AS mechanism,
  c.name AS scheme,
  SUM((c.metadata->>'amount')::numeric) AS net_paid,
  COUNT(*) AS payments
FROM entities c
JOIN entity_relationships fr ON fr.from_entity_id = c.id
  AND fr.relationship_type_slug = 'for_tax_year'
  AND fr.to_entity_id = $TAX_YEAR_ID
WHERE c.entity_type = 'contribution'
GROUP BY (c.metadata->>'mechanism'), c.name;
```

For `relief_at_source`: the user paid 80%, HMRC already added 20% at source, higher-rate relief claimed on the return (the additional 20/25% is collected via Self Assessment). For `net_pay` + `salary_sacrifice`: no Self Assessment claim — already taken pre-tax via payroll. For `gift_aid`: multiply `net_paid` by 1.25 to get gross; higher-rate relief claimed on the return.

### 6. Relief claims (allowances)

```sql
SELECT
  (rc.metadata->>'type') AS type,
  COALESCE((rc.metadata->>'amount')::numeric, 0) AS amount,
  rc.name,
  (rc.metadata->>'notes') AS notes
FROM entities rc
JOIN entity_relationships fr ON fr.from_entity_id = rc.id
  AND fr.relationship_type_slug = 'for_tax_year'
  AND fr.to_entity_id = $TAX_YEAR_ID
WHERE rc.entity_type = 'relief_claim';
```

## Output layout

Return one markdown document with these sections, in order. Use exact figures from the queries; round to whole pounds only at the final tax-owed line.

```
# Self Assessment {{year_label}} — assembly

**Taxpayer**: {{$member.name}} — UTR {{identities.hmrc_utr or "(missing)"}} — NI {{identities.hmrc_ni_number or "(missing)"}}
**Residence**: {{tax_year.residence_status or "uk_resident (assumed)"}}
**Deadlines**: paper 31 Oct {{YYYY}}, online 31 Jan {{YYYY+1}}, balancing payment 31 Jan {{YYYY+1}}, 2nd POA 31 Jul {{YYYY+1}}.

## SA100 main return

### Income summary
- Employment (SA102): £X (across N employers)
- UK property (SA105): £X
- Dividends (UK): £X  |  gross taxed-at-source £X
- Interest (UK, untaxed): £X
- Foreign income (SA106): £X  (if any)

### Allowances & reliefs
- Personal allowance: £12,570 (reduced by £1 for every £2 over £100,000)
- Dividend allowance: £500
- Personal savings allowance: £X (derived from marginal band)
- Marriage allowance: give/receive/none
- Gift aid (gross): £X
- Pension relief (higher-rate claim): £X

## SA102 — Employment (per employer)
| Employer | PAYE ref | Gross pay | Tax deducted |
|---|---|---|---|
| … | … | … | … |

## SA105 — UK property
| Property | Use | Share | Rental income | Allowable expenses | Finance costs (basic-rate credit) | Net profit |
|---|---|---|---|---|---|---|
| … | … | … | … | … | … | … |

Finance costs are NOT subtracted to compute net profit on SA105 — they generate a separate 20% basic-rate tax credit on the main return. Net profit shown above is `(rental_income - allowable_expenses) × share_pct`.

## SA108 — Capital gains
| Asset | Class | Acquired | Disposed | Proceeds | Cost | Gain | Relief |
|---|---|---|---|---|---|---|---|
| … | … | … | … | … | … | … | … |

Total gains: £X. Annual exempt amount: £3,000. Taxable gains: £X.

## ⚠️ Gaps to resolve
- [...] any missing UTR/NI/PAYE-ref/acquisition-cost/etc. Call these out explicitly.

## Next steps
1. Log into HMRC at https://www.gov.uk/log-in-file-self-assessment-tax-return
2. Copy the figures above into the matching boxes on SA100 and supplementary pages.
3. Retain source documents — you are responsible for evidence if HMRC asks.
```

If any supplementary page has zero rows (e.g. no property), omit that page's section rather than emitting an empty table.
