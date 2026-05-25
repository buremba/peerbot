# Statement Ingestion Playbook

When the user sends a file through WhatsApp — a bank statement, broker contract note, P60, dividend voucher, mortgage statement — follow this playbook. Forwarded Gmail messages are handled by the `gmail-tx` watcher automatically; this document covers direct file uploads.

## Inputs

Every inbound file surfaces on `platformMetadata.files[]` with shape:

```json
{
  "id": "art_...",
  "name": "monzo-statement-2025-11.pdf",
  "mimetype": "application/pdf",
  "size": 123456,
  "downloadUrl": "https://gateway.lobu.ai/artifacts/..."
}
```

The `downloadUrl` is a signed, short-lived URL you fetch via the gateway proxy. No auth needed — the gateway already trusts you.

## Step 1 — fetch the file

```bash
curl -sSL "$DOWNLOAD_URL" -o /workspace/incoming/$NAME
```

Store under `/workspace/incoming/` (the session workspace; persists per thread).

## Step 2 — extract text

- **PDF** → `pdftotext -layout /workspace/incoming/$NAME -` (poppler, declared in lobu.config.ts via `defineAgent({ nixPackages })`).
- **CSV** → read directly, or normalise with `csvtk headers $FILE` and `csvtk csv2tab $FILE` if columns need inspection.
- **OFX / QIF / TXT** → read directly.
- **Image of a receipt** → describe the file back to the user and ask them to re-send as PDF if possible (v1 does not OCR images).

Cap extracted text at ~50,000 characters. If longer, process in pages (`pdftotext -f $start -l $end`) and merge structured output.

## Step 3 — extract structured rows

Apply the same JSON schema the `gmail-tx` watcher uses:

```json
{
  "transactions": [{
    "date": "YYYY-MM-DD",
    "amount": "decimal string (positive=credit, negative=debit)",
    "currency": "GBP",
    "description": "raw description",
    "merchant_raw": "verbatim merchant text",
    "tax_relevance": "none|income|expense|cgt"
  }],
  "cgt_events": [{
    "asset_description": "...",
    "asset_class": "listed_shares|unlisted_shares|residential_property|other_property|crypto|other",
    "acquisition_date": "YYYY-MM-DD",
    "acquisition_cost": "decimal GBP",
    "disposal_date": "YYYY-MM-DD",
    "disposal_proceeds": "decimal GBP",
    "incidental_costs": "decimal GBP"
  }],
  "dividends": [{
    "payer": "...",
    "gross": "decimal",
    "currency": "GBP",
    "date": "YYYY-MM-DD",
    "country": "GB or ISO"
  }]
}
```

Rules while extracting:

- Skip ISA/SIPP-internal transactions for tax purposes (mark `tax_relevance="none"`).
- A savings-account interest credit is `income`; a normal card purchase is `none`; a broker sale that isn't inside an ISA/SIPP is `cgt` (and also produce a `cgt_events[]` row).
- If the description isn't clearly financial, skip it — don't over-extract.

## Step 4 — post-validate

**Totals check.** For bank / broker statements with opening + closing balances, verify:

```
opening_balance + sum(transaction.amount) ≈ closing_balance
```

Tolerate ±0.01 rounding. If the delta is larger:

1. Do **not** commit the extraction silently.
2. Report back to the user: "Extracted N transactions totalling £X, but opening + movements = £Y vs stated closing of £Z (delta £D). Which line am I missing?"
3. Wait for their correction before creating entities.

**Date-range check.** All extracted transactions should fall within the statement period printed at the top of the statement. Out-of-range rows are almost always a parsing error — flag them.

**Duplicate check.** Before creating each `transaction`, search for an existing one with the same `(account, date, amount, description)`. If found, surface as a question rather than writing.

## Step 5 — create entities

For every accepted row:

1. Resolve or create the `account` entity (provider + account_number_last4 match). Set ownership via `owned_by → $member` (or `co_owned_by` for joint accounts).
2. Create a `document` entity with `source="whatsapp_upload"`, `download_url=$DOWNLOAD_URL`, `doc_type` set appropriately.
3. Create the `transaction` / `cgt_event` / `holding` entity linked to the account via `account_contains`.
4. Add a `parsed_from` relationship from each row → the `document` entity (provenance).
5. Link each row to the active `tax_year` via `for_tax_year`.
6. For income rows, resolve or create the `income_source` and link via `income_from`. For employment income, also link `income_source.employed_by → company` (the employer).

## Step 5b — extract identifiers (UTR, NI, PAYE refs, Companies House numbers)

Documents like P60, P45, P11D, SA302 carry HMRC identifiers. **These go into `entity_identities`, not entity metadata.** When you spot one:

| Identifier | Source document(s) | Where it goes |
|---|---|---|
| 10-digit HMRC UTR | SA302, HMRC letters | `entity_identities` on the `$member` (personal) or on a `company` (corporate UTR) — `namespace='hmrc_utr'` |
| NI number (e.g. `QQ123456C`) | P60, P45 | `entity_identities` on the `$member` — `namespace='hmrc_ni_number'` |
| PAYE reference (e.g. `123/AB456`) | P60, P45, P11D | NOT on `entity_identities` — it's per-employment, so it goes on the `employed_by` relationship's `metadata.paye_reference` |
| 8-char Companies House number | Company filings, payslips for own Ltd | `entity_identities` on the `company` — `namespace='companies_house_number'` |
| VAT number (e.g. `GB123456789`) | VAT-registered invoices | `entity_identities` on the `company` — `namespace='vat_number'` |

Before writing, search for an existing identity row to avoid duplicates:
```sql
SELECT entity_id FROM entity_identities
WHERE namespace = 'hmrc_utr' AND identifier = '1234567890' AND deleted_at IS NULL
```

If the identifier already exists on a different entity than expected, surface to the user before writing — it might mean two `$member` entities collapsed or a number was mistyped.

## Step 6 — confirm

After all entities are written, summarise back to the user:

```
Parsed monzo-statement-2025-11.pdf:
  • 47 transactions (£3,240 in, £2,870 out) — all mapped to Monzo Current
  • 2 dividend credits → HSBC Holdings income_source
  • 1 savings-interest credit → Marcus savings_source

Gaps:
  • 3 transactions had no merchant — I left merchant_raw for you to confirm later
```

Never silently commit extracted data. Always give the user a chance to correct.
