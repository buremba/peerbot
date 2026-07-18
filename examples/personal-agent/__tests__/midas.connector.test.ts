/**
 * Midas connector — extension dispatcher wiring + dashboard DOM text parsing.
 *
 * Guards the prod failure mode where Owletto was online but sync threw
 * "requires a ChromeActionDispatcher" because the connector read `ctx.channel`
 * instead of `sessionState.chrome_dispatcher`. Also locks locale amount
 * parsing (TR vs US) and origin_id namespacing by market.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let MidasConnector: typeof import("../midas.connector").default;
let requireExtensionDispatcher: typeof import("../midas.connector").requireExtensionDispatcher;
let isMidasAuthWall: typeof import("../midas.connector").isMidasAuthWall;
let parseLocaleAmount: typeof import("../midas.connector").parseLocaleAmount;
let parseShares: typeof import("../midas.connector").parseShares;
let parseMidasDashboardText: typeof import("../midas.connector").parseMidasDashboardText;
let holdingToEvent: typeof import("../midas.connector").holdingToEvent;
let balanceToEvent: typeof import("../midas.connector").balanceToEvent;
let MIDAS_DASHBOARD_URL: typeof import("../midas.connector").MIDAS_DASHBOARD_URL;
let MIDAS_ALLOWED_ORIGINS: typeof import("../midas.connector").MIDAS_ALLOWED_ORIGINS;

beforeAll(async () => {
  const mod = await import("../midas.connector");
  MidasConnector = mod.default;
  requireExtensionDispatcher = mod.requireExtensionDispatcher;
  isMidasAuthWall = mod.isMidasAuthWall;
  parseLocaleAmount = mod.parseLocaleAmount;
  parseShares = mod.parseShares;
  parseMidasDashboardText = mod.parseMidasDashboardText;
  holdingToEvent = mod.holdingToEvent;
  balanceToEvent = mod.balanceToEvent;
  MIDAS_DASHBOARD_URL = mod.MIDAS_DASHBOARD_URL;
  MIDAS_ALLOWED_ORIGINS = mod.MIDAS_ALLOWED_ORIGINS;
});

/** Synthetic Atlas body text matching the layout the scraper expects. */
const SAMPLE_DASHBOARD_TEXT = `
Portfolio
ABD Hisseleri
AAPL
MSFT
BIST Hisseleri
THYAO
2
$12,345.67
+1.2%
Daily change
Label
1.5
$190.50
+0.5%
$285.75
USD
extra1
extra2
0.25
$420.00
-1.0%
$105.00
USD
extra1
extra2
1
₺50.000,00
+2%
Daily change
Label
10
₺150,25
+1%
₺1.502,50
TRY
extra1
extra2
`.trim();

describe("requireExtensionDispatcher", () => {
  test("throws when chrome_dispatcher is missing (the prod failure mode)", () => {
    expect(() => requireExtensionDispatcher({ sessionState: {} })).toThrow(
      /chrome_dispatcher/
    );
    expect(() => requireExtensionDispatcher({ sessionState: null })).toThrow(
      /chrome_dispatcher/
    );
    expect(() => requireExtensionDispatcher({})).toThrow(/chrome_dispatcher/);
  });

  test("does not accept ctx.channel — only sessionState.chrome_dispatcher", () => {
    // A fake "channel" with dispatch must NOT satisfy the helper; production
    // was wrongly casting ctx.channel and always saw it as undefined/wrong shape.
    const channelish = { dispatch: async () => ({}) };
    expect(() =>
      requireExtensionDispatcher({
        sessionState: { channel: channelish } as Record<string, unknown>,
      })
    ).toThrow(/chrome_dispatcher/);
  });

  test("returns the injected chrome_dispatcher handle", () => {
    const handle = { dispatch: async () => ({ tab_id: 1 }) };
    expect(
      requireExtensionDispatcher({
        sessionState: { chrome_dispatcher: handle },
      })
    ).toBe(handle);
  });
});

describe("isMidasAuthWall", () => {
  test("dashboard is not an auth wall", () => {
    expect(isMidasAuthWall(MIDAS_DASHBOARD_URL)).toBe(false);
    expect(isMidasAuthWall("https://atlas.getmidas.com/dashboard?x=1")).toBe(
      false
    );
  });

  test("login / sso paths are auth walls", () => {
    expect(isMidasAuthWall("https://atlas.getmidas.com/login")).toBe(true);
    expect(isMidasAuthWall("https://atlas.getmidas.com/signin")).toBe(true);
    expect(isMidasAuthWall("https://sso.getmidas.com/oauth")).toBe(true);
    expect(isMidasAuthWall("https://atlas.getmidas.com/auth/callback")).toBe(
      true
    );
  });

  test("does not treat arbitrary substrings as auth walls", () => {
    // "auth" must be a path segment, not a substring of an unrelated slug.
    expect(
      isMidasAuthWall("https://atlas.getmidas.com/dashboard/authorizations")
    ).toBe(false);
  });
});

describe("parseLocaleAmount", () => {
  test("US: commas are thousands, dot is decimal", () => {
    expect(parseLocaleAmount("$1,234.56", "US")).toBeCloseTo(1234.56, 2);
    expect(parseLocaleAmount("190.50", "US")).toBeCloseTo(190.5, 2);
    expect(parseLocaleAmount("", "US")).toBe(0);
  });

  test("TR: dots are thousands, comma is decimal (old parser corrupted this)", () => {
    expect(parseLocaleAmount("₺1.234,56", "TR")).toBeCloseTo(1234.56, 2);
    expect(parseLocaleAmount("₺50.000,00", "TR")).toBeCloseTo(50000, 2);
    expect(parseLocaleAmount("150,25", "TR")).toBeCloseTo(150.25, 2);
    // The buggy path `replace(/[^0-9.-]/g,'')` would turn 1.234,56 into 1.23456.
    expect(parseLocaleAmount("1.234,56", "TR")).not.toBeCloseTo(1.23456, 4);
  });
});

describe("parseShares", () => {
  test("US decimal shares", () => {
    expect(parseShares("1.5", "US")).toBeCloseTo(1.5, 5);
    expect(parseShares("1,500", "US")).toBeCloseTo(1500, 5);
  });

  test("TR shares with thousand dots", () => {
    expect(parseShares("1.500", "TR")).toBeCloseTo(1500, 5);
    expect(parseShares("10,5", "TR")).toBeCloseTo(10.5, 5);
  });
});

describe("parseMidasDashboardText", () => {
  test("finds US + TR holdings", () => {
    const snap = parseMidasDashboardText(SAMPLE_DASHBOARD_TEXT);
    expect(snap.holdings).toHaveLength(3);
    const bySym = Object.fromEntries(snap.holdings.map((h) => [h.symbol, h]));
    expect(bySym.AAPL.type).toBe("US");
    expect(bySym.AAPL.currency).toBe("USD");
    expect(bySym.AAPL.shares).toBeCloseTo(1.5, 5);
    expect(bySym.AAPL.price).toBeCloseTo(190.5, 2);
    expect(bySym.AAPL.value).toBeCloseTo(285.75, 2);

    expect(bySym.MSFT.shares).toBeCloseTo(0.25, 5);
    expect(bySym.MSFT.value).toBeCloseTo(105, 2);

    expect(bySym.THYAO.type).toBe("TR");
    expect(bySym.THYAO.currency).toBe("TRY");
    expect(bySym.THYAO.shares).toBeCloseTo(10, 5);
    expect(bySym.THYAO.price).toBeCloseTo(150.25, 2);
    expect(bySym.THYAO.value).toBeCloseTo(1502.5, 2);
  });

  test("parses section totals with locale rules", () => {
    const snap = parseMidasDashboardText(SAMPLE_DASHBOARD_TEXT);
    expect(snap.total_usd).toBeCloseTo(12345.67, 2);
    expect(snap.total_try).toBeCloseTo(50000, 2);
  });

  test("empty / unrelated text yields empty snapshot", () => {
    expect(parseMidasDashboardText("nothing here")).toEqual({
      holdings: [],
      total_usd: 0,
      total_try: 0,
    });
  });

  test("tickers with digits (e.g. 3M) are not treated as section markers", () => {
    const text = `
ABD Hisseleri
3M
AAPL
1
$100.00
x
y
z
2
$50.00
+0%
$100.00
USD
a
b
5
$20.00
+0%
$100.00
USD
a
b
`.trim();
    const snap = parseMidasDashboardText(text);
    expect(snap.holdings.map((h) => h.symbol)).toEqual(["3M", "AAPL"]);
    expect(snap.holdings[0].shares).toBeCloseTo(2, 5);
    expect(snap.holdings[1].shares).toBeCloseTo(5, 5);
  });
});

describe("event mapping", () => {
  test("holding origin_id is namespaced by market", () => {
    const us = holdingToEvent({
      type: "US",
      symbol: "AAPL",
      shares: 1,
      price: 1,
      value: 1,
      currency: "USD",
    });
    const tr = holdingToEvent({
      type: "TR",
      symbol: "AAPL",
      shares: 1,
      price: 1,
      value: 1,
      currency: "TRY",
    });
    expect(us.origin_id).toBe("midas-holding-US-AAPL");
    expect(tr.origin_id).toBe("midas-holding-TR-AAPL");
    expect(us.origin_id).not.toBe(tr.origin_id);
    expect(us.semantic_type).toBe("financial_asset");
    expect(us.payload_text).toContain("AAPL");
  });

  test("balance event carries both totals", () => {
    const ev = balanceToEvent({ total_usd: 10, total_try: 20 });
    expect(ev.origin_id).toBe("midas-balance");
    expect(ev.semantic_type).toBe("balance_raw");
    expect(ev.metadata).toMatchObject({
      balance: 10,
      currency: "USD",
      total_try: 20,
    });
  });
});

describe("MidasConnector.sync", () => {
  test("uses sessionState.chrome_dispatcher and emits holdings + balance", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const dispatcher = {
      dispatch: async (action: string, input: Record<string, unknown>) => {
        calls.push({ action, input });
        if (action === "navigate") {
          return {
            tab_id: 42,
            current_url: MIDAS_DASHBOARD_URL,
          };
        }
        if (action === "evaluate") {
          return { value: SAMPLE_DASHBOARD_TEXT };
        }
        return {};
      },
    };

    const connector = new MidasConnector();
    const res = await connector.sync({
      feedKey: "assets",
      config: {},
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    } as never);

    expect(calls[0].action).toBe("navigate");
    expect(calls[0].input.url).toBe(MIDAS_DASHBOARD_URL);
    expect(calls[0].input.wait_for_load).toBe(true);
    expect(calls[0].input.allowed_origins).toEqual([...MIDAS_ALLOWED_ORIGINS]);
    expect(calls[1].action).toBe("evaluate");
    expect(calls[1].input.tab_id).toBe(42);

    // 3 holdings + 1 balance
    expect(res.events).toHaveLength(4);
    expect(res.events.map((e) => e.origin_id)).toEqual([
      "midas-holding-US-AAPL",
      "midas-holding-US-MSFT",
      "midas-holding-TR-THYAO",
      "midas-balance",
    ]);
    expect(res.metadata).toMatchObject({
      holdings: 3,
      backend: "extension-dom",
    });
    expect((res.checkpoint as { last_run?: string }).last_run).toBeTruthy();
  });

  test("throws a clear error when chrome_dispatcher is missing", async () => {
    const connector = new MidasConnector();
    await expect(
      connector.sync({
        feedKey: "assets",
        config: {},
        checkpoint: {},
        sessionState: {},
      } as never)
    ).rejects.toThrow(/chrome_dispatcher/);
  });

  test("throws on auth-wall landing URL and notifies", async () => {
    const calls: string[] = [];
    const dispatcher = {
      dispatch: async (action: string, _input: Record<string, unknown>) => {
        calls.push(action);
        if (action === "navigate") {
          return {
            tab_id: 1,
            current_url: "https://atlas.getmidas.com/login",
          };
        }
        return {};
      },
    };
    const connector = new MidasConnector();
    await expect(
      connector.sync({
        feedKey: "assets",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/sign-in/i);
    expect(calls).toContain("show_notification");
  });

  test("throws on unknown feed", async () => {
    const dispatcher = { dispatch: async () => ({}) };
    const connector = new MidasConnector();
    await expect(
      connector.sync({
        feedKey: "nope",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/Unknown feed/);
  });

  test("throws when dashboard text cannot be parsed", async () => {
    const dispatcher = {
      dispatch: async (action: string) => {
        if (action === "navigate") {
          return { tab_id: 1, current_url: MIDAS_DASHBOARD_URL };
        }
        return { value: "empty shell, no sections" };
      },
    };
    const connector = new MidasConnector();
    await expect(
      connector.sync({
        feedKey: "assets",
        config: {},
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      } as never)
    ).rejects.toThrow(/Failed to parse Midas dashboard/);
  });
});
