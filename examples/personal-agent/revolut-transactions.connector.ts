/**
 * Revolut Connector
 *
 * Revolut has no public personal-banking API, so this connector reads the
 * user's transactions by REPLAYING the retail API the Revolut web app
 * (`app.revolut.com`) already calls — not by scraping the rendered DOM. It runs
 * inside the user's real signed-in Chrome via the paired Owletto extension:
 * reuse the persistent window the user signs into once, capture the app's own
 * `transactions/last` request headers, then page the FULL history in-page by
 * walking the `?to=<cursor>` parameter and parsing each
 * `GET /api/retail/user/current/transactions/last` JSON page.
 *
 * Why replay, not scrape: the previous DOM-scrape path parsed amounts out of
 * rendered row text, which broke against Revolut's virtualized SPA and produced
 * corrupt amounts (a coffee read as £180,611). The retail API returns `amount`
 * as a signed integer in MINOR units (−£23.45 = `-2345`); dividing by
 * 10^exponent is exact and kills the decimal-parse corruption entirely.
 *
 * Why replay, not scroll: Revolut's list only fetches older `?to=` pages on a
 * real wheel scroll, which a non-rendered/automated tab can't reproduce (the CDP
 * wheel is frame-throttled and never acks). But the retail API is plain JSON
 * paginated by a `?to=<epoch_ms>` cursor — so once we have the app's request
 * headers we can fetch every older page directly, in-page, no scrolling. The one
 * non-reconstructible header (`x-device-id`, an in-memory app token — NOT the
 * localStorage tracker id) is captured by wrapping fetch/XHR and forcing one
 * real app request via a SPA route remount; the captured set replays cleanly on
 * new `?to=` URLs (the API is not per-request signed). A same-origin in-page
 * `fetch` carries cookies (`credentials:"include"`) plus those headers, so it
 * authenticates where a header-less raw fetch 401s (`{code:9001}`).
 *
 * Auth is implicit but two-layered: SSO login ≠ retail-API auth. The app-level
 * passcode (rwa flow) must be entered in app.revolut.com or the retail API 401s
 * (`{code:9001}`) and the page renders skeletons. When that happens — no
 * transactions intercepted — we `notifyRevolutAuthWall` and throw
 * `RevolutAuthWallError` instead of reporting a silently-empty sync.
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
  /** The retail API transaction id (a stable uuid). */
  id: string;
  description: string;
  /** Absolute value in major currency units (e.g. 20.0 for £20.00). */
  amount: number;
  direction: "in" | "out";
  /**
   * Account balance after the transaction, in major units. The retail
   * `transactions/last` array does NOT carry a balance field, so this is
   * effectively always absent today; kept optional for parity with the
   * original file-import shape and in case a pocket endpoint includes it.
   */
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
  // ── Rich fields the retail API carries (a statement export does not) ──
  /** Revolut's own spend category, e.g. "shopping", "groceries", "transport". */
  category?: string;
  /** Merchant category code (ISO 18245), e.g. "5734". */
  mcc?: string;
  /** ISO country where the transaction occurred, e.g. "US". */
  countryCode?: string;
  /** ISO country of the merchant, e.g. "US". */
  merchantCountry?: string;
  /** Transaction fee in major units (0 when none). */
  fee?: number;
  /** FX rate applied (1 when same-currency). */
  fxRate?: number;
  /** Original foreign amount (major units) before conversion, from `counterpart`. */
  counterpartAmount?: number;
  /** Currency of the original foreign amount, e.g. "THB". */
  counterpartCurrency?: string;
  /** Merchant city/locality, when present. */
  merchantCity?: string;
  /** Last 4 digits of the card used (card transactions only). */
  cardLastFour?: string;
  /** Card label/nickname, e.g. "Amazon" (card transactions only). */
  cardLabel?: string;
  /** Internal pocket/account id this transaction belongs to (`account.id`). */
  accountId?: string;
  /** True when Revolut classifies the payment as a subscription. */
  isSubscription?: boolean;
  /** Reason string for non-completed states, e.g. "merchant_blocked_manually". */
  reason?: string;
  /** Free-form Revolut tag, e.g. "shopping". */
  tag?: string;
  /** True for an online / internet (e-commerce) payment, false for in-person. */
  ecommerce?: boolean;
  /** True when the cardholder was physically present (card-present terminal). */
  cardholderPresent?: boolean;
  /** Groups the legs of one logical transaction (e.g. both sides of a transfer). */
  groupKey?: string;
  /** True when the card used is a credit card (vs debit). */
  isCreditCard?: boolean;
  /** Canonical merchant brand id — same across a brand's varying merchant ids. */
  merchantBrandId?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// ISO 4217 currencies whose minor-unit exponent is NOT 2. The retail API
// returns `amount`/`balance` as signed integers in minor units; we divide by
// 10^exponent. Default is 2 (GBP, USD, EUR, …); these are the exceptions.
const CURRENCY_EXPONENT: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  HUF: 0, // Revolut quotes HUF in whole forint
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JOD: 3,
};

/** Convert a signed minor-unit integer to major units for the given currency. */
export function minorToMajor(minor: number, currency: string): number {
  const exp = CURRENCY_EXPONENT[(currency ?? "").toUpperCase()] ?? 2;
  return minor / 10 ** exp;
}

/** One raw transaction object as it appears in the `transactions/last` JSON. */
interface RawRevolutTxn {
  id?: unknown;
  type?: unknown;
  state?: unknown;
  startedDate?: unknown;
  completedDate?: unknown;
  currency?: unknown;
  amount?: unknown;
  balance?: unknown;
  description?: unknown;
  category?: unknown;
  countryCode?: unknown;
  fee?: unknown;
  rate?: unknown;
  reason?: unknown;
  tag?: unknown;
  paymentInitiationType?: unknown;
  eCommerce?: unknown;
  cardholderPresent?: unknown;
  groupKey?: unknown;
  merchant?: {
    name?: unknown;
    mcc?: unknown;
    category?: unknown;
    country?: unknown;
    city?: unknown;
    brandId?: unknown;
  } | null;
  counterpart?: { amount?: unknown; currency?: unknown } | null;
  card?: { lastFour?: unknown; label?: unknown; credit?: unknown } | null;
  account?: { id?: unknown; type?: unknown } | null;
}

/** Read a string field, returning undefined for anything else. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Parse a `GET /api/retail/user/current/transactions/last` response body into
 * RevolutTransactions. The response is a JSON ARRAY of transaction objects.
 *
 * Amounts are signed minor-unit integers → `minorToMajor`. A negative `amount`
 * is money out. `startedDate` is epoch-ms. We keep every state (COMPLETED /
 * PENDING / DECLINED / REVERTED) and stamp `state` in metadata rather than
 * dropping rows, so spend filtering stays a downstream (metric-layer) decision
 * and nothing is silently lost.
 *
 * Returns `[]` for a non-array body — notably the retail auth-wall error body
 * `{code:9001,"message":"Phone and/or passcode are incorrect"}` — so the sync's
 * zero-items branch can raise the auth wall.
 */
export function parseTransactionsResponse(json: unknown): RevolutTransaction[] {
  if (!Array.isArray(json)) return [];
  const out: RevolutTransaction[] = [];
  for (const raw of json as RawRevolutTxn[]) {
    if (!raw || typeof raw !== "object") continue;

    const id = typeof raw.id === "string" ? raw.id : null;
    const amountMinor =
      typeof raw.amount === "number" && Number.isFinite(raw.amount)
        ? raw.amount
        : null;
    const currency =
      typeof raw.currency === "string" ? raw.currency.toUpperCase() : null;
    const startedMs =
      typeof raw.startedDate === "number" && Number.isFinite(raw.startedDate)
        ? raw.startedDate
        : typeof raw.completedDate === "number" &&
            Number.isFinite(raw.completedDate)
          ? raw.completedDate
          : null;
    if (!id || amountMinor === null || !currency || startedMs === null) {
      continue;
    }

    const occurredAt = new Date(startedMs);
    if (Number.isNaN(occurredAt.getTime())) continue;

    const major = minorToMajor(amountMinor, currency);
    const merchantName =
      raw.merchant && typeof raw.merchant.name === "string"
        ? raw.merchant.name.trim()
        : "";
    const description =
      merchantName ||
      (typeof raw.description === "string" ? raw.description.trim() : "") ||
      raw.type?.toString?.() ||
      "Transaction";

    out.push({
      id,
      description,
      amount: Math.abs(major),
      direction: major < 0 ? "out" : "in",
      ...(typeof raw.balance === "number" && Number.isFinite(raw.balance)
        ? { balance: minorToMajor(raw.balance, currency) }
        : {}),
      currency,
      date: occurredAt.toISOString().slice(0, 10),
      occurredAt,
      ...(typeof raw.type === "string" ? { type: raw.type } : {}),
      ...(typeof raw.state === "string" ? { state: raw.state } : {}),
      // Rich fields (statement exports lack these).
      ...(str(raw.category) ? { category: str(raw.category) } : {}),
      ...(str(raw.merchant?.mcc) ? { mcc: str(raw.merchant?.mcc) } : {}),
      ...(str(raw.countryCode) ? { countryCode: str(raw.countryCode) } : {}),
      ...(str(raw.merchant?.country)
        ? { merchantCountry: str(raw.merchant?.country) }
        : {}),
      ...(typeof raw.fee === "number" && Number.isFinite(raw.fee)
        ? { fee: minorToMajor(raw.fee, currency) }
        : {}),
      ...(typeof raw.rate === "number" && Number.isFinite(raw.rate)
        ? { fxRate: raw.rate }
        : {}),
      // counterpart = original foreign leg (amount in ITS own currency's minor units).
      ...(raw.counterpart &&
      typeof raw.counterpart.amount === "number" &&
      Number.isFinite(raw.counterpart.amount) &&
      str(raw.counterpart.currency)
        ? {
            counterpartAmount: Math.abs(
              minorToMajor(
                raw.counterpart.amount,
                str(raw.counterpart.currency) as string
              )
            ),
            counterpartCurrency: (
              str(raw.counterpart.currency) as string
            ).toUpperCase(),
          }
        : {}),
      ...(str(raw.merchant?.city)
        ? { merchantCity: str(raw.merchant?.city) }
        : {}),
      ...(str(raw.card?.lastFour)
        ? { cardLastFour: str(raw.card?.lastFour) }
        : {}),
      ...(str(raw.card?.label) ? { cardLabel: str(raw.card?.label) } : {}),
      ...(str(raw.account?.id) ? { accountId: str(raw.account?.id) } : {}),
      ...(raw.paymentInitiationType === "SUBSCRIPTION"
        ? { isSubscription: true }
        : {}),
      ...(str(raw.reason) ? { reason: str(raw.reason) } : {}),
      ...(str(raw.tag) ? { tag: str(raw.tag) } : {}),
      ...(typeof raw.eCommerce === "boolean"
        ? { ecommerce: raw.eCommerce }
        : {}),
      ...(typeof raw.cardholderPresent === "boolean"
        ? { cardholderPresent: raw.cardholderPresent }
        : {}),
      ...(str(raw.groupKey) ? { groupKey: str(raw.groupKey) } : {}),
      ...(typeof raw.card?.credit === "boolean"
        ? { isCreditCard: raw.card.credit }
        : {}),
      ...(str(raw.merchant?.brandId)
        ? { merchantBrandId: str(raw.merchant?.brandId) }
        : {}),
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
      ...(t.category ? { category: t.category } : {}),
      ...(t.mcc ? { mcc: t.mcc } : {}),
      ...(t.countryCode ? { country_code: t.countryCode } : {}),
      ...(t.merchantCountry ? { merchant_country: t.merchantCountry } : {}),
      ...(t.fee !== undefined ? { fee: t.fee } : {}),
      ...(t.fxRate !== undefined ? { fx_rate: t.fxRate } : {}),
      ...(t.counterpartAmount !== undefined
        ? { counterpart_amount: t.counterpartAmount }
        : {}),
      ...(t.counterpartCurrency
        ? { counterpart_currency: t.counterpartCurrency }
        : {}),
      ...(t.merchantCity ? { merchant_city: t.merchantCity } : {}),
      ...(t.cardLastFour ? { card_last_four: t.cardLastFour } : {}),
      ...(t.cardLabel ? { card_label: t.cardLabel } : {}),
      ...(t.accountId ? { account_id: t.accountId } : {}),
      ...(t.isSubscription ? { is_subscription: true } : {}),
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.tag ? { tag: t.tag } : {}),
      ...(t.ecommerce !== undefined ? { ecommerce: t.ecommerce } : {}),
      ...(t.cardholderPresent !== undefined
        ? { cardholder_present: t.cardholderPresent }
        : {}),
      ...(t.groupKey ? { group_key: t.groupKey } : {}),
      ...(t.isCreditCard !== undefined
        ? { is_credit_card: t.isCreditCard }
        : {}),
      ...(t.merchantBrandId ? { merchant_brand_id: t.merchantBrandId } : {}),
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

/** Raised when the retail API is unauthenticated (passcode / SSO sign-in wall). */
export class RevolutAuthWallError extends Error {
  constructor(landedUrl: string) {
    super(
      `Revolut session needs sign-in (no transactions returned from ${landedUrl}). Enter your Revolut passcode in the focused Chrome window; the next sync will use the authenticated session.`
    );
    this.name = "RevolutAuthWallError";
  }
}

async function notifyRevolutAuthWall(
  dispatcher: ChromeActionDispatcher,
  landedUrl: string
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
    });
  } catch {
    // Best-effort only: lack of notification permission or an unavailable
    // extension notification API must not hide the real auth-wall failure.
  }
}

// ---------------------------------------------------------------------------
// Config + connector definition
// ---------------------------------------------------------------------------

// `/transactions` shows the full, scrollable history for the default account;
// `/home` only shows the latest ~10. Per-pocket history lives at
// `/transactions?accountType=pocket&walletId=<uuid>&pocketId=<uuid>` — point a
// second feed's `start_url` there to sync a non-default currency pocket.
const DEFAULT_START_URL = "https://app.revolut.com/transactions";

const REVOLUT_ALLOWED_ORIGINS = ["revolut.com", "*.revolut.com"];

// Generic "retry the crawl while it returns no data" mechanism. The blocking
// reason is connector-specific (for Revolut it's the passcode/sign-in wall);
// the wait/retry itself is not. This wants lifting into the SDK
// (`extensionNetworkSync` gaining a `retryWhileEmptyMs`/`onEmptyRetry` option)
// so any connector can reuse it — kept connector-local for now because the
// runtime-provided SDK would need a release before a new option takes effect.
const EMPTY_RETRY_POLL_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-page expressions shipped to the `evaluate` op. They are self-contained
// (the op only carries a string) and use plain string matching — NO regex
// literals — to avoid template-literal escaping pitfalls.

// 1. Auth-check + capture the app's real `transactions/last` request headers.
// A fresh tab can't inherit Revolut's rwa auth, so headers are only obtainable
// in the signed-in persistent window. The on-load request fires before our
// wrappers install, so after wrapping fetch + XHR we force ONE fresh app
// request by remounting the SPA route (away + back). The captured header set
// (notably the in-memory `x-device-id` app token) + a paging cursor are stored
// in page globals consumed by PAGE_BATCH_EXPR.
const SETUP_EXPR = `(async () => {
  const isTx = (u) => typeof u === "string" && u.indexOf("transactions/last") >= 0;
  if (location.host.indexOf("sso.") >= 0 || location.pathname.indexOf("signin") >= 0) {
    return { authed: false };
  }
  if (!window.__lobuCap) {
    window.__lobuHdrs = [];
    const of = window.fetch;
    window.fetch = function (i, n) {
      try {
        const u = typeof i === "string" ? i : (i && i.url) || "";
        if (isTx(u)) {
          const h = {}; const hs = (n && n.headers) || (i && i.headers);
          if (hs) { try { new Headers(hs).forEach((v, k) => { h[k] = v; }); } catch (e) {} }
          window.__lobuHdrs.push(h);
        }
      } catch (e) {}
      return of.apply(this, arguments);
    };
    const oOpen = XMLHttpRequest.prototype.open;
    const oSet = XMLHttpRequest.prototype.setRequestHeader;
    const oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__lu = u; this.__lh = {}; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__lh[k] = v; } catch (e) {} return oSet.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () { try { if (isTx(this.__lu)) window.__lobuHdrs.push(this.__lh); } catch (e) {} return oSend.apply(this, arguments); };
    window.__lobuCap = 1;
  }
  try {
    history.pushState({}, "", "/home"); window.dispatchEvent(new PopStateEvent("popstate"));
    await new Promise((r) => setTimeout(r, 1200));
    history.pushState({}, "", "/transactions"); window.dispatchEvent(new PopStateEvent("popstate"));
    await new Promise((r) => setTimeout(r, 2500));
  } catch (e) {}
  const caps = (window.__lobuHdrs || []).filter((h) => h && h["x-device-id"]);
  if (!caps.length) return { authed: true, captured: false };
  window.__lobuHeaders = caps[caps.length - 1];
  window.__lobuSeen = {}; window.__lobuCursor = null;
  window.__lobuDone = false; window.__lobuStop = null;
  return { authed: true, captured: true };
})()`;

// 2. Page older history in-page using the captured headers and RETURN the raw
// rows fetched this call (no separate read-out phase — keeps the run well under
// the device-worker's ~95s budget). Each call walks up to PAGES_PER_BATCH
// `?to=<cursor>` pages, dedups against `__lobuSeen`, advances `__lobuCursor` to
// the oldest `startedDate`, and returns the new rows. `__lobuDone` flips when a
// page returns nothing new/older (start of history reached) or on an error.
// PAGES_PER_BATCH is small so each return stays modest (~125 rows/page).
// `internalPocketId` scopes paging to one account/pocket (omit for the primary
// account). A short inter-fetch delay + a single 5xx retry avoid Revolut's
// rate-limit 500s under back-to-back paging.
const pageBatchExpr = (internalPocketId: string): string => {
  const pocket = JSON.stringify(internalPocketId || "");
  return `(async () => {
  if (!window.__lobuHeaders) return { done: true, rows: [], stop: "no_headers" };
  if (window.__lobuDone) return { done: true, rows: [], stop: window.__lobuStop };
  const h = window.__lobuHeaders;
  const pocket = ${pocket};
  const base = "/api/retail/user/current/transactions/last";
  const rows = [];
  // Retry transient 5xx / network errors with exponential backoff so a brief
  // rate-limit burst doesn't abort the whole crawl mid-history (which would
  // silently stop a backfill partway and report "success"). Non-5xx errors
  // (401/404) fail fast.
  const fetchPage = async (url) => {
    let lastErr = "retry_exhausted";
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise(x => setTimeout(x, 400 * attempt * attempt));
      let r;
      try { r = await fetch(url, { credentials: "include", headers: h }); }
      catch (e) { lastErr = "neterr"; continue; }
      if (r.status >= 500) { lastErr = "http_" + r.status; continue; }
      if (!r.ok) return { err: "http_" + r.status };
      try { return { page: await r.json() }; } catch (e) { return { err: "parseerr" }; }
    }
    return { err: lastErr };
  };
  for (let k = 0; k < 4; k++) {
    const url = base + "?count=200"
      + (pocket ? ("&internalPocketId=" + pocket) : "")
      + (window.__lobuCursor ? ("&to=" + window.__lobuCursor) : "");
    const res = await fetchPage(url);
    if (res.err) { window.__lobuDone = true; window.__lobuStop = res.err; break; }
    const page = res.page;
    if (!Array.isArray(page) || page.length === 0) { window.__lobuDone = true; window.__lobuStop = "empty"; break; }
    let oldest = Infinity; let added = 0;
    for (const t of page) {
      const id = t && t.id; const sd = Number(t && t.startedDate);
      if (Number.isFinite(sd) && sd < oldest) oldest = sd;
      if (typeof id === "string" && !window.__lobuSeen[id]) { window.__lobuSeen[id] = 1; rows.push(t); added++; }
    }
    const prevCursor = window.__lobuCursor == null ? Infinity : window.__lobuCursor;
    if (!Number.isFinite(oldest) || !(oldest < prevCursor)) { window.__lobuDone = true; window.__lobuStop = "no_progress"; break; }
    window.__lobuCursor = oldest;
    if (added === 0) { window.__lobuDone = true; window.__lobuStop = "no_new"; break; }
    await new Promise(x => setTimeout(x, 80));
  }
  return { done: window.__lobuDone, rows: rows, stop: window.__lobuStop };
})()`;
};

/**
 * Crawl the FULL retail transaction history by replaying the `transactions/last`
 * API in-page, walking its `?to=<epoch_ms>` cursor — no scrolling.
 *
 * Reuses the ONE persistent window the user signs into once: a fresh background
 * tab bounces to sso.revolut.com (rwa auth is bound to the signed-in tab), so
 * the persistent window is the only context where the retail API authenticates.
 * We capture the app's own request headers there (SETUP_EXPR), then page the
 * whole history in batches that RETURN their raw rows (PAGE_BATCH_EXPR), parsing
 * each batch with the same `parseTransactionsResponse` used for intercepted
 * bodies. Inlining the rows (vs a read-out phase) keeps total dispatch time
 * under the device-worker's ~95s ceiling.
 */
async function crawlFetchPaging(
  dispatcher: ChromeActionDispatcher,
  startUrl: string,
  maxBatches: number,
  internalPocketId: string
): Promise<{ items: RevolutTransaction[]; apiCallCount: number }> {
  const allowed = REVOLUT_ALLOWED_ORIGINS;
  const PAGE_BATCH_EXPR = pageBatchExpr(internalPocketId);
  // Open / reuse the single persistent window in the BACKGROUND (not focused) so
  // a routine authed sync never pops the window to the foreground. We only
  // surface it below if the run actually needs the user to sign in.
  const nav = await dispatcher.dispatch<{ tab_id: number }>("navigate", {
    url: startUrl,
    persistent: true,
    window_focused: false,
    wait_for_load: true,
    allowed_origins: allowed,
  });
  const tabId = nav.tab_id;

  // Capture headers / auth-check. On a miss (SSO wall / capture fail), FOCUS the
  // persistent window so the user can complete the passcode in place, then return
  // no items so the upstream wait-poll fires the sign-in notice and retries.
  const setup = await dispatcher.dispatch<{
    value?: { authed?: boolean; captured?: boolean };
  }>("evaluate", {
    tab_id: tabId,
    expression: SETUP_EXPR,
    allowed_origins: allowed,
  });
  const s = setup.value ?? {};
  if (!s.authed || !s.captured) {
    await dispatcher
      .dispatch("navigate", {
        url: startUrl,
        persistent: true,
        window_focused: true,
        wait_for_load: false,
        allowed_origins: allowed,
      })
      .catch(() => undefined);
    return { items: [], apiCallCount: 0 };
  }

  // Page the full history in-page, batch by batch, parsing each batch's returned
  // raw rows inline until done. The cross-batch `seen` set is belt-and-braces;
  // the in-page `__lobuSeen` already dedups across batches.
  const items: RevolutTransaction[] = [];
  const seen = new Set<string>();
  let apiCallCount = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const b = await dispatcher.dispatch<{
      value?: { done?: boolean; rows?: unknown };
    }>("evaluate", {
      tab_id: tabId,
      expression: PAGE_BATCH_EXPR,
      allowed_origins: allowed,
    });
    const v = b.value ?? {};
    if (Array.isArray(v.rows) && v.rows.length > 0) {
      apiCallCount += 1;
      for (const t of parseTransactionsResponse(v.rows)) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          items.push(t);
        }
      }
    }
    if (v.done) break;
  }
  return { items, apiCallCount };
}

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
    internal_pocket_id: {
      type: "string",
      description:
        "Scope this feed to one account/pocket by its `internalPocketId` (the `id` from the wallet, e.g. the USD or EUR current account). Omit to sync the primary account. Add one feed per pocket to cover every currency account; each keeps its own checkpoint.",
    },
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 20,
      description:
        "Maximum paging batches (each fetches up to 4 `?to=` cursor pages of ~125 rows). 20 covers normal incremental syncs; raise it (e.g. 200) for a deep first backfill spanning years of history. (Name kept for config compatibility; the connector no longer scrolls.)",
    },
    backfill: {
      type: "boolean",
      default: false,
      description:
        "One-time historical backfill: ignore the checkpoint and re-emit EVERY fetched transaction (the gateway dedups by id, so re-emitting is safe). Pair with a high max_scrolls to re-ingest years of history with correct amounts, then set back to false for normal incremental syncs.",
    },
    wait_for_data_seconds: {
      type: "integer",
      minimum: 0,
      maximum: 80,
      default: 30,
      description:
        "If the crawl returns no data, keep retrying every 10s for this many seconds before failing. For Revolut the empty result means the passcode/sign-in wall (the sign-in notification fires once), so a run triggered before sign-in still completes once you authenticate. Capped at 80s because the device worker has a hard ~95s per-run budget. 0 = fail fast.",
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
    category: { type: "string" },
    mcc: { type: "string" },
    country_code: { type: "string" },
    merchant_country: { type: "string" },
    fee: { type: "number" },
    fx_rate: { type: "number" },
    counterpart_amount: { type: "number" },
    counterpart_currency: { type: "string" },
    merchant_city: { type: "string" },
    card_last_four: { type: "string" },
    card_label: { type: "string" },
    account_id: { type: "string" },
    is_subscription: { type: "boolean" },
    reason: { type: "string" },
    tag: { type: "string" },
    ecommerce: { type: "boolean" },
    cardholder_present: { type: "boolean" },
    group_key: { type: "string" },
    is_credit_card: { type: "boolean" },
    merchant_brand_id: { type: "string" },
  },
};

export default class RevolutTransactionsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "revolut",
    name: "Revolut",
    description:
      "Syncs Revolut account transactions by intercepting the retail API JSON the Revolut web app fetches (no public API), through your paired Owletto Chrome session — no separate login, exact amounts (no DOM parsing).",
    version: "4.5.2",
    faviconDomain: "app.revolut.com",
    authSchema: {
      // Auth is implicit via the paired Owletto extension's signed-in Chrome —
      // no CDP attach from our side beyond the Network domain, no cookie
      // capture. When Revolut's session/passcode expires the retail API 401s
      // and returns no transactions; the sync fails with a "needs sign-in"
      // message so the user can re-authenticate in Chrome before the next run.
      methods: [{ type: "none" }],
    },
    feeds: {
      transactions: {
        key: "transactions",
        name: "Transactions",
        description:
          "Account transactions read from the Revolut web app's retail API.",
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
    // Scope paging to one account/pocket (its `internalPocketId` from the wallet).
    // Omit to sync the primary account. Use one feed per pocket to cover every
    // currency account / savings vault — each keeps its own simple checkpoint.
    const internalPocketId =
      typeof config.internal_pocket_id === "string" &&
      config.internal_pocket_id.trim()
        ? config.internal_pocket_id.trim()
        : "";
    // Each "batch" pages up to 8 `?to=` cursor pages (~125 rows each), so the
    // default 20 covers ~20k rows; a deep backfill raises it for full history.
    const maxBatches = Math.max(
      1,
      Math.min(200, Number(config.max_scrolls ?? 20) || 20)
    );
    // Backfill mode ignores the checkpoint and re-emits every fetched row (the
    // gateway dedups by origin_id), so historical transactions older than the
    // checkpoint are re-ingested with correct amounts.
    const backfill = config.backfill === true;

    // How long to wait for the user to enter their passcode before giving up.
    // The device worker has a HARD ~95s per-run budget, so the wait MUST stay
    // short — a long wait gets the whole run killed mid-paging. We fire the
    // sign-in notification and retry the crawl every `EMPTY_RETRY_POLL_MS`; for a
    // reliable backfill the user should sign in BEFORE triggering (then the first
    // attempt is authed and no wait is consumed). 0 disables the wait (fail fast).
    const dataWaitMs =
      Math.max(0, Math.min(80, Number(config.wait_for_data_seconds ?? 30))) *
      1000;

    // One crawl attempt: capture headers in the persistent signed-in window and
    // page the full history in-page via the `?to=` cursor (see crawlFetchPaging).
    const runCrawl = () =>
      crawlFetchPaging(dispatcher, startUrl, maxBatches, internalPocketId);

    let result = await runCrawl();

    // Auth-wait poll. Zero intercepted transactions means the passcode/SSO wall
    // (401 `{code:9001}`, an sso.revolut.com redirect, or skeleton rows that
    // never fire the fetch). Notify once, then re-run the crawl every
    // EMPTY_RETRY_POLL_MS until the user signs in or the wait window elapses, so a run
    // triggered before sign-in still completes once they authenticate.
    if (result.items.length === 0 && dataWaitMs > 0) {
      await notifyRevolutAuthWall(dispatcher, startUrl);
      const deadline = Date.now() + dataWaitMs;
      while (result.items.length === 0 && Date.now() < deadline) {
        await sleep(EMPTY_RETRY_POLL_MS);
        result = await runCrawl();
      }
    }

    // Fail closed: still nothing after the wait → leave the checkpoint untouched
    // and surface the typed auth-wall error (don't report a silent empty sync).
    if (result.items.length === 0) {
      await notifyRevolutAuthWall(dispatcher, startUrl);
      throw new RevolutAuthWallError(startUrl);
    }

    const all = result.items;
    // A null checkpoint makes the filter dedup-only (emit everything) — that IS
    // backfill mode; otherwise drop rows at/older than the checkpoint.
    let transactions = filterTransactionsSinceCheckpoint(
      all,
      backfill ? null : checkpoint
    );
    if (currencyFilter) {
      transactions = transactions.filter((t) => t.currency === currencyFilter);
    }
    transactions.sort(
      (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()
    );

    const events: EventEnvelope[] = transactions.map(transactionToEvent);

    // Monotonic high-water mark: advance to the newest transaction we actually
    // saw, but NEVER move the checkpoint backwards in time. `newestSeen` is the
    // max over the FULL intercept, not just the post-checkpoint slice.
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
        items_scraped: all.length,
        api_calls: result.apiCallCount,
        backend: "extension-network",
        mode: backfill ? "backfill" : "incremental",
        ...(currencyFilter ? { currency_filter: currencyFilter } : {}),
      },
    };
  }
}
