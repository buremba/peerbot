/**
 * Revolut Connector
 *
 * Revolut has no public personal-banking API, so this connector reads the
 * user's transactions by INTERCEPTING the retail API JSON the Revolut web app
 * (`app.revolut.com`) already fetches — not by scraping the rendered DOM. It
 * runs inside the user's real signed-in Chrome via the paired Owletto
 * extension: open the transactions view in a single persistent, rendered (but
 * non-focused) window, attach the CDP Network domain, real-wheel-scroll to make
 * the app paginate older pages, and parse the
 * `GET /api/retail/user/current/transactions/last` responses.
 *
 * Why intercept, not scrape: the previous DOM-scrape path parsed amounts out of
 * rendered row text, which broke against Revolut's virtualized SPA and produced
 * corrupt amounts (a coffee read as £180,611). The retail API returns `amount`
 * as a signed integer in MINOR units (−£23.45 = `-2345`); dividing by
 * 10^exponent is exact and kills the decimal-parse corruption entirely.
 *
 * Why intercept, not replay: the retail API authenticates via an app-added
 * header (NOT cookies) bound to the browser that minted it, so an in-page
 * `fetch()` or a replay from any other context 401s. Intercepting the app's OWN
 * request captures its real headers + response for free.
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
  merchant?: {
    name?: unknown;
    mcc?: unknown;
    category?: unknown;
    country?: unknown;
  } | null;
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

// The retail endpoint the SPA fetches as you scroll the transaction list. We
// intercept its response body rather than scraping the rendered rows.
const TRANSACTIONS_LAST_PATTERN = "api/retail/user/current/transactions/last";

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

/** Drain one batch of intercepted responses and parse them into transactions. */
async function drainTransactions(
  dispatcher: ChromeActionDispatcher,
  sessionId: string
): Promise<RevolutTransaction[]> {
  const d = await dispatcher.dispatch<{
    responses?: Array<{ body?: string; base64_encoded?: boolean }>;
  }>("network_intercept_drain", {
    session_id: sessionId,
    allowed_origins: REVOLUT_ALLOWED_ORIGINS,
  });
  const out: RevolutTransaction[] = [];
  for (const r of d.responses ?? []) {
    if (r.base64_encoded || typeof r.body !== "string") continue;
    let json: unknown;
    try {
      json = JSON.parse(r.body);
    } catch {
      continue;
    }
    out.push(...parseTransactionsResponse(json));
  }
  return out;
}

/**
 * Crawl the retail transactions API inside a SINGLE persistent, rendered (but
 * non-focused) Owletto window.
 *
 * The persistent window is the load-bearing detail. Revolut's virtualized list
 * only fetches older `?to=` pages on a REAL wheel scroll, and a CDP wheel only
 * takes effect in a RENDERED tab — a throwaway BACKGROUND tab (what the generic
 * `extensionNetworkSync` opens) is frame-throttled, so the wheel is silently
 * dropped (acked: 0) and the list never pages. A persistent window renders, so
 * the wheel scrolls and the app paginates. The window is reused across runs (the
 * user signs into it once) and is never closed here.
 */
async function crawlPersistentWindow(
  dispatcher: ChromeActionDispatcher,
  startUrl: string,
  maxScrolls: number
): Promise<{ items: RevolutTransaction[]; apiCallCount: number }> {
  const allowed = REVOLUT_ALLOWED_ORIGINS;
  // 1. Open / reuse the single persistent rendered window (non-focused).
  const blank = await dispatcher.dispatch<{ tab_id: number }>("navigate", {
    url: "about:blank",
    persistent: true,
    wait_for_load: true,
    allowed_origins: allowed,
  });
  const tabId = blank.tab_id;

  const items: RevolutTransaction[] = [];
  const seen = new Set<string>();
  let apiCallCount = 0;
  const absorb = (batch: RevolutTransaction[]) => {
    if (batch.length > 0) apiCallCount += 1;
    for (const t of batch) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        items.push(t);
      }
    }
  };

  let sessionId: string | null = null;
  try {
    // 2. Start the Network listener BEFORE navigating so the on-load fetch is
    // captured.
    const start = await dispatcher.dispatch<{ session_id: string }>(
      "network_intercept_start",
      {
        tab_id: tabId,
        patterns: [{ regex: TRANSACTIONS_LAST_PATTERN }],
        max_buffer_responses: 200,
        max_body_bytes: 4_194_304,
        allowed_origins: allowed,
      }
    );
    sessionId = start.session_id;

    // 3. Navigate the persistent window to the transactions list.
    await dispatcher.dispatch("navigate", {
      tab_id: tabId,
      url: startUrl,
      wait_for_load: true,
      allowed_origins: allowed,
    });

    // 4. Let the initial render fire its fetch, then drain page 1.
    await sleep(8000);
    absorb(await drainTransactions(dispatcher, sessionId));

    // 5. Scroll loop: a real CDP wheel makes the app fetch the next `?to=` page.
    let prev = items.length;
    for (let i = 0; i < maxScrolls; i++) {
      await dispatcher.dispatch("scroll", {
        tab_id: tabId,
        steps: 4,
        allowed_origins: allowed,
      });
      await sleep(2500);
      absorb(await drainTransactions(dispatcher, sessionId));
      if (items.length === prev) break;
      prev = items.length;
    }
  } finally {
    if (sessionId) {
      await dispatcher
        .dispatch("network_intercept_stop", { session_id: sessionId })
        .catch(() => undefined);
    }
    // The persistent window is reused across runs — do NOT close it.
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
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 20,
      description:
        "Maximum scroll iterations to make the app paginate older transactions. Each page is ~125 rows, so 20 covers normal incremental syncs; raise it (e.g. 200) for a deep first backfill spanning years of history.",
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
      maximum: 600,
      default: 180,
      description:
        "If the crawl returns no data, keep retrying every 10s for this many seconds before failing. For Revolut the empty result means the passcode/sign-in wall (the sign-in notification fires once), so a run triggered before sign-in still completes once you authenticate. 0 = fail fast.",
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
  },
};

export default class RevolutTransactionsConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "revolut",
    name: "Revolut",
    description:
      "Syncs Revolut account transactions by intercepting the retail API JSON the Revolut web app fetches (no public API), through your paired Owletto Chrome session — no separate login, exact amounts (no DOM parsing).",
    version: "4.3.0",
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
    const maxScrolls = Math.max(
      1,
      Math.min(200, Number(config.max_scrolls ?? 20) || 20)
    );
    // Backfill mode ignores the checkpoint and re-emits every fetched row (the
    // gateway dedups by origin_id), so historical transactions older than the
    // checkpoint are re-ingested with correct amounts.
    const backfill = config.backfill === true;

    // How long to wait for the user to enter their passcode before giving up.
    // Revolut's rwa session is short-lived, so rather than failing the instant
    // we hit the auth wall, we fire the sign-in notification and keep retrying
    // the crawl every `EMPTY_RETRY_POLL_MS` — the moment the user signs in, the next
    // attempt succeeds and proceeds straight into the backfill within the fresh
    // session window. 0 disables the wait (fail fast).
    const dataWaitMs =
      Math.max(0, Math.min(600, Number(config.wait_for_data_seconds ?? 180))) *
      1000;

    // One crawl attempt in the single persistent rendered window (see
    // crawlPersistentWindow — the rendered window is what lets the CDP wheel
    // actually scroll Revolut's virtualized list and page older history).
    const runCrawl = () =>
      crawlPersistentWindow(dispatcher, startUrl, maxScrolls);

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
