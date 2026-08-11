/**
 * Read-time portfolio calculation over Midas holding events.
 *
 * Midas events are the SOURCE OF TRUTH: each `financial_asset` event carries
 * { market (type), symbol, shares, price (snapshot), avg_cost, value
 * (snapshot), currency }. This module maps those events to holdings, resolves
 * them to world-model entities, applies a quote provider, and computes the
 * portfolio — all PURE, at read time, with NO new positions table and NO
 * duplication of acquisition data into a core DB model.
 *
 * The Midas snapshot `price`/`value` are HISTORICAL OBSERVATIONS, not live
 * quotes; this module treats them as `snapshot_price` / `snapshot_value`.
 *
 * ## Currency
 * USD and TRY totals are kept SEPARATE and never silently combined.
 *
 * ## Quote failure
 *   - Never zero as a fallback.
 *   - A failed lookup → `quote_unavailable`, holding + cost basis preserved.
 *   - A provider-supplied stale quote is usable only when its timestamp and
 *     stale state are explicit and the caller opts in.
 */

import {
  quotePriceOrUnavailable,
  type Quote,
  type QuoteProvider,
  type QuoteResult,
} from "./quote-provider";
import {
  resolveWorldEntity,
  tickerIdentityKey,
  type WorldEntity,
} from "./world-model";

/** The raw shape of a Midas `financial_asset` event's metadata. */
export interface MidasHoldingEvent {
  /** Midas market — "US" | "TR". */
  market: string;
  symbol: string;
  /** Acquired quantity (may be fractional). */
  shares: number;
  /** Snapshot price at sync time — HISTORICAL, not live. */
  snapshotPrice: number;
  /** Average acquisition cost per share. */
  avgCost: number;
  /** Snapshot position value at sync time — HISTORICAL. */
  snapshotValue: number;
  currency: "USD" | "TRY";
  /** ISO timestamp of the snapshot. */
  occurredAt: string;
}

/** A holding derived from a Midas event, before quoting. */
export interface Holding {
  market: string;
  symbol: string;
  currency: "USD" | "TRY";
  shares: number;
  avgCost: number;
  snapshotPrice: number;
  snapshotValue: number;
  occurredAt: string;
  /** World-model resolution — null is an explicit unresolved state. */
  worldEntity: WorldEntity | null;
}

export type QuoteState =
  | { status: "quoted"; quote: Quote }
  | { status: "quote_unavailable"; reason: string; provider: string | null };

export interface PortfolioPosition {
  market: string;
  symbol: string;
  currency: "USD" | "TRY";
  shares: number;
  avgCost: number;
  costBasis: number;
  quote: QuoteState;
  /** Live value when quoted; null when quote_unavailable (never zero). */
  currentValue: number | null;
  /** Live P&L when quoted; null when quote_unavailable. */
  unrealizedPnl: number | null;
  /** Live P&L % when quoted and cost basis > 0; null otherwise. */
  unrealizedPnlPct: number | null;
  /** Snapshot observation, preserved from the event (historical). */
  snapshotPrice: number;
  snapshotValue: number;
  /** World-model resolution (null = unresolved). */
  worldEntity: WorldEntity | null;
}

export interface CurrencyTotals {
  currency: "USD" | "TRY";
  /** Sum of cost basis for quoted positions. */
  costBasis: number;
  /** Sum of live value for quoted positions. */
  currentValue: number;
  unrealizedPnl: number;
}

export interface PortfolioResult {
  positions: PortfolioPosition[];
  /** Per-currency totals — never combined across currencies. */
  totals: CurrencyTotals[];
  /** Number of positions that could not be quoted (holding preserved). */
  unquotedPositions: number;
}

/**
 * Map a Midas `financial_asset` event's metadata to a Holding. Accepts both
 * the camelCase contract shape and the snake_case metadata keys the connector
 * emits (`type`, `shares`, `price`, `avg_cost`, `value`, `currency`).
 */
export function holdingFromMidasEvent(
  event: MidasHoldingEvent | Record<string, unknown>
): Holding | null {
  const raw = event as Record<string, unknown>;
  const market = String(raw.market ?? raw.type ?? "").trim();
  const symbol = String(raw.symbol ?? "").trim();
  if (!market || !symbol) return null;

  const num = (v: unknown): number | null => {
    const n =
      typeof v === "number"
        ? v
        : typeof v === "string" && v.trim()
          ? Number(v)
          : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };
  const shares = num(raw.shares);
  const avgCost = num(raw.avg_cost ?? raw.avgCost);
  const snapshotPrice = num(raw.price ?? raw.snapshotPrice);
  const snapshotValue = num(raw.value ?? raw.snapshotValue);
  if (shares == null || avgCost == null || snapshotPrice == null) return null;

  const currencyRaw = String(raw.currency ?? "").toUpperCase();
  if (currencyRaw !== "USD" && currencyRaw !== "TRY") return null;
  const currency = currencyRaw as "USD" | "TRY";
  const occurredAt = String(raw.occurred_at ?? raw.occurredAt ?? "");
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;

  return {
    market: market.toUpperCase(),
    symbol: symbol.toUpperCase(),
    currency,
    shares,
    avgCost,
    snapshotPrice,
    snapshotValue: snapshotValue ?? shares * snapshotPrice,
    occurredAt,
    worldEntity: resolveWorldEntity(market, symbol),
  };
}

/** Cost basis = shares × avg cost. */
export function costBasis(h: Pick<Holding, "shares" | "avgCost">): number {
  return h.shares * h.avgCost;
}

/** Live value = shares × live price. */
export function currentValue(h: Pick<Holding, "shares">, quote: Quote): number {
  return h.shares * quote.price;
}

/** Unrealized P&L = live value − cost basis. */
export function unrealizedPnl(
  h: Pick<Holding, "shares" | "avgCost">,
  quote: Quote
): number {
  return currentValue(h, quote) - costBasis(h);
}

/** Unrealized P&L % = value/cost − 1, when cost basis > 0 (else null). */
export function unrealizedPnlPct(
  h: Pick<Holding, "shares" | "avgCost">,
  quote: Quote
): number | null {
  const cost = costBasis(h);
  if (cost <= 0) return null;
  return currentValue(h, quote) / cost - 1;
}

/**
 * Compute the portfolio. Quote failures NEVER produce a zero: the holding and
 * its cost basis are preserved with an explicit `quote_unavailable` state.
 */
export async function computePortfolio(opts: {
  holdings: Holding[];
  quotes: QuoteProvider;
  /** When false, a stale-but-valid quote is treated as quote_unavailable. */
  allowStaleQuotes?: boolean;
}): Promise<PortfolioResult> {
  const allowStale = opts.allowStaleQuotes ?? false;

  const positions: PortfolioPosition[] = [];
  const totalsByCurrency = new Map<"USD" | "TRY", CurrencyTotals>();

  for (const holding of opts.holdings) {
    const base = {
      market: holding.market,
      symbol: holding.symbol,
      currency: holding.currency,
      shares: holding.shares,
      avgCost: holding.avgCost,
      costBasis: costBasis(holding),
      snapshotPrice: holding.snapshotPrice,
      snapshotValue: holding.snapshotValue,
      worldEntity: holding.worldEntity,
    };

    if (!opts.quotes.isSupported(holding.market)) {
      positions.push({
        ...base,
        quote: {
          status: "quote_unavailable",
          reason: `no quote provider for market ${holding.market}`,
          provider: opts.quotes.providerId,
        },
        currentValue: null,
        unrealizedPnl: null,
        unrealizedPnlPct: null,
      });
      continue;
    }

    let quoteResult: QuoteResult;
    try {
      quoteResult = await opts.quotes.quote({
        market: holding.market,
        symbol: holding.symbol,
      });
    } catch {
      positions.push({
        ...base,
        quote: {
          status: "quote_unavailable",
          reason: "quote provider request failed",
          provider: opts.quotes.providerId,
        },
        currentValue: null,
        unrealizedPnl: null,
        unrealizedPnlPct: null,
      });
      continue;
    }

    if (quoteResult.status === "quote_unavailable") {
      positions.push({
        ...base,
        quote: {
          status: "quote_unavailable",
          reason: quoteResult.reason,
          provider: quoteResult.provider,
        },
        currentValue: null,
        unrealizedPnl: null,
        unrealizedPnlPct: null,
      });
      continue;
    }

    const quote: Quote = quoteResult;
    const quoteCurrency = quote.currency.toUpperCase();
    const usablePrice = quotePriceOrUnavailable(quote, { allowStale });
    if (quoteCurrency !== holding.currency || usablePrice == null) {
      const reason =
        quoteCurrency !== holding.currency
          ? `quote currency ${quote.currency} does not match holding currency ${holding.currency}`
          : quote.stale && !allowStale
            ? `stale quote (as_of ${quote.asOf})`
            : "quote has an invalid price or as_of timestamp";
      positions.push({
        ...base,
        quote: {
          status: "quote_unavailable",
          reason,
          provider: quote.provider,
        },
        currentValue: null,
        unrealizedPnl: null,
        unrealizedPnlPct: null,
      });
      continue;
    }

    const value = holding.shares * usablePrice;
    const cost = costBasis(holding);
    const pnl = value - cost;
    const pct = cost > 0 ? value / cost - 1 : null;

    positions.push({
      ...base,
      quote: { status: "quoted", quote },
      currentValue: value,
      unrealizedPnl: pnl,
      unrealizedPnlPct: pct,
    });

    const totals = totalsByCurrency.get(holding.currency) ?? {
      currency: holding.currency,
      costBasis: 0,
      currentValue: 0,
      unrealizedPnl: 0,
    };
    totals.costBasis += costBasis(holding);
    totals.currentValue += value;
    totals.unrealizedPnl += pnl;
    totalsByCurrency.set(holding.currency, totals);
  }

  const unquotedPositions = positions.filter(
    (p) => p.quote.status !== "quoted"
  ).length;

  return {
    positions,
    totals: [...totalsByCurrency.values()],
    unquotedPositions,
  };
}

/** The last Midas holding event per (market, symbol) — latest occurredAt wins. */
export function latestMidasHoldings(
  events: MidasHoldingEvent[]
): MidasHoldingEvent[] {
  const latest = new Map<string, MidasHoldingEvent>();
  for (const event of events) {
    const key = tickerIdentityKey(event.market, event.symbol);
    const current = latest.get(key);
    if (!current || new Date(event.occurredAt) > new Date(current.occurredAt)) {
      latest.set(key, event);
    }
  }
  return [...latest.values()];
}
