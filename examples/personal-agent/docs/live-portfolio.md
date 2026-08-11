# Live portfolio path

Status: implemented as a pure, provider-neutral read-time path; **no live quote
provider is wired** because none exists in the platform today. The seam is
defined and tested; a real provider requires a credential this repo does not
have.

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
introduced. The `QuoteProvider` interface is the only thing to implement; the
fixture provider is a test double and must never be used as a live source.

## Guarantees

- Private holdings (shares, avg cost, account identity, P&L) never enter public
  Market entities.
- No high-frequency quote events are persisted into the public organisation.
- Quotes are computed at read time; a quote failure returns `quote_unavailable`
  (holding + cost basis preserved), never a zero.
- USD and TRY totals stay separate unless an explicit timestamped FX rate is
  supplied.
