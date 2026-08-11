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
  resolveWorldEntity,
  tickerIdentityKey,
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
    expect(iau?.fundType).toBe("commodity");
    expect(iau?.benchmark).toBe("LBMA Gold Price");
  });

  test("ALTIN.S1 is explicitly unresolved, never guessed", () => {
    expect(resolveWorldEntity("TR", "ALTIN.S1")).toBeNull();
  });

  test("ticker identity is market-scoped, never symbol alone", () => {
    expect(tickerIdentityKey("US", "nvda")).toBe("US:NVDA");
    expect(tickerIdentityKey("US", "NVDA")).toBe("US:NVDA");
    expect(tickerIdentityKey("TR", "THYAO")).toBe("TR:THYAO");
    expect(tickerIdentityKey("", "NVDA")).toBe("");
  });

  test("fund listings use their NYSE Arca MIC", () => {
    expect(resolveWorldEntity("US", "SPY")?.primaryExchange).toBe("ARCX");
    expect(resolveWorldEntity("US", "IAU")?.primaryExchange).toBe("ARCX");
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
      occurred_at: "2026-08-01T12:00:00.000Z",
    });
    expect(h?.market).toBe("TR");
    expect(h?.avgCost).toBe(250);
    expect(h?.worldEntity?.name).toBe("Turkish Airlines");
  });

  test("returns null for a row missing market or symbol", () => {
    expect(holdingFromMidasEvent({ symbol: "NVDA" } as never)).toBeNull();
    expect(holdingFromMidasEvent({ market: "US" } as never)).toBeNull();
  });

  test("returns null rather than inventing currency or snapshot time", () => {
    expect(
      holdingFromMidasEvent({ ...NVDA_EVENT, currency: "EUR" } as never)
    ).toBeNull();
    expect(
      holdingFromMidasEvent({ ...NVDA_EVENT, occurredAt: "not-a-date" })
    ).toBeNull();
    expect(
      holdingFromMidasEvent({ ...NVDA_EVENT, shares: "10 shares" } as never)
    ).toBeNull();
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
        holdingFromMidasEvent(
          holding({ symbol: "ALTIN.S1", market: "TR", currency: "TRY" })
        )!,
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
        holdingFromMidasEvent(
          holding({ market: "TR", symbol: "THYAO", currency: "TRY" })
        )!,
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
      { stale: true, asOf: new Date(Date.now() - 48 * 60 * 60 * 1000) }
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

  test("invalid and wrong-currency quotes become quote_unavailable", async () => {
    const provider = new FixtureQuoteProvider({
      "TR:THYAO": { price: 0, currency: "USD" },
    });
    const result = await computePortfolio({
      holdings: [
        holdingFromMidasEvent(
          holding({ market: "TR", symbol: "THYAO", currency: "TRY" })
        )!,
      ],
      quotes: provider,
    });
    expect(result.positions[0]?.quote.status).toBe("quote_unavailable");
    expect(result.positions[0]?.currentValue).toBeNull();
    expect(result.totals).toEqual([]);
  });

  test("a thrown provider lookup preserves the holding as quote_unavailable", async () => {
    const provider = {
      providerId: "throwing",
      isSupported: () => true,
      quote: async () => {
        throw new Error("upstream credential leaked here");
      },
    };
    const result = await computePortfolio({
      holdings: [holdingFromMidasEvent(NVDA_EVENT)!],
      quotes: provider,
    });
    expect(result.positions[0]?.quote).toEqual({
      status: "quote_unavailable",
      reason: "quote provider request failed",
      provider: "throwing",
    });
  });
});

describe("quote validation", () => {
  const quote = {
    status: "quoted" as const,
    price: 1,
    currency: "USD",
    provider: "fixture",
    asOf: "2026-08-10T12:00:00.000Z",
    stale: false,
    tier: "eod" as const,
  };

  test("rejects non-positive/non-finite prices and invalid timestamps", () => {
    expect(
      quotePriceOrUnavailable({ ...quote, price: 0 }, { allowStale: true })
    ).toBeNull();
    expect(
      quotePriceOrUnavailable(
        { ...quote, price: Number.NaN },
        { allowStale: true }
      )
    ).toBeNull();
    expect(
      quotePriceOrUnavailable(
        { ...quote, asOf: "invalid" },
        { allowStale: true }
      )
    ).toBeNull();
  });

  test("honors the provider's explicit stale state", () => {
    const stale = { ...quote, stale: true };
    expect(quotePriceOrUnavailable(stale, { allowStale: false })).toBeNull();
    expect(quotePriceOrUnavailable(stale, { allowStale: true })).toBe(1);
  });
});
