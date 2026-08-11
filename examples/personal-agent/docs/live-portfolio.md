# Live portfolio path

Status: implemented as a pure, provider-neutral calculation seam only. It is
not wired into `lobu.config.ts` and produces no live portfolio output. This
repository snapshot has no live quote provider or market-data credential.

## Source of truth

Midas is **manual/on-demand only**. Existing Midas `financial_asset` events are
the source of truth for acquisition state:

- `metadata.type` → market (`US` / `TR`)
- `metadata.symbol` → ticker
- `metadata.shares` → quantity
- `metadata.price` / `metadata.value` → **snapshot** observations (historical,
  NOT live quotes)
- `metadata.avg_cost` → average acquisition price
- `metadata.currency` → `USD` / `TRY`
- `occurred_at` → snapshot timestamp

Midas events carry a stable `origin_id` (`midas-holding-<market>-<symbol>`);
cross-sync identity uses that, never `events.id`.

## Modules (`examples/personal-agent/portfolio/`)

- `world-model.ts` — shallow company/fund entity descriptors + ticker identity
  (`market:symbol`), with exact-only resolution. `ALTIN.S1` resolves to
  **null** (unresolved), never a guess.
- `quote-provider.ts` — provider-neutral `QuoteProvider` interface, quote
  contract (price / currency / provider / as_of / stale / tier), the
  `quote_unavailable` failure state, and a `FixtureQuoteProvider` test double.
- `portfolio.ts` — `holdingFromMidasEvent`, cost/value/P&L math, and
  `computePortfolio` (per-currency totals, never silently combined).

Tests: `examples/personal-agent/__tests__/portfolio.test.ts`.

## Quote provider requirement (the gap)

A live provider needs a credential/feed this repo does not have — e.g. a
market-data API key (Twelve Data, Alpha Vantage, Finnhub) or a trading-account
mark-to-market feed. That is an unapproved external dependency; it was NOT
introduced. A complete path still needs a real `QuoteProvider`, credential
configuration, and a caller that reads Midas events and renders the result. The
fixture provider is a test double and must never be used as a live source.

## Guarantees

- This seam performs no entity writes; private holdings (shares, avg cost,
  account identity, P&L) stay in the calculation result.
- No high-frequency quote events are persisted into the public organisation.
- Quotes are computed at read time; a quote failure returns `quote_unavailable`
  (holding + cost basis preserved), never a zero.
- USD and TRY totals stay separate; this seam has no FX conversion path.
