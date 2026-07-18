/**
 * Midas connector — extension dispatcher wiring + dashboard DOM text parsing.
 *
 * Guards:
 *  - prod chrome_dispatcher injection (not ctx.channel)
 *  - Atlas TR "Pozisyonlar" table layout (live capture fixture)
 *  - European number format for both USD and TRY on the TR UI
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let MidasConnector: typeof import("../midas.connector").default;
let requireExtensionDispatcher: typeof import("../midas.connector").requireExtensionDispatcher;
let isMidasAuthWall: typeof import("../midas.connector").isMidasAuthWall;
let parseAtlasAmount: typeof import("../midas.connector").parseAtlasAmount;
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
  parseAtlasAmount = mod.parseAtlasAmount;
  parseShares = mod.parseShares;
  parseMidasDashboardText = mod.parseMidasDashboardText;
  holdingToEvent = mod.holdingToEvent;
  balanceToEvent = mod.balanceToEvent;
  MIDAS_DASHBOARD_URL = mod.MIDAS_DASHBOARD_URL;
  MIDAS_ALLOWED_ORIGINS = mod.MIDAS_ALLOWED_ORIGINS;
});

const LIVE_FIXTURE = readFileSync(
  path.join(import.meta.dir, "fixtures/midas-dashboard-positions.txt"),
  "utf8"
);

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
    expect(
      isMidasAuthWall("https://atlas.getmidas.com/dashboard/authorizations")
    ).toBe(false);
  });
});

describe("parseAtlasAmount", () => {
  test("European USD amounts (Atlas TR UI)", () => {
    expect(parseAtlasAmount("$333,69")).toBeCloseTo(333.69, 2);
    expect(parseAtlasAmount("$961.629,23")).toBeCloseTo(961_629.23, 2);
    expect(parseAtlasAmount("$31.786,31")).toBeCloseTo(31_786.31, 2);
    expect(parseAtlasAmount("$168,55")).toBeCloseTo(168.55, 2);
  });

  test("European TRY amounts", () => {
    expect(parseAtlasAmount("₺33,22")).toBeCloseTo(33.22, 2);
    expect(parseAtlasAmount("₺1.273.667,38")).toBeCloseTo(1_273_667.38, 2);
    expect(parseAtlasAmount("₺2.701.994,44")).toBeCloseTo(2_701_994.44, 2);
  });

  test("signed amounts and percent annotations", () => {
    expect(parseAtlasAmount("-$11.492,08(-%1,18)")).toBeCloseTo(-11_492.08, 2);
    expect(parseAtlasAmount("$40,86(%0,13)")).toBeCloseTo(40.86, 2);
    expect(parseAtlasAmount("-₺33.144,87(-%1,21)")).toBeCloseTo(-33_144.87, 2);
  });

  test("must not treat commas as US thousands (old bug)", () => {
    // Old path: strip commas → 33369. New path: 333.69.
    expect(parseAtlasAmount("$333,69")).not.toBeCloseTo(33_369, 0);
    expect(parseAtlasAmount("$333,69")).toBeCloseTo(333.69, 2);
  });
});

describe("parseShares", () => {
  test("fractional US shares use comma decimal", () => {
    expect(parseShares("95,257309547")).toBeCloseTo(95.257309547, 6);
    expect(parseShares("0,328008608")).toBeCloseTo(0.328008608, 6);
  });

  test("TR whole shares use thousand dots", () => {
    expect(parseShares("14.000")).toBe(14_000);
    expect(parseShares("19.027")).toBe(19_027);
    expect(parseShares("1.223")).toBe(1_223);
  });
});

describe("parseMidasDashboardText (live fixture)", () => {
  const snap = () => parseMidasDashboardText(LIVE_FIXTURE);

  test("finds all US + TR holdings from the live capture", () => {
    const s = snap();
    // 17 US + 5 TR from the 2026-07-18 capture
    expect(s.holdings).toHaveLength(22);
    const us = s.holdings.filter((h) => h.type === "US");
    const tr = s.holdings.filter((h) => h.type === "TR");
    expect(us).toHaveLength(17);
    expect(tr).toHaveLength(5);
    expect(us.map((h) => h.symbol)).toContain("AAPL");
    expect(us.map((h) => h.symbol)).toContain("NVDA");
    expect(tr.map((h) => h.symbol)).toEqual([
      "ALTIN.S1",
      "YKBNK",
      "AKBNK",
      "EREGL",
      "THYAO",
    ]);
  });

  test("AAPL row: shares, price, avg_cost, value (not the old corrupt mapping)", () => {
    const aapl = snap().holdings.find((h) => h.symbol === "AAPL");
    expect(aapl).toBeDefined();
    expect(aapl?.currency).toBe("USD");
    expect(aapl?.shares).toBeCloseTo(95.257309547, 5);
    expect(aapl?.price).toBeCloseTo(333.69, 2);
    expect(aapl?.avg_cost).toBeCloseTo(168.55, 2);
    expect(aapl?.value).toBeCloseTo(31_786.31, 2);
    // Guard against the previous off-by-one that set shares=0, price=16855.
    expect(aapl?.shares).toBeGreaterThan(1);
    expect(aapl?.price).toBeLessThan(1000);
  });

  test("YKBNK TR row uses thousand-grouped shares", () => {
    const y = snap().holdings.find((h) => h.symbol === "YKBNK");
    expect(y).toBeDefined();
    expect(y?.currency).toBe("TRY");
    expect(y?.shares).toBe(14_000);
    expect(y?.price).toBeCloseTo(33.22, 2);
    expect(y?.avg_cost).toBeCloseTo(25.36, 2);
    expect(y?.value).toBeCloseTo(465_080, 2);
  });

  test("section totals", () => {
    const s = snap();
    expect(s.total_usd).toBeCloseTo(961_629.23, 2);
    expect(s.total_try).toBeCloseTo(2_701_994.44, 2);
  });

  test("position value ≈ shares × price for AAPL", () => {
    const aapl = snap().holdings.find((h) => h.symbol === "AAPL");
    expect(aapl).toBeDefined();
    if (!aapl) return;
    expect(aapl.shares * aapl.price).toBeCloseTo(aapl.value, 0);
  });

  test("empty / unrelated text yields empty snapshot", () => {
    expect(parseMidasDashboardText("nothing here")).toEqual({
      holdings: [],
      total_usd: 0,
      total_try: 0,
    });
  });
});

describe("event mapping", () => {
  test("holding origin_id is namespaced by market and carries avg_cost", () => {
    const us = holdingToEvent({
      type: "US",
      symbol: "AAPL",
      shares: 95.25,
      price: 333.69,
      avg_cost: 168.55,
      value: 31_786,
      currency: "USD",
    });
    expect(us.origin_id).toBe("midas-holding-US-AAPL");
    expect(us.metadata).toMatchObject({
      shares: 95.25,
      price: 333.69,
      avg_cost: 168.55,
      value: 31_786,
      currency: "USD",
    });
  });

  test("balance event carries both totals", () => {
    const ev = balanceToEvent({
      total_usd: 961_629.23,
      total_try: 2_701_994.44,
    });
    expect(ev.origin_id).toBe("midas-balance");
    expect(ev.metadata).toMatchObject({
      balance: 961_629.23,
      currency: "USD",
      total_try: 2_701_994.44,
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
          return { value: LIVE_FIXTURE };
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

    // 22 holdings + 1 balance
    expect(res.events).toHaveLength(23);
    const aapl = res.events.find(
      (e) => e.origin_id === "midas-holding-US-AAPL"
    );
    expect(aapl).toBeDefined();
    const aaplMeta = (aapl?.metadata ?? {}) as {
      shares?: number;
      price?: number;
      avg_cost?: number;
      value?: number;
    };
    expect(typeof aaplMeta.shares).toBe("number");
    expect(typeof aaplMeta.price).toBe("number");
    expect(aaplMeta.shares as number).toBeCloseTo(95.257309547, 5);
    expect(aaplMeta.price as number).toBeCloseTo(333.69, 2);
    expect(aaplMeta.avg_cost as number).toBeCloseTo(168.55, 2);
    expect(aaplMeta.value as number).toBeCloseTo(31_786.31, 2);

    const bal = res.events.find((e) => e.origin_id === "midas-balance");
    expect(bal).toBeDefined();
    const balMeta = (bal?.metadata ?? {}) as { balance?: number };
    expect(balMeta.balance as number).toBeCloseTo(961_629.23, 2);

    expect(res.metadata).toMatchObject({
      holdings: 22,
      backend: "extension-dom",
    });
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
