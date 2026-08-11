/**
 * Provider-neutral live-quote interface for the portfolio path.
 *
 * No live quote provider ships in the repo today (2026-08): Midas snapshot
 * prices are historical observations, not live quotes, and there is no
 * market-data connector or public ticker/listing schema to reuse. This module
 * defines the seam a future provider implements, plus a deterministic fixture
 * provider that tests (and offline demos) can use. A real provider REQUIRES a
 * credential/service (e.g. a market-data API key); that gap is documented, not
 * fabricated.
 *
 * ## Quote contract
 * Every quote exposes:
 *   - price
 *   - currency
 *   - provider
 *   - as_of
 *   - freshness / stale state
 *   - real-time / delayed / EOD classification when known
 *
 * ## Failure contract
 *   - NEVER return zero as a fallback.
 *   - On a failed lookup, return `quote_unavailable` — the holding and its
 *     cost basis are preserved. A stale quote must carry its timestamp and
 *     explicit stale state; callers decide whether to accept it.
 */

/** Market-data classification of a quote's latency. */
export type QuoteTier = "realtime" | "delayed" | "eod";

export interface Quote {
  /** Discriminator: this is a successful quote. */
  status: "quoted";
  /** Quote price. NEVER zero as a fallback. */
  price: number;
  /** ISO currency code (USD, TRY, …). */
  currency: string;
  /** Provider identifier (e.g. "fixture", "acme-quotes"). */
  provider: string;
  /** ISO timestamp of the quote. */
  asOf: string;
  /** True when the quote is stale relative to the provider's freshness window. */
  stale: boolean;
  /** Latency tier when known. */
  tier: QuoteTier;
}

/** A quote lookup that failed. The holding and its cost basis are preserved. */
export interface QuoteUnavailable {
  status: "quote_unavailable";
  provider: string | null;
  reason: string;
}

export type QuoteResult = Quote | QuoteUnavailable;

/**
 * A provider-neutral quote source keyed by (market, symbol) identity.
 *
 * Implementations return a Quote for a resolvable identity, or QuoteUnavailable
 * (never a zero) when the identity is unknown, the provider is down, or the
 * quote is missing. `isSupported` lets the portfolio path skip identities a
 * provider cannot serve.
 */
export interface QuoteProvider {
  readonly providerId: string;
  /** True when this provider can quote the given market (e.g. "US"). */
  isSupported(market: string): boolean;
  quote(identity: { market: string; symbol: string }): Promise<QuoteResult>;
}

/**
 * Deterministic fixture provider for tests and offline demos.
 *
 * Serves a fixed price per (market, symbol) with a configurable as-of and
 * staleness. It is a TEST DOUBLE — it must never be wired into a production
 * path as if it were a live quote source.
 */
export class FixtureQuoteProvider implements QuoteProvider {
  readonly providerId = "fixture";

  constructor(
    private readonly quotes: Record<
      string,
      { price: number; currency: string }
    >,
    private readonly opts: {
      asOf?: Date | string;
      stale?: boolean;
      tier?: QuoteTier;
    } = {}
  ) {}

  isSupported(market: string): boolean {
    return Object.keys(this.quotes).some((key) =>
      key.toUpperCase().startsWith(`${market.toUpperCase()}:`)
    );
  }

  async quote(identity: {
    market: string;
    symbol: string;
  }): Promise<QuoteResult> {
    const key = `${identity.market.toUpperCase()}:${identity.symbol.toUpperCase()}`;
    const entry = this.quotes[key];
    if (!entry) {
      return {
        status: "quote_unavailable",
        provider: this.providerId,
        reason: `no fixture quote for ${key}`,
      };
    }
    const asOf = this.opts.asOf
      ? new Date(this.opts.asOf).toISOString()
      : new Date().toISOString();
    return {
      status: "quoted",
      price: entry.price,
      currency: entry.currency,
      provider: this.providerId,
      asOf,
      stale: this.opts.stale ?? false,
      tier: this.opts.tier ?? "eod",
    };
  }
}

/** A valid quote is positive, timestamped, and not stale unless opted in. */
export function quotePriceOrUnavailable(
  quote: Quote,
  opts: { allowStale: boolean }
): number | null {
  if (!Number.isFinite(quote.price) || quote.price <= 0) return null;
  if (!Number.isFinite(Date.parse(quote.asOf))) return null;
  if (!opts.allowStale && quote.stale) return null;
  return quote.price;
}
