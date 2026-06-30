/**
 * Revolut Connector
 *
 * Revolut has no public personal-banking API, so this connector reads the
 * user's transactions by INTERCEPTING the retail API JSON the Revolut web app
 * (`app.revolut.com`) already fetches — not by scraping the rendered DOM. It
 * runs inside the user's real signed-in Chrome via the paired Owletto
 * extension: open the transactions view in a background tab, attach the CDP
 * Network domain, scroll to make the app paginate, and parse the
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
  extensionNetworkSync,
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
  merchant?: { name?: unknown } | null;
  counterpart?: { amount?: unknown; currency?: unknown } | null;
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
      "Syncs Revolut account transactions by intercepting the retail API JSON the Revolut web app fetches (no public API), through your paired Owletto Chrome session — no separate login, exact amounts (no DOM parsing).",
    version: "4.0.0",
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

    // Intercept the retail API the SPA fetches on scroll. The helper opens an
    // about:blank tab, starts the Network listener BEFORE navigating (so the
    // initial render's XHRs aren't missed), then scroll-paginates and drains.
    const result = await extensionNetworkSync<RevolutTransaction>({
      dispatcher,
      url: startUrl,
      config: {
        interceptPatterns: [{ regex: TRANSACTIONS_LAST_PATTERN }],
        allowedOrigins: REVOLUT_ALLOWED_ORIGINS,
        maxScrolls,
        scrollDelayMs: 2500,
        responseTimeoutMs: 8000,
      },
      parseResponse: (_url, json) => parseTransactionsResponse(json),
      // Revolut's transaction list is an inner virtualized scroll container, so
      // scrolling the window alone may not page it. Scroll the deepest
      // scrollable element (the list), then nudge the window as a fallback, and
      // dispatch an `End` key to trigger lazy-load either way.
      triggerNextPage: async (tabId, d) => {
        await d.dispatch("evaluate", {
          tab_id: tabId,
          expression: `(() => {
            const els = [...document.querySelectorAll('*')].filter((e) => {
              const s = getComputedStyle(e);
              return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 40;
            });
            els.sort((a, b) => b.scrollHeight - a.scrollHeight);
            const target = els[0];
            if (target) target.scrollTo(0, target.scrollHeight);
            window.scrollTo(0, document.documentElement.scrollHeight);
            return 1;
          })()`,
          allowed_origins: REVOLUT_ALLOWED_ORIGINS,
        });
      },
    });

    // Fail closed. Zero intercepted transactions means the retail API returned
    // nothing parseable — almost always the passcode/SSO wall (401 `{code:9001}`
    // body, an sso.revolut.com redirect, or skeleton rows that never fire the
    // fetch), not a genuinely empty account. Notify + raise the typed auth-wall
    // error (leaves the checkpoint untouched) instead of a silent empty sync.
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
