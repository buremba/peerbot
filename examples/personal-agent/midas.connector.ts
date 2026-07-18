import {
  type ChromeActionDispatcher,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

/** Atlas web app dashboard — holdings live here when the user is signed in. */
export const MIDAS_DASHBOARD_URL = "https://atlas.getmidas.com/dashboard";

/**
 * Origins the Owletto extension may touch for this connector. Forwarded on
 * every chrome action so the extension's origin gate stays locked down.
 */
export const MIDAS_ALLOWED_ORIGINS = [
  "getmidas.com",
  "*.getmidas.com",
] as const;

export type MidasMarket = "US" | "TR";

export interface MidasHolding {
  type: MidasMarket;
  symbol: string;
  shares: number;
  price: number;
  value: number;
  currency: "USD" | "TRY";
}

export interface MidasDashboardSnapshot {
  holdings: MidasHolding[];
  total_usd: number;
  total_try: number;
}

export interface MidasCheckpoint {
  last_run?: string;
}

/**
 * Pull the chrome action dispatcher from sessionState.
 *
 * The connector-worker subprocess (child-runner.ts) splices a live
 * `chrome_dispatcher` object onto every sync's sessionState; `dispatch()`
 * rides IPC up to the daemon and out through the gateway chrome-action
 * bridge to a paired Owletto extension. Looking at `ctx.channel` is wrong —
 * that field is the chat/channel facet, not the extension bridge (prod failure:
 * "MidasConnector requires a ChromeActionDispatcher" with Owletto online).
 */
export function requireExtensionDispatcher(ctx: {
  sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
  const handle = (
    ctx.sessionState as Record<string, unknown> | null | undefined
  )?.chrome_dispatcher as ChromeActionDispatcher | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "Midas connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge."
    );
  }
  return handle;
}

/**
 * True when navigate landed on a sign-in / SSO wall rather than the dashboard.
 * Atlas redirects unauthenticated users off `/dashboard`.
 */
export function isMidasAuthWall(url: string | null | undefined): boolean {
  if (!url) return false;
  let pathname: string;
  let host = "";
  try {
    const u = new URL(url);
    pathname = u.pathname.toLowerCase();
    host = u.hostname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  if (host.includes("sso.") || host.includes("login.")) return true;
  // Path segments only — avoid substring false-positives on unrelated routes.
  const segments = pathname.split("/").filter(Boolean);
  return segments.some((seg) =>
    [
      "login",
      "signin",
      "sign-in",
      "signup",
      "sign-up",
      "register",
      "auth",
      "oauth",
      "sso",
    ].includes(seg)
  );
}

/**
 * Parse a money string for the given market locale.
 *
 * - US: `$1,234.56` → 1234.56 (comma thousands, dot decimal)
 * - TR: `₺1.234,56` → 1234.56 (dot thousands, comma decimal)
 *
 * The original connector used a single `replace(/[^0-9.-]/g, '')` path which
 * mis-parsed TR amounts (`1.234,56` → `1.23456`).
 */
export function parseLocaleAmount(
  raw: string | null | undefined,
  market: MidasMarket
): number {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  if (market === "TR") {
    // Drop currency symbols / letters / spaces; keep digits, separators, sign.
    const cleaned = s.replace(/[^\d.,-]/g, "");
    // Last comma is decimal; dots are thousands.
    const normalized = cleaned.replace(/\./g, "").replace(",", ".");
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : 0;
  }

  // US / default: drop everything except digits, dots, minus; strip commas.
  const cleaned = s.replace(/,/g, "").replace(/[^\d.-]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Share quantity: US uses `.` decimal; TR commonly uses `.` thousands + `,` decimal.
 */
export function parseShares(
  raw: string | null | undefined,
  market: MidasMarket
): number {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  if (market === "TR") {
    const n = Number.parseFloat(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number.parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * True when a dashboard line looks like a numeric section marker, not a ticker.
 * Tickers may include digits (`3M`, `BRK.B`); counts/money/percents may not be
 * pure symbol tokens.
 */
function looksLikeNumberLine(line: string): boolean {
  // Alphanumeric symbol token (letters required) → ticker, never a section marker.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(line) && /[A-Za-z]/.test(line)) {
    return false;
  }
  // Counts ("2"), money ("$1,234.56", "₺50.000,00"), percents ("+1.2%").
  return /\d/.test(line);
}

/**
 * Parse the Atlas dashboard body text into holdings + totals.
 *
 * Layout observed on the Turkish Atlas UI (section headers in TR):
 *
 *   ABD Hisseleri
 *   <US tickers…>
 *   BIST Hisseleri
 *   <TR tickers…>
 *   <usCount>
 *   <totalUsd>
 *   <3 label lines>
 *   per US holding × 7 lines: shares, price, ?, value, ?, ?, ?
 *   <trCount>
 *   <totalTry>
 *   <3 label lines>
 *   per TR holding × 7 lines (same shape)
 *
 * Pure function so unit tests can fixture the DOM text without Owletto.
 */
export function parseMidasDashboardText(text: string): MidasDashboardSnapshot {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const usStartIdx = lines.indexOf("ABD Hisseleri");
  const trStartIdx = lines.indexOf("BIST Hisseleri");

  const usTickers: string[] = [];
  const trTickers: string[] = [];

  if (usStartIdx !== -1 && trStartIdx !== -1) {
    for (let i = usStartIdx + 1; i < trStartIdx; i++) {
      if (!looksLikeNumberLine(lines[i])) usTickers.push(lines[i]);
    }
  } else if (usStartIdx !== -1) {
    for (let i = usStartIdx + 1; i < lines.length; i++) {
      if (looksLikeNumberLine(lines[i])) break;
      usTickers.push(lines[i]);
    }
  }

  if (trStartIdx !== -1) {
    for (let i = trStartIdx + 1; i < lines.length; i++) {
      if (looksLikeNumberLine(lines[i])) break;
      trTickers.push(lines[i]);
    }
  }

  // After the ticker name lists, numeric blocks start at the first count line.
  let currentIdx = 0;
  if (trStartIdx !== -1) {
    currentIdx = trStartIdx + 1 + trTickers.length;
  } else if (usStartIdx !== -1) {
    currentIdx = usStartIdx + 1 + usTickers.length;
  }

  const holdings: MidasHolding[] = [];
  let totalUsd = 0;
  let totalTry = 0;

  const readBlock = (
    tickers: string[],
    market: MidasMarket,
    currency: "USD" | "TRY"
  ): number => {
    if (currentIdx >= lines.length || tickers.length === 0) return 0;
    // count line
    currentIdx += 1;
    const total = parseLocaleAmount(lines[currentIdx], market);
    currentIdx += 1;
    // three label / change lines after the total
    currentIdx += 3;

    for (const symbol of tickers) {
      const shares = parseShares(lines[currentIdx], market);
      const price = parseLocaleAmount(lines[currentIdx + 1], market);
      const value = parseLocaleAmount(lines[currentIdx + 3], market);
      holdings.push({
        symbol,
        shares,
        price,
        value,
        currency,
        type: market,
      });
      currentIdx += 7;
    }
    return total;
  };

  // Numeric section order is US then TR (matches the original scraper).
  totalUsd = readBlock(usTickers, "US", "USD");
  totalTry = readBlock(trTickers, "TR", "TRY");

  return { holdings, total_usd: totalUsd, total_try: totalTry };
}

export function holdingToEvent(
  h: MidasHolding,
  occurredAt: Date = new Date()
): EventEnvelope {
  // Namespace by market so a dual-listed ticker cannot collide on origin_id.
  return {
    origin_id: `midas-holding-${h.type}-${h.symbol}`,
    title: `Midas Holding: ${h.symbol}`,
    payload_text: `${h.symbol} (${h.type}): ${h.shares} @ ${h.price} ${h.currency} = ${h.value} ${h.currency}`,
    occurred_at: occurredAt,
    semantic_type: "financial_asset",
    source_url: MIDAS_DASHBOARD_URL,
    metadata: {
      type: h.type,
      symbol: h.symbol,
      shares: h.shares,
      price: h.price,
      value: h.value,
      currency: h.currency,
    },
  };
}

export function balanceToEvent(
  snapshot: Pick<MidasDashboardSnapshot, "total_usd" | "total_try">,
  occurredAt: Date = new Date()
): EventEnvelope {
  return {
    origin_id: "midas-balance",
    title: "Midas Balance",
    payload_text: `Midas totals: $${snapshot.total_usd} USD / ₺${snapshot.total_try} TRY`,
    occurred_at: occurredAt,
    semantic_type: "balance_raw",
    source_url: MIDAS_DASHBOARD_URL,
    metadata: {
      balance: snapshot.total_usd,
      currency: "USD",
      total_try: snapshot.total_try,
    },
  };
}

async function notifyMidasAuthWall(
  dispatcher: ChromeActionDispatcher,
  landedUrl: string
): Promise<void> {
  try {
    await dispatcher.dispatch("show_notification", {
      notification_id: "midas-auth-wall",
      title: "Midas needs sign-in",
      message:
        "Sign in to Midas in the focused Chrome window, then re-run the sync.",
      body: "Sign in to Midas in the focused Chrome window, then re-run the sync.",
      landed_url: landedUrl,
      click_url: landedUrl,
    });
  } catch {
    // Best-effort UX; never mask the auth-wall error.
  }
}

export default class MidasConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "midas",
    name: "Midas",
    description:
      "Syncs Midas portfolio holdings via the Owletto Chrome extension.",
    version: "1.0.1",
    faviconDomain: "atlas.getmidas.com",
    authSchema: {
      methods: [{ type: "none" }],
    },
    feeds: {
      assets: {
        key: "assets",
        name: "Midas Holdings",
        description:
          "Scrapes Midas portfolio holdings from atlas.getmidas.com.",
        configSchema: { type: "object", properties: {} },
        eventKinds: {
          financial_asset: {
            description: "A financial asset holding",
            metadataSchema: {
              type: "object",
              properties: {
                type: { type: "string" },
                symbol: { type: "string" },
                shares: { type: "number" },
                price: { type: "number" },
                value: { type: "number" },
                currency: { type: "string" },
              },
            },
          },
          balance_raw: {
            description: "Midas Total Balance",
            metadataSchema: {
              type: "object",
              properties: {
                balance: { type: "number" },
                currency: { type: "string" },
                total_try: { type: "number" },
              },
            },
          },
        },
      },
    },
    optionsSchema: { type: "object", properties: {} },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (ctx.feedKey !== "assets") {
      throw new Error(`Unknown feed: ${ctx.feedKey}`);
    }

    const dispatcher = requireExtensionDispatcher(ctx);

    const nav = await dispatcher.dispatch<{
      tab_id: number;
      current_url?: string;
    }>("navigate", {
      url: MIDAS_DASHBOARD_URL,
      persistent: true,
      window_focused: false,
      // Wait for frame stop — better than a blind 5s sleep that still races SPAs.
      wait_for_load: true,
      allowed_origins: [...MIDAS_ALLOWED_ORIGINS],
    });

    const landedUrl = nav.current_url ?? MIDAS_DASHBOARD_URL;
    if (isMidasAuthWall(landedUrl)) {
      await notifyMidasAuthWall(dispatcher, landedUrl);
      throw new Error(
        `Midas session needs sign-in (landed on ${landedUrl}). Sign in at atlas.getmidas.com in this Chrome profile, then re-run the sync.`
      );
    }

    if (typeof nav.tab_id !== "number") {
      throw new Error(
        "Midas navigate did not return a tab_id — Owletto may have failed to open the dashboard."
      );
    }

    // SPA settle: wait inside the page, then return body text for pure parsing.
    const textObs = await dispatcher.dispatch<{ value?: string }>("evaluate", {
      tab_id: nav.tab_id,
      expression: `(async () => {
        await new Promise((r) => setTimeout(r, 2500));
        return document.body ? document.body.innerText : "";
      })()`,
      allowed_origins: [...MIDAS_ALLOWED_ORIGINS],
    });

    const bodyText = textObs.value ?? "";
    const snapshot = parseMidasDashboardText(bodyText);

    if (
      snapshot.holdings.length === 0 &&
      snapshot.total_usd === 0 &&
      snapshot.total_try === 0
    ) {
      // Empty portfolio is rare; more often the UI language/layout changed or
      // the session is soft-logged-out without a hard redirect.
      if (/giriş yap|sign in|log in|login/i.test(bodyText)) {
        await notifyMidasAuthWall(dispatcher, landedUrl);
        throw new Error(
          "Failed to parse Midas dashboard — page looks unauthenticated. Sign in at atlas.getmidas.com and re-run."
        );
      }
      throw new Error(
        'Failed to parse Midas dashboard (no holdings or totals found). Confirm the Atlas UI still shows "ABD Hisseleri" / "BIST Hisseleri" sections, or capture body text for a parser update.'
      );
    }

    const occurredAt = new Date();
    const events: EventEnvelope[] = [
      ...snapshot.holdings.map((h) => holdingToEvent(h, occurredAt)),
      balanceToEvent(snapshot, occurredAt),
    ];

    const checkpoint: MidasCheckpoint = {
      last_run: occurredAt.toISOString(),
    };

    return {
      events,
      checkpoint: checkpoint as unknown as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        holdings: snapshot.holdings.length,
        total_usd: snapshot.total_usd,
        total_try: snapshot.total_try,
        backend: "extension-dom",
      },
    };
  }
}
