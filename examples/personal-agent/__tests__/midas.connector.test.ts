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

// Synthetic Atlas TR "Pozisyonlar" capture — layout mirrors production, values
// are fabricated (no real holdings/quantities/prices) to avoid committing PII.
const DASHBOARD_FIXTURE = readFileSync(
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
    expect(parseAtlasAmount("$123,45")).toBeCloseTo(123.45, 2);
    expect(parseAtlasAmount("$12.345,67")).toBeCloseTo(12_345.67, 2);
    expect(parseAtlasAmount("$1.000,00")).toBeCloseTo(1_000, 2);
    expect(parseAtlasAmount("$99,90")).toBeCloseTo(99.9, 2);
  });

  test("European TRY amounts", () => {
    expect(parseAtlasAmount("₺45,60")).toBeCloseTo(45.6, 2);
    expect(parseAtlasAmount("₺1.234.567,89")).toBeCloseTo(1_234_567.89, 2);
    expect(parseAtlasAmount("₺2.000.000,00")).toBeCloseTo(2_000_000, 2);
  });

  test("signed amounts and percent annotations", () => {
    expect(parseAtlasAmount("-$1.500,50(-%2,00)")).toBeCloseTo(-1_500.5, 2);
    expect(parseAtlasAmount("$40,00(%0,10)")).toBeCloseTo(40, 2);
    expect(parseAtlasAmount("-₺2.500,75(-%1,50)")).toBeCloseTo(-2_500.75, 2);
  });

  test("must not treat commas as US thousands (old bug)", () => {
    // Old path: strip commas → 12345. New path: 123.45.
    expect(parseAtlasAmount("$123,45")).not.toBeCloseTo(12_345, 0);
    expect(parseAtlasAmount("$123,45")).toBeCloseTo(123.45, 2);
  });
});

describe("parseShares", () => {
  test("fractional US shares use comma decimal", () => {
    expect(parseShares("12,345678")).toBeCloseTo(12.345678, 6);
    expect(parseShares("0,5")).toBeCloseTo(0.5, 6);
  });

  test("TR whole shares use thousand dots", () => {
    expect(parseShares("1.000")).toBe(1_000);
    expect(parseShares("2.500")).toBe(2_500);
    expect(parseShares("10.000")).toBe(10_000);
  });
});

describe("parseMidasDashboardText (synthetic fixture)", () => {
  const snap = () => parseMidasDashboardText(DASHBOARD_FIXTURE);

  test("finds all US + TR holdings from the fixture", () => {
    const s = snap();
    // 3 US + 2 TR synthetic holdings preserving the Atlas TR layout.
    expect(s.holdings).toHaveLength(5);
    const us = s.holdings.filter((h) => h.type === "US");
    const tr = s.holdings.filter((h) => h.type === "TR");
    expect(us).toHaveLength(3);
    expect(tr).toHaveLength(2);
    expect(us.map((h) => h.symbol)).toContain("ACME");
    expect(us.map((h) => h.symbol)).toContain("NOVA");
    expect(tr.map((h) => h.symbol)).toEqual(["BANKX", "GOLD.S1"]);
  });

  test("ACME row: shares, price, avg_cost, value (not the old corrupt mapping)", () => {
    const acme = snap().holdings.find((h) => h.symbol === "ACME");
    expect(acme).toBeDefined();
    expect(acme?.currency).toBe("USD");
    expect(acme?.shares).toBeCloseTo(10.5, 5);
    expect(acme?.price).toBeCloseTo(200, 2);
    expect(acme?.avg_cost).toBeCloseTo(150, 2);
    expect(acme?.value).toBeCloseTo(2_100, 2);
    // Guard against the previous off-by-one that set shares=0, price=avg_cost.
    expect(acme?.shares).toBeGreaterThan(1);
    expect(acme?.price).toBeLessThan(1000);
  });

  test("BANKX TR row uses thousand-grouped shares", () => {
    const y = snap().holdings.find((h) => h.symbol === "BANKX");
    expect(y).toBeDefined();
    expect(y?.currency).toBe("TRY");
    expect(y?.shares).toBe(1_000);
    expect(y?.price).toBeCloseTo(3, 2);
    expect(y?.avg_cost).toBeCloseTo(2.5, 2);
    expect(y?.value).toBeCloseTo(3_000, 2);
  });

  test("section totals", () => {
    const s = snap();
    expect(s.total_usd).toBeCloseTo(10_000, 2);
    expect(s.total_try).toBeCloseTo(5_000, 2);
  });

  test("position value ≈ shares × price for ACME", () => {
    const acme = snap().holdings.find((h) => h.symbol === "ACME");
    expect(acme).toBeDefined();
    if (!acme) return;
    expect(acme.shares * acme.price).toBeCloseTo(acme.value, 0);
  });

  test("empty / unrelated text yields empty snapshot", () => {
    expect(parseMidasDashboardText("nothing here")).toEqual({
      holdings: [],
      total_usd: 0,
      total_try: 0,
    });
  });

  test("malformed rows are skipped, not emitted as zero-valued holdings", () => {
    // Second holding row is non-numeric (layout drift). The parser must stop
    // rather than push a corrupt { shares: 0, price: 0, value: 0 } holding.
    const drifted = [
      "ABD Hisseleri",
      "ACME",
      "GLOB",
      "2",
      "$1.000,00",
      "$10,00(%1,00)",
      "$100,00(%10,00)",
      "10",
      "$50,00",
      "$40,00",
      "$500,00",
      "%50,00",
      "$5,00(%1,00)",
      "$50,00(%12,50)",
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "n/a",
      "n/a",
    ].join("\n");
    const s = parseMidasDashboardText(drifted);
    expect(s.holdings.map((h) => h.symbol)).toEqual(["ACME"]);
    expect(s.holdings.every((h) => h.value > 0)).toBe(true);
  });
});

describe("event mapping", () => {
  test("holding origin_id is namespaced by market and carries avg_cost", () => {
    const us = holdingToEvent({
      type: "US",
      symbol: "ACME",
      shares: 10.5,
      price: 200,
      avg_cost: 150,
      value: 2_100,
      currency: "USD",
    });
    expect(us.origin_id).toBe("midas-holding-US-ACME");
    expect(us.metadata).toMatchObject({
      shares: 10.5,
      price: 200,
      avg_cost: 150,
      value: 2_100,
      currency: "USD",
    });
  });

  test("balance event carries both totals", () => {
    const ev = balanceToEvent({
      total_usd: 10_000,
      total_try: 5_000,
    });
    expect(ev.origin_id).toBe("midas-balance");
    expect(ev.metadata).toMatchObject({
      balance: 10_000,
      currency: "USD",
      total_try: 5_000,
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
          return { value: DASHBOARD_FIXTURE };
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

    // 5 holdings + 1 balance
    expect(res.events).toHaveLength(6);
    const acme = res.events.find(
      (e) => e.origin_id === "midas-holding-US-ACME"
    );
    expect(acme).toBeDefined();
    const acmeMeta = (acme?.metadata ?? {}) as {
      shares?: number;
      price?: number;
      avg_cost?: number;
      value?: number;
    };
    expect(typeof acmeMeta.shares).toBe("number");
    expect(typeof acmeMeta.price).toBe("number");
    expect(acmeMeta.shares as number).toBeCloseTo(10.5, 5);
    expect(acmeMeta.price as number).toBeCloseTo(200, 2);
    expect(acmeMeta.avg_cost as number).toBeCloseTo(150, 2);
    expect(acmeMeta.value as number).toBeCloseTo(2_100, 2);

    const bal = res.events.find((e) => e.origin_id === "midas-balance");
    expect(bal).toBeDefined();
    const balMeta = (bal?.metadata ?? {}) as { balance?: number };
    expect(balMeta.balance as number).toBeCloseTo(10_000, 2);

    expect(res.metadata).toMatchObject({
      holdings: 5,
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
