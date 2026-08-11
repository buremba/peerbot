/**
 * Live-portfolio path — pure calculation + world-model + quote-provider tests.
 *
 * Covers: Midas event → holding mapping, world-model resolution (incl.
 * ALTIN.S1 unresolved), cost/value/P&L math, per-currency separation, quote
 * failure (never zero, holding preserved), stale-quote handling, and the
 * fixture provider. No DB, no SDK — the module is pure.
 */

import { describe, expect, test } from "bun:test";
import {
  FixtureQuoteProvider,
  DEFAULT_FRESHNESS_MS,
  isQuoteFresh,
  quotePriceOrUnavailable,
} from "../portfolio/quote-provider";
import {
  computePortfolio,
  costBasis,
  currentValue,
  holdingFromMidasEvent,
  latestMidasHoldings,
  unrealizedPnl,
  unrealizedPnlPct,
  type MidasHoldingEvent,
} from "../portfolio/portfolio";
import {
  knownTickerIdentities,
  resolveWorldEntity,
  tickerIdentityKey,
  worldEntityCatalogKey,
} from "../portfolio/world-model";

const NVDA_EVENT: MidasHoldingEvent = {
  market: "US",
  symbol: "NVDA",
  shares: 10,
  snapshotPrice: 100,
  avgCost: 80,
  snapshotValue: 1000,
  currency: "USD",
  occurredAt: "2026-08-01T12:00:00.000Z",
};

describe("world-model resolution", () => {
  test("NVDA resolves to company NVIDIA with primary ticker + exchange + listing", () => {
    const e = resolveWorldEntity("US", "NVDA");
    expect(e).not.toBeNull();
    expect(e?.entityType).toBe("company");
    expect(e?.name).toBe("NVIDIA");
    expect(e?.primaryTicker).toBe("NVDA");
    expect(e?.primaryExchange).toBe("XNAS");
    expect(e?.currency).toBe("USD");
    expect(e?.listings).toEqual([
      { symbol: "NVDA", exchangeMic: "XNAS", currency: "USD", isPrimary: true },
    ]);
  });

  test("AAPL / THYAO resolve to Apple / Turkish Airlines", () => {
    expect(resolveWorldEntity("US", "AAPL")?.name).toBe("Apple");
    const thy = resolveWorldEntity("TR", "THYAO");
    expect(thy?.name).toBe("Turkish Airlines");
    expect(thy?.entityType).toBe("company");
    expect(thy?.currency).toBe("TRY");
  });

  test("SPY / IAU resolve to funds (NOT company subtype)", () => {
    const spy = resolveWorldEntity("US", "SPY");
    expect(spy?.entityType).toBe("fund");
    expect(spy?.benchmark).toBe("S&P 500");
    const iau = resolveWorldEntity("US", "IAU");
    expect(iau?.entityType).toBe("fund");
  });

  test("ALTIN.S1 is explicitly unresolved, never guessed", () => {
    expect(resolveWorldEntity("TR", "ALTIN.S1")).toBeNull();
    expect(worldEntityCatalogKey("TR", "ALTIN.S1")).toBeNull();
  });

  test("ticker identity is market-scoped, never symbol alone", () => {
    expect(tickerIdentityKey("US", "nvda")).toBe("US:NVDA");
    expect(tickerIdentityKey("US", "NVDA")).toBe("US:NVDA");
    expect(tickerIdentityKey("TR", "THYAO")).toBe("TR:THYAO");
    expect(tickerIdentityKey("", "NVDA")).toBe("");
  });

  test("known identities are non-empty and market-qualified", () => {
    const known = knownTickerIdentities();
    expect(known.length).toBeGreaterThan(0);
    expect(known.every((k) => k.includes(":"))).toBe(true);
  });
});

describe("Midas event → holding", () => {
  test("maps a financial_asset event preserving snapshot + cost fields", () => {
    const h = holdingFromMidasEvent(NVDA_EVENT);
    expect(h).not.toBeNull();
    expect(h?.market).toBe("US");
    expect(h?.symbol).toBe("NVDA");
    expect(h?.shares).toBe(10);
    expect(h?.avgCost).toBe(80);
    expect(h?.snapshotPrice).toBe(100);
    expect(h?.snapshotValue).toBe(1000);
    expect(h?.worldEntity?.name).toBe("NVIDIA");
  });

  test("accepts the connector's snake_case metadata keys", () => {
    const h = holdingFromMidasEvent({
      type: "TR",
      symbol: "THYAO",
      shares: 25,
      price: 300,
      avg_cost: 250,
      value: 7500,
      currency: "TRY",
    });
    expect(h?.market).toBe("TR");
    expect(h?.avgCost).toBe(250);
    expect(h?.worldEntity?.name).toBe("Turkish Airlines");
  });

  test("returns null for a row missing market or symbol", () => {
    expect(holdingFromMidasEvent({ symbol: "NVDA" } as never)).toBeNull();
    expect(holdingFromMidasEvent({ market: "US" } as never)).toBeNull();
  });

  test("latestMidasHoldings keeps only the newest event per identity", () => {
    const older = { ...NVDA_EVENT, occurredAt: "2026-07-01T00:00:00.000Z" };
    const newer = { ...NVDA_EVENT, occurredAt: "2026-08-10T00:00:00.000Z" };
    const latest = latestMidasHoldings([
      older,
      newer,
      { ...NVDA_EVENT, symbol: "AAPL", occurredAt: "2026-08-05T00:00:00.000Z" },
    ]);
    expect(latest).toHaveLength(2);
    const nvda = latest.find((e) => e.symbol === "NVDA");
    expect(nvda?.occurredAt).toBe("2026-08-10T00:00:00.000Z");
  });
});

describe("portfolio math", () => {
  const quote = {
    status: "quoted" as const,
    price: 120,
    currency: "USD",
    provider: "fixture",
    asOf: new Date().toISOString(),
    stale: false,
    tier: "eod" as const,
  };

  test("cost basis = shares × avg cost", () => {
    expect(costBasis({ shares: 10, avgCost: 80 })).toBe(800);
  });

  test("current value = shares × live price", () => {
    expect(currentValue({ shares: 10 }, quote)).toBe(1200);
  });

  test("unrealized P&L = value − cost", () => {
    expect(unrealizedPnl({ shares: 10, avgCost: 80 }, quote)).toBe(400);
  });

  test("P&L % = value/cost − 1", () => {
    expect(unrealizedPnlPct({ shares: 10, avgCost: 80 }, quote)).toBeCloseTo(
      0.5,
      6
    );
  });

  test("P&L % is null when cost basis is zero", () => {
    expect(unrealizedPnlPct({ shares: 10, avgCost: 0 }, quote)).toBeNull();
  });
});

describe("computePortfolio", () => {
  const now = new Date();

  function holding(partial: Partial<MidasHoldingEvent>): MidasHoldingEvent {
    return { ...NVDA_EVENT, ...partial };
  }

  test("quoted positions carry cost basis, live value, P&L, P&L%", async () => {
    const provider = new FixtureQuoteProvider({
      "US:NVDA": { price: 120, currency: "USD" },
    });
    const res = await computePortfolio({
      holdings: [holdingFromMidasEvent(NVDA_EVENT)!],
      quotes: provider,
    });
    expect(res.positions).toHaveLength(1);
    const p = res.positions[0]!;
    expect(p.quote.status).toBe("quoted");
    expect(p.costBasis).toBe(800);
    expect(p.currentValue).toBe(1200);
    expect(p.unrealizedPnl).toBe(400);
    expect(p.unrealizedPnlPct).toBeCloseTo(0.5, 6);
    expect(p.snapshotPrice).toBe(100);
    expect(p.worldEntity?.name).toBe("NVIDIA");
    expect(res.unquotedPositions).toBe(0);
    expect(res.totals).toEqual([
      {
        currency: "USD",
        costBasis: 800,
        currentValue: 1200,
        unrealizedPnl: 400,
      },
    ]);
  });

  test("an unknown symbol is quote_unavailable, holding + cost basis preserved, never zero", async () => {
    const provider = new FixtureQuoteProvider({});
    const res = await computePortfolio({
      holdings: [
        holdingFromMidasEvent(holding({ symbol: "ALTIN.S1", market: "TR" }))!,
      ],
      quotes: provider,
    });
    const p = res.positions[0]!;
    expect(p.quote.status).toBe("quote_unavailable");
    expect(p.costBasis).toBe(p.shares * p.avgCost);
    expect(p.currentValue).toBeNull();
    expect(p.unrealizedPnl).toBeNull();
    expect(p.worldEntity).toBeNull();
    expect(res.unquotedPositions).toBe(1);
  });

  test("a market the provider cannot serve is quote_unavailable", async () => {
    const provider = new FixtureQuoteProvider({
      "US:NVDA": { price: 120, currency: "USD" },
    });
    const res = await computePortfolio({
      holdings: [
        holdingFromMidasEvent(holding({ market: "TR", symbol: "THYAO" }))!,
      ],
      quotes: provider,
    });
    const p = res.positions[0]!;
    expect(p.quote.status).toBe("quote_unavailable");
    expect(p.currentValue).toBeNull();
  });

  test("a stale quote is treated as quote_unavailable unless allowStale", async () => {
    const stale = new FixtureQuoteProvider(
      { "US:NVDA": { price: 120, currency: "USD" } },
      { stale: true, asOf: new Date(Date.now() - DEFAULT_FRESHNESS_MS * 2) }
    );
    const strict = await computePortfolio({
      holdings: [holdingFromMidasEvent(NVDA_EVENT)!],
      quotes: stale,
    });
    expect(strict.positions[0]!.quote.status).toBe("quote_unavailable");

    const lenient = await computePortfolio({
      holdings: [holdingFromMidasEvent(NVDA_EVENT)!],
      quotes: stale,
      allowStaleQuotes: true,
    });
    expect(lenient.positions[0]!.quote.status).toBe("quoted");
    expect(lenient.positions[0]!.currentValue).toBe(1200);
  });

  test("USD and TRY totals stay separate — never silently combined", async () => {
    const provider = new FixtureQuoteProvider({
      "US:NVDA": { price: 120, currency: "USD" },
      "TR:THYAO": { price: 320, currency: "TRY" },
    });
    const res = await computePortfolio({
      holdings: [
        holdingFromMidasEvent(NVDA_EVENT)!,
        holdingFromMidasEvent(
          holding({
            market: "TR",
            symbol: "THYAO",
            shares: 25,
            avgCost: 250,
            snapshotPrice: 300,
            snapshotValue: 7500,
            currency: "TRY",
          })
        )!,
      ],
      quotes: provider,
    });
    expect(res.totals).toHaveLength(2);
    const usd = res.totals.find((t) => t.currency === "USD")!;
    const tryT = res.totals.find((t) => t.currency === "TRY")!;
    expect(usd.currentValue).toBe(1200);
    expect(tryT.currentValue).toBe(8000);
    expect(usd.costBasis).toBe(800);
    expect(tryT.costBasis).toBe(6250);
  });

  test("quote providers never return zero — a zero-price quote is rejected at the consumer boundary", async () => {
    const zeroQuote = {
      status: "quoted" as const,
      price: 0,
      currency: "USD",
      provider: "fixture",
      asOf: new Date().toISOString(),
      stale: false,
      tier: "eod" as const,
    };
    expect(quotePriceOrUnavailable(zeroQuote, { allowStale: true })).toBeNull();
  });
});

describe("quote freshness", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const quote = {
    status: "quoted" as const,
    price: 1,
    currency: "USD",
    provider: "fixture",
    asOf: now.toISOString(),
    stale: false,
    tier: "eod" as const,
  };

  test("a fresh quote is fresh; an old quote is not", () => {
    expect(isQuoteFresh(quote, now)).toBe(true);
    const old = {
      ...quote,
      asOf: new Date(now.getTime() - DEFAULT_FRESHNESS_MS - 1000).toISOString(),
    };
    expect(isQuoteFresh(old, now)).toBe(false);
  });

  test("a future as-of (clock skew) counts as fresh", () => {
    const future = {
      ...quote,
      asOf: new Date(now.getTime() + 60000).toISOString(),
    };
    expect(isQuoteFresh(future, now)).toBe(true);
  });

  test("quotePriceOrUnavailable honors allowStale", () => {
    const old = {
      ...quote,
      asOf: new Date(now.getTime() - DEFAULT_FRESHNESS_MS - 1000).toISOString(),
    };
    expect(quotePriceOrUnavailable(old, { allowStale: false, now })).toBeNull();
    expect(quotePriceOrUnavailable(old, { allowStale: true, now })).toBe(1);
  });
});
