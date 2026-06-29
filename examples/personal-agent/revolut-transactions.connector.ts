/**
 * Revolut Connector
 *
 * Revolut has no public personal-banking API, so this connector reads the
 * RENDERED transaction list from the Revolut web app (`app.revolut.com`) via
 * the paired Owletto Chrome extension — not Revolut's internal
 * `/api/retail/...` JSON. The extension drives the user's real signed-in Chrome
 * session: navigate to the transactions view in a non-disruptive background
 * scrape window, scroll to lazy-load older rows, then extract each transaction
 * straight from the DOM.
 *
 * Why DOM, not network-intercept or CDP: Revolut's `app.revolut.com` access
 * token is bound to the browser that minted it (per-request `x-device-id`
 * header + Cloudflare/TLS fingerprint), so replaying its internal API in any
 * other context (a Playwright window over CDP, exported cookies) 401s and
 * bounces to `sso.revolut.com`. Reading what the real session already rendered
 * sidesteps that entirely, and is robust against Revolut rotating/obfuscating
 * those internal endpoints. No `--remote-debugging-port`, no separate Chrome
 * profile, no cookie cloning.
 *
 * Visibility: the transaction list is a virtualized DOM (rows recycle out as
 * you scroll) and only paints in a rendered tab — a hidden/background tab never
 * loads it. We navigate with `focus_mode:"window"` (a small, non-focused scrape
 * window that renders without switching the user's tab); if that returns
 * nothing (e.g. fully occluded) we retry once with `bring_to_front`. Because
 * the list virtualizes, we HARVEST rows after every scroll step and accumulate
 * them (deduped) rather than extracting once at the end.
 *
 * Auth is implicit: the user is already signed into app.revolut.com in the
 * paired Chrome. Revolut's session expires often (passcode / SSO re-auth), so
 * if the navigate lands on `sso.revolut.com` (host differs from requested) or a
 * login form with zero rows, we `focus_tab` to surface the tab to the user and
 * throw `RevolutAuthWallError` instead of silently scraping a logged-out page.
 *
 * The emitted event shape matches the original file-import Revolut connector
 * (`semantic_type: "transaction"`, metadata `{ date, description, amount,
 * direction, balance, currency }`) so historical imports stay uniform.
 */

import {
  type ChromeActionDispatcher,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type ExtensionScrapeConfig,
  extensionDomScrape,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RevolutCheckpoint {
  last_transaction_id?: string;
  last_timestamp?: string;
}

export interface RevolutTransaction {
  id: string;
  description: string;
  /** Absolute value in major currency units (e.g. 20.0 for £20.00). */
  amount: number;
  direction: "in" | "out";
  /** Account balance after the transaction, in major units (may be absent). */
  balance?: number;
  currency: string;
  /** ISO calendar date (YYYY-MM-DD) the transaction settled / started. */
  date: string;
  /** Full settlement timestamp. */
  occurredAt: Date;
  /** Revolut transaction type, e.g. CARD_PAYMENT, TRANSFER, TOPUP. */
  type?: string;
  /** Revolut state, e.g. COMPLETED, PENDING. */
  state?: string;
}

/** A single transaction row scraped from the DOM (before parsing). */
export interface RevolutDomRow {
  /** Day-group heading, e.g. "26 May" or "3 Jan" (no year in the web app). */
  day?: string;
  /** Merchant / description, e.g. "O2", "Bought GBP with USD". */
  desc?: string;
  /** Amount strings as rendered, primary first: e.g. ["-£34.13", "-$46.15"]. */
  amounts?: string[];
  /** Time line, e.g. "07:18" or "07:18 · D4468637". */
  timeRef?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Symbol → ISO 4217. Revolut renders amounts with a leading symbol; we map the
// common ones and fall back to any 3-letter code present in the string.
const SYMBOL_TO_CURRENCY: Record<string, string> = {
  "£": "GBP",
  $: "USD",
  "€": "EUR",
  "¥": "JPY",
  "₹": "INR",
  "₽": "RUB",
  "₺": "TRY",
  "₩": "KRW",
  "₪": "ILS",
  "₴": "UAH",
  "₫": "VND",
  "₱": "PHP",
  "฿": "THB",
  "₦": "NGN",
  R$: "BRL",
  zł: "PLN",
  Fr: "CHF",
};

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parse a rendered amount string like "-£34.13", "+£34.13", "-$1,234.56",
 * "1.234,56 zł" into { amount (signed, major units), currency }.
 *
 * Returns the SIGNED value so callers can derive direction. Handles both
 * thousands/decimal conventions: a comma is a decimal separator only when 1-2
 * digits trail it (e.g. "1,80" vs "1,234").
 */
export function parseAmountString(
  raw: string
): { amount: number; currency: string } | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  // Currency: prefer an explicit 3-letter ISO code, else a known symbol.
  let currency: string | null = null;
  const isoMatch = s.match(/\b([A-Z]{3})\b/);
  if (isoMatch) currency = isoMatch[1];
  if (!currency) {
    // Longest symbols first so "R$" beats "$".
    for (const sym of Object.keys(SYMBOL_TO_CURRENCY).sort(
      (a, b) => b.length - a.length
    )) {
      if (s.includes(sym)) {
        currency = SYMBOL_TO_CURRENCY[sym];
        break;
      }
    }
  }
  if (!currency) return null;

  // Sign: an explicit minus, or a parenthesised negative. Default positive.
  const negative = /-/.test(s) || /^\(.*\)$/.test(s.replace(/\s/g, ""));

  // Strip everything but digits and separators, then normalise to a JS number.
  const numPart = s.replace(/[^\d.,]/g, "");
  if (!numPart) return null;
  let normalised: string;
  const lastComma = numPart.lastIndexOf(",");
  const lastDot = numPart.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the later one is the decimal separator.
    normalised =
      lastComma > lastDot
        ? numPart.replace(/\./g, "").replace(",", ".")
        : numPart.replace(/,/g, "");
  } else if (lastComma !== -1) {
    // Only comma: decimal if 1-2 trailing digits, else thousands.
    const decimals = numPart.length - lastComma - 1;
    normalised =
      decimals === 1 || decimals === 2
        ? numPart.replace(",", ".")
        : numPart.replace(/,/g, "");
  } else {
    normalised = numPart;
  }

  const value = Number.parseFloat(normalised);
  if (!Number.isFinite(value)) return null;
  return {
    amount: negative ? -Math.abs(value) : Math.abs(value),
    currency: currency.toUpperCase(),
  };
}

/**
 * Resolve a bare "26 May" / "3 Jan" day heading to a full Date. The web app
 * omits the year on day headings, so we assume the day belongs to the current
 * year; if that lands in the future relative to `now`, it's the prior year
 * (handles the Dec→Jan boundary). An explicit 4-digit year in the heading wins.
 * The time, if present, is applied; otherwise noon UTC (a stable anchor).
 */
export function parseRevolutDate(
  day: string,
  timeRef: string,
  now: number = Date.now()
): Date | null {
  const dm = (day ?? "").match(/(\d{1,2})\s*([A-Za-z]{3,4})\.?\s*(\d{4})?/);
  if (!dm) return null;
  const dayNum = Number.parseInt(dm[1], 10);
  const month = MONTHS[dm[2].toLowerCase()];
  if (month === undefined || !Number.isFinite(dayNum)) return null;

  const explicitYear = dm[3] ? Number.parseInt(dm[3], 10) : null;
  const tm = (timeRef ?? "").match(/(\d{1,2}):(\d{2})/);
  const hours = tm ? Number.parseInt(tm[1], 10) : 12;
  const minutes = tm ? Number.parseInt(tm[2], 10) : 0;

  let year = explicitYear ?? new Date(now).getUTCFullYear();
  let d = new Date(Date.UTC(year, month, dayNum, hours, minutes, 0));
  if (!explicitYear && d.getTime() > now + 86_400_000) {
    // A future date with no explicit year → it belongs to the prior year.
    year -= 1;
    d = new Date(Date.UTC(year, month, dayNum, hours, minutes, 0));
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Deterministic id for a row that carries no DOM id: hash its stable fields.
 * `timeRef` (the row's "HH:MM[ · ref]" line) is part of the basis so two
 * same-day transactions with the same merchant and amount but different times
 * get distinct ids instead of colliding and being deduped away. */
function synthesizeId(
  date: string,
  desc: string,
  signedAmount: string,
  timeRef: string
): string {
  const basis = `${date}|${desc}|${signedAmount}|${timeRef}`;
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Map scraped DOM rows to RevolutTransactions (drops unparseable rows). */
export function buildTransactionsFromDom(
  rows: RevolutDomRow[],
  now: number = Date.now()
): RevolutTransaction[] {
  const out: RevolutTransaction[] = [];
  for (const r of rows) {
    const desc = (r?.desc ?? "").trim();
    const amounts = Array.isArray(r?.amounts) ? r.amounts : [];
    if (!desc || amounts.length === 0) continue;

    const money = parseAmountString(amounts[0]);
    if (!money) continue;

    const occurredAt = parseRevolutDate(r?.day ?? "", r?.timeRef ?? "", now);
    if (!occurredAt) continue;

    const signedStr =
      money.amount < 0 ? `-${Math.abs(money.amount)}` : `${money.amount}`;
    const date = occurredAt.toISOString().slice(0, 10);
    out.push({
      id: synthesizeId(date, desc, signedStr, (r?.timeRef ?? "").trim()),
      description: desc,
      amount: Math.abs(money.amount),
      direction: money.amount < 0 ? "out" : "in",
      currency: money.currency,
      date,
      occurredAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checkpoint filtering
// ---------------------------------------------------------------------------

export function filterTransactionsSinceCheckpoint(
  transactions: RevolutTransaction[],
  checkpoint: RevolutCheckpoint | null | undefined
): RevolutTransaction[] {
  const lastTs = checkpoint?.last_timestamp
    ? new Date(checkpoint.last_timestamp).getTime()
    : null;
  const lastId = checkpoint?.last_transaction_id;
  const seen = new Set<string>();
  return transactions.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    if (lastId && t.id === lastId) return false;
    // Strictly-older only (`<`, not `<=`). Revolut timestamps are minute
    // precision, so dropping the whole boundary minute would silently lose
    // other transactions that settled in the same minute as the checkpoint.
    // Re-including the boundary minute is safe: the exact checkpoint row is
    // dropped by the `lastId` guard above, and any re-seen row carries a stable
    // origin id the gateway supersedes — so no duplicates are stored.
    if (
      lastTs !== null &&
      Number.isFinite(lastTs) &&
      t.occurredAt.getTime() < lastTs
    ) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Event mapping (matches the original file-import Revolut connector)
// ---------------------------------------------------------------------------

function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case "GBP":
      return "£";
    case "USD":
      return "$";
    case "EUR":
      return "€";
    default:
      return `${currency} `;
  }
}

export function transactionToEvent(t: RevolutTransaction): EventEnvelope {
  const sign = t.direction === "out" ? "-" : "+";
  return {
    origin_id: `revolut-${t.id}`,
    payload_text: `${t.description} ${sign}${currencySymbol(t.currency)}${t.amount} on ${t.date}`,
    occurred_at: t.occurredAt,
    semantic_type: "transaction",
    metadata: {
      date: t.date,
      description: t.description,
      amount: t.amount,
      direction: t.direction,
      ...(t.balance !== undefined ? { balance: t.balance } : {}),
      currency: t.currency,
      ...(t.type ? { transaction_type: t.type } : {}),
      ...(t.state ? { state: t.state } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Extension dispatch + auth-wall handling
// ---------------------------------------------------------------------------

/**
 * Pull the chrome action dispatcher from sessionState. The connector-worker
 * subprocess (child-runner.ts) splices a live `chrome_dispatcher` object onto
 * every sync's sessionState; the dispatcher's `dispatch()` rides an IPC channel
 * up to the daemon and out to the gateway's chrome-action bridge and the paired
 * Owletto extension. When no paired Owletto extension is online in the
 * connection's org, the bridge returns the `failed` status and the dispatcher
 * throws — we surface that as the sync failure verbatim.
 */
function requireExtensionDispatcher(ctx: SyncContext): ChromeActionDispatcher {
  const handle = (
    ctx.sessionState as Record<string, unknown> | null | undefined
  )?.chrome_dispatcher as ChromeActionDispatcher | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "Revolut connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge."
    );
  }
  return handle;
}

/** Raised when the scrape lands on Revolut's passcode / SSO sign-in wall. */
export class RevolutAuthWallError extends Error {
  constructor(landedUrl: string) {
    super(
      `Revolut session needs sign-in (redirected to ${landedUrl}). The scrape tab was focused so you can re-enter your passcode; the next sync will use the authenticated session.`
    );
    this.name = "RevolutAuthWallError";
  }
}

async function notifyRevolutAuthWall(
  dispatcher: ChromeActionDispatcher,
  landedUrl: string,
  tabId?: number
): Promise<void> {
  try {
    await dispatcher.dispatch("show_notification", {
      notification_id: "revolut-auth-wall",
      title: "Revolut needs sign-in",
      message:
        "Enter your Revolut passcode in the focused Chrome window, then rerun the sync.",
      body: "Enter your Revolut passcode in the focused Chrome window, then rerun the sync.",
      landed_url: landedUrl,
      click_url: landedUrl,
      ...(typeof tabId === "number" ? { tab_id: tabId } : {}),
    });
  } catch {
    // Best-effort only: lack of notification permission or an unavailable
    // extension notification API must not hide the real auth-wall failure.
  }
}

// ---------------------------------------------------------------------------
// DOM scrape (declarative cs_scrape via the extension's content script)
// ---------------------------------------------------------------------------

const REVOLUT_ALLOWED_ORIGINS = ["revolut.com", "*.revolut.com"];

// A transaction line carries either a currency symbol or a 3-letter ISO code,
// plus a digit. A time line starts "HH:MM".
const AMOUNT_LINE_RE = /[£$€¥₹₽₺₩₪₴₫₱฿₦]|\b[A-Z]{3}\b/;
const TIME_LINE_RE = /^\d{1,2}:\d{2}/;

// Declarative config for the extension's content-script scraper. The list is a
// set of `[role="transactions-group"]` day sections (the group's first text
// line is the day heading), each holding one `button` per transaction. We grab
// every row's full innerText plus the clean merchant name ([class*=ItemTitle])
// and parse amounts/time/desc out of the text in TS (rawRowToDomRow). The
// content script handles scroll pagination + the virtualized-list dedup, so no
// in-page accumulator is needed. `loggedOutWhen` flags the app->sso redirect.
const REVOLUT_SCRAPE_CONFIG: ExtensionScrapeConfig = {
  scroll: { max: 20, stall: 3, waitMs: 1500 },
  loggedOutWhen: {
    hostRegex: "sso\\.revolut\\.com",
    pathRegex: "(signin|passcode|login)",
  },
  group: {
    selector: '[role="transactions-group"]',
    rowSelector: "button",
    labelFromFirstLine: true,
  },
  requireFields: ["text"],
  fields: {
    text: { take: "text" },
    title: { selector: '[class*="ItemTitle"]', take: "text", firstLine: true },
  },
};

/** Convert one raw cs_scrape row ({ group, text, title }) into a RevolutDomRow,
 * splitting the row's innerText into amount lines and a time line (the same
 * shape buildTransactionsFromDom expects). */
function rawRowToDomRow(raw: Record<string, unknown>): RevolutDomRow {
  const text = typeof raw.text === "string" ? raw.text : "";
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const amounts = lines.filter((l) => AMOUNT_LINE_RE.test(l) && /\d/.test(l));
  const timeRef = lines.find((l) => TIME_LINE_RE.test(l)) ?? "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const desc = title || lines[0] || "";
  const day = typeof raw.group === "string" ? raw.group : "";
  return { day, desc, amounts, timeRef };
}

/**
 * Render the Revolut transactions page in the paired Chrome and harvest rows
 * via one declarative `cs_scrape` (content script — no debugger, so the page
 * renders normally). The content script scrolls `maxScrolls` times and returns
 * deduped rows. On an auth wall (`loggedOutWhen` matched the app->sso redirect),
 * `extensionDomScrape` reports `loggedIn:false` and we raise — never scrape a
 * logged-out page.
 */
async function scrapeTransactionRows(
  dispatcher: ChromeActionDispatcher,
  url: string,
  maxScrolls: number
): Promise<RevolutDomRow[]> {
  // Scrape in a FRESH, dedicated window each run — never reuse a long-lived one.
  //
  // The extension's `genericScrape` harvests from the tab's CURRENT scroll
  // position and only scrolls further DOWN, and Revolut's list virtualizes
  // off-screen rows. A reused window left scrolled deep into history by the
  // previous run therefore harvests only OLD rows and walks the sync backwards
  // in time. A fresh window (persistent:false) always loads `/transactions` at
  // the top (newest), can't be corrupted by a concurrent run sharing the same
  // window, and stays signed in via the Chrome profile's Revolut session
  // cookies. The extension's tab-reaper disposes the window shortly after the
  // run, so nothing accumulates.
  const result = await extensionDomScrape<RevolutDomRow>({
    dispatcher,
    url,
    config: {
      ...REVOLUT_SCRAPE_CONFIG,
      scroll: { ...REVOLUT_SCRAPE_CONFIG.scroll, max: maxScrolls },
    },
    parseRows: (raw) => raw.map(rawRowToDomRow),
    allowedOrigins: REVOLUT_ALLOWED_ORIGINS,
    persistent: false,
  });
  if (!result.loggedIn) {
    const landedUrl = result.landedUrl ?? url;
    await notifyRevolutAuthWall(dispatcher, landedUrl, result.tabId);
    throw new RevolutAuthWallError(landedUrl);
  }
  return result.items;
}

// ---------------------------------------------------------------------------
// Config + connector definition
// ---------------------------------------------------------------------------

// `/transactions` shows the full, scrollable history for the default account;
// `/home` only shows the latest ~10. Per-pocket history lives at
// `/transactions?accountType=pocket&walletId=<uuid>&pocketId=<uuid>` — point a
// second feed's `start_url` there to sync a non-default currency pocket.
const DEFAULT_START_URL = "https://app.revolut.com/transactions";

const configSchema = {
  type: "object",
  properties: {
    start_url: {
      type: "string",
      default: DEFAULT_START_URL,
      description:
        "Revolut web app URL to open. Defaults to the full transactions view for the primary account; set it to a per-pocket /transactions?...pocketId=<uuid> URL to sync a different currency pocket.",
    },
    currency_filter: {
      type: "string",
      description:
        'If set, keep only transactions in this ISO 4217 currency (e.g. "GBP").',
    },
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 20,
      description:
        "Maximum scroll iterations to lazy-load older transactions (default: 20).",
    },
  },
};

const transactionMetadataSchema = {
  type: "object",
  properties: {
    date: { type: "string", format: "date" },
    description: { type: "string" },
    amount: { type: "number" },
    direction: { type: "string", enum: ["in", "out"] },
    balance: { type: "number" },
    currency: { type: "string" },
    transaction_type: { type: "string" },
    state: { type: "string" },
  },
};

export default class RevolutTransactionsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "revolut",
    name: "Revolut",
    description:
      "Syncs Revolut account transactions by reading the rendered Revolut web app (no public API) through your paired Owletto Chrome session — no separate login, robust against Revolut's rotating internal API.",
    version: "3.4.0",
    faviconDomain: "app.revolut.com",
    authSchema: {
      // Auth is implicit via the paired Owletto extension's signed-in Chrome —
      // no CDP, no cookie capture. Each run scrapes in a fresh, dedicated window
      // (shared profile cookies keep it signed in); when Revolut's session
      // expires the page redirects to sso.revolut.com, `loggedOutWhen` flags it,
      // and the sync fails with a "needs sign-in" message so the user can
      // re-authenticate Revolut in Chrome before the next run.
      methods: [{ type: "none" }],
    },
    feeds: {
      transactions: {
        key: "transactions",
        name: "Transactions",
        description: "Account transactions read from the Revolut web app DOM.",
        configSchema,
        eventKinds: {
          transaction: {
            description: "A bank transaction",
            metadataSchema: transactionMetadataSchema,
          },
        },
      },
    },
    optionsSchema: configSchema,
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = (ctx.config ?? {}) as Record<string, unknown>;
    const checkpoint = (ctx.checkpoint ?? {}) as RevolutCheckpoint;
    const dispatcher = requireExtensionDispatcher(ctx);

    const startUrl =
      typeof config.start_url === "string" && config.start_url.trim()
        ? config.start_url.trim()
        : DEFAULT_START_URL;
    const currencyFilter =
      typeof config.currency_filter === "string" &&
      config.currency_filter.trim()
        ? config.currency_filter.trim().toUpperCase()
        : null;
    const maxScrolls = Math.max(
      1,
      Math.min(100, Number(config.max_scrolls ?? 20) || 20)
    );

    const rows = await scrapeTransactionRows(dispatcher, startUrl, maxScrolls);
    const all = buildTransactionsFromDom(rows);

    // Fail closed. We only reach here logged in (scrapeTransactionRows throws on
    // an auth wall), so ZERO parsed transactions almost certainly means a DOM /
    // selector regression or an unrendered list — not a genuinely empty
    // account. Surfacing it as a failure (instead of a silent empty sync) keeps
    // it alertable and leaves the checkpoint untouched.
    if (all.length === 0) {
      throw new Error(
        "Revolut scrape returned 0 transactions on a logged-in page — likely a DOM/selector change or an unrendered list; failing rather than reporting an empty sync."
      );
    }

    let transactions = filterTransactionsSinceCheckpoint(all, checkpoint);
    if (currencyFilter) {
      transactions = transactions.filter((t) => t.currency === currencyFilter);
    }
    transactions.sort(
      (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()
    );

    const events: EventEnvelope[] = transactions.map(transactionToEvent);

    // Monotonic high-water mark: advance to the newest transaction we actually
    // saw, but NEVER move the checkpoint backwards in time. Belt-and-suspenders
    // on top of the fresh-window scrape (which already loads newest-first): if a
    // partial/mis-rendered scrape ever surfaces only old rows, the checkpoint
    // holds instead of rewinding and re-ingesting years of history. `newestSeen`
    // is the max over the FULL scrape, not just the post-checkpoint slice.
    const newestSeen = all.reduce<RevolutTransaction | null>(
      (max, t) =>
        !max || t.occurredAt.getTime() > max.occurredAt.getTime() ? t : max,
      null
    );
    const prevTs = checkpoint?.last_timestamp
      ? new Date(checkpoint.last_timestamp).getTime()
      : Number.NEGATIVE_INFINITY;
    const newCheckpoint: RevolutCheckpoint =
      newestSeen &&
      Number.isFinite(newestSeen.occurredAt.getTime()) &&
      newestSeen.occurredAt.getTime() > prevTs
        ? {
            last_transaction_id: newestSeen.id,
            last_timestamp: newestSeen.occurredAt.toISOString(),
          }
        : checkpoint;

    return {
      events,
      checkpoint: newCheckpoint as unknown as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        items_scraped: rows.length,
        backend: "extension-dom",
        ...(currencyFilter ? { currency_filter: currencyFilter } : {}),
      },
    };
  }
}
