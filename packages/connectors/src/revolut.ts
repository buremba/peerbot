/**
 * Revolut Connector (V1 runtime)
 *
 * Revolut has no public personal-banking API, so this connector drives the
 * Revolut web app and captures the JSON it fetches from
 * `app.revolut.com/api/retail/user/current/transactions/last?...` while
 * paginating the transaction list (the `to=<ms>` param walks back in time).
 *
 * Auth: CDP only. Revolut's `app.revolut.com` access token (`credentials`
 * cookie) is bound to the browser that minted it (a per-request `x-device-id`
 * header + Cloudflare/TLS fingerprint), so exported cookies replayed in a fresh
 * headless browser get a 401 on `/api/retail/...` and bounce to
 * `sso.revolut.com/passcode`. The connector therefore connects over CDP to a
 * Chrome that already holds the live session — see the auth-schema notes.
 *
 * The emitted event shape matches the original file-import Revolut connector
 * (`semantic_type: "transaction"`, metadata `{ date, description, amount,
 * direction, balance, currency }`) so historical imports stay uniform.
 */

import {
	browserNetworkSync,
	type ConnectorDefinition,
	ConnectorRuntime,
	type EventEnvelope,
	type SyncContext,
	type SyncResult,
} from "@lobu/connector-sdk";
import {
	getBrowserCdpUrl,
	getBrowserCookies,
	getBrowserUserDataDir,
	validateCookieNotExpired,
} from "./browser-scraper-utils";

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

// Currencies with zero minor units — Revolut returns these amounts unscaled.
const ZERO_DECIMAL_CURRENCIES = new Set([
	"JPY",
	"KRW",
	"VND",
	"CLP",
	"ISK",
	"XAF",
	"XOF",
	"BIF",
	"DJF",
	"GNF",
	"KMF",
	"MGA",
	"PYG",
	"RWF",
	"UGX",
	"VUV",
	"XPF",
]);

// Transaction states worth keeping. DECLINED/FAILED/REVERTED never settled.
const KEPT_STATES = new Set(["COMPLETED", "PENDING", "CONFIRMED", "SETTLED"]);

// Fields the web app uses for the transaction timestamp, best first.
const TIMESTAMP_FIELDS = [
	"completedDate",
	"completed_date",
	"completedAt",
	"bookingDate",
	"booking_date",
	"valueDate",
	"value_date",
	"startedDate",
	"started_date",
	"createdDate",
	"created_date",
	"createdAt",
	"date",
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function minorUnitsToMajor(raw: number, currency: string): number {
	const exponent = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
	return raw / 10 ** exponent;
}

function coerceTimestamp(value: unknown): Date | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		// Revolut uses ms-epoch; treat 10-digit values as seconds defensively.
		const ms = value < 1e12 ? value * 1000 : value;
		const d = new Date(ms);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	if (typeof value === "string" && value.trim()) {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}

function extractAmountAndCurrency(
	record: Record<string, unknown>,
): { amount: number; currency: string } | null {
	// Flat shape: { amount: -2000, currency: "GBP" }
	if (
		typeof record.amount === "number" &&
		typeof record.currency === "string"
	) {
		return { amount: record.amount, currency: record.currency };
	}
	// Nested money shape: { amount: { value: -2000, currency: "GBP" } } or
	// { amount: { amount: -20.0, currency: "GBP" } }.
	const amt = record.amount;
	if (amt && typeof amt === "object") {
		const obj = amt as Record<string, unknown>;
		let value: number | null = null;
		if (typeof obj.value === "number") value = obj.value;
		else if (typeof obj.amount === "number") value = obj.amount;
		const currency = typeof obj.currency === "string" ? obj.currency : null;
		if (value !== null && currency) return { amount: value, currency };
	}
	return null;
}

function nameOf(node: unknown): string | null {
	if (!node || typeof node !== "object") return null;
	const obj = node as Record<string, unknown>;
	for (const key of ["name", "legalName", "username", "displayName"]) {
		const v = obj[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return null;
}

function describeTransaction(record: Record<string, unknown>): string {
	// Card payments carry a clean `merchant.name` ("OpenAI") alongside a noisy
	// raw descriptor ("Openai *chatgpt Subscr") — prefer the merchant name, which
	// is also what the Revolut UI shows and what the legacy import used. Transfers
	// and top-ups have no merchant, so fall back to the human description.
	const merchant = nameOf(record.merchant);
	if (merchant) return merchant;
	for (const key of [
		"description",
		"localisedDescription",
		"reference",
		"comment",
	]) {
		const v = record[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	for (const key of [
		"counterpart",
		"counterparty",
		"recipient",
		"sender",
		"beneficiary",
	]) {
		const v = nameOf(record[key]);
		if (v) return v;
	}
	const type = record.type;
	return typeof type === "string" && type.trim()
		? type.replace(/_/g, " ")
		: "Transaction";
}

function extractBalance(
	record: Record<string, unknown>,
	currency: string,
): number | undefined {
	let raw: unknown;
	if (typeof record.balance === "number") {
		raw = record.balance;
	} else if (record.balance && typeof record.balance === "object") {
		const obj = record.balance as Record<string, unknown>;
		raw = obj.value ?? obj.amount;
	}
	if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
	return Number.isInteger(raw) ? minorUnitsToMajor(raw, currency) : raw;
}

function parseTransactionRecord(
	record: Record<string, unknown>,
): RevolutTransaction | null {
	const money = extractAmountAndCurrency(record);
	if (!money) return null;

	const id = record.id ?? record.legId ?? record.transactionId ?? record.code;
	if (typeof id !== "string" && typeof id !== "number") return null;

	let occurredAt: Date | null = null;
	for (const field of TIMESTAMP_FIELDS) {
		occurredAt = coerceTimestamp(record[field]);
		if (occurredAt) break;
	}
	if (!occurredAt) return null;

	const state =
		typeof record.state === "string" ? record.state.toUpperCase() : undefined;
	if (state && !KEPT_STATES.has(state)) return null;

	const currency = money.currency.toUpperCase();
	// Revolut's retail API returns integer minor units; some endpoints return a
	// decimal already in major units — fractional values mean "already major".
	const value = Number.isInteger(money.amount)
		? minorUnitsToMajor(money.amount, currency)
		: money.amount;

	return {
		id: String(id),
		description: describeTransaction(record),
		amount: Math.abs(value),
		direction: value < 0 ? "out" : "in",
		balance: extractBalance(record, currency),
		currency,
		date: occurredAt.toISOString().slice(0, 10),
		occurredAt,
		type: typeof record.type === "string" ? record.type : undefined,
		state,
	};
}

/**
 * Walk an arbitrary JSON value and pull out anything that looks like a Revolut
 * transaction. The web app's responses vary (bare arrays, `{ items: [...] }`,
 * paginated envelopes, single-transaction detail endpoints), so we recurse
 * rather than assume one shape. A record only counts as a transaction if it
 * carries both an amount/currency and a timestamp, which keeps merchant/budget
 * objects out.
 */
export function extractTransactionsFromResponse(
	json: unknown,
): RevolutTransaction[] {
	const found: RevolutTransaction[] = [];
	const seen = new Set<object>();

	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		if (seen.has(node as object)) return;
		seen.add(node as object);

		if (Array.isArray(node)) {
			for (const item of node) {
				const parsed =
					item && typeof item === "object" && !Array.isArray(item)
						? parseTransactionRecord(item as Record<string, unknown>)
						: null;
				if (parsed) found.push(parsed);
				else visit(item);
			}
			return;
		}

		const record = node as Record<string, unknown>;
		const asTxn = parseTransactionRecord(record);
		if (asTxn) {
			found.push(asTxn);
			return;
		}
		for (const value of Object.values(record)) visit(value);
	};

	visit(json);
	return found;
}

// ---------------------------------------------------------------------------
// Checkpoint filtering
// ---------------------------------------------------------------------------

export function filterTransactionsSinceCheckpoint(
	transactions: RevolutTransaction[],
	checkpoint: RevolutCheckpoint | null | undefined,
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
		if (
			lastTs !== null &&
			Number.isFinite(lastTs) &&
			t.occurredAt.getTime() <= lastTs
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
// Sync
// ---------------------------------------------------------------------------

// The Revolut web app fetches account history from
// `app.revolut.com/api/retail/user/current/transactions/last?count=N&to=<ms>&internalPocketId=<uuid>`
// (the `to` param walks back in time as you scroll). These patterns also cover
// plausible alternates without catching unrelated `/api/retail/...` calls.
const TRANSACTION_API_PATTERNS: RegExp[] = [
	/\/api\/retail\/.*transactions?(?:\/|\b)/i,
	/\/api\/.*\/transactions(?:\b|\?|\/|$)/i,
	/transactions?[./](?:last|recent|history|search)/i,
];

const REVOLUT_AUTH_DOMAINS = ["app.revolut.com", ".revolut.com"];
// `/transactions` shows the full, infinitely-scrollable history for the default
// account; `/home` only shows the latest ~10. Per-pocket history lives at
// `/transactions?accountType=pocket&walletId=<uuid>&pocketId=<uuid>` — point a
// second feed's `start_url` there to sync a non-default currency pocket.
const DEFAULT_START_URL = "https://app.revolut.com/transactions";

function isLoggedIn(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return false;
	}
	// An unauthenticated session is bounced to sso.revolut.com/passcode.
	if (host !== "app.revolut.com") return false;
	return !/\/(?:start|signin|login|verify|onboarding)\b/i.test(url);
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
			maximum: 100,
			default: 20,
			description:
				"Maximum scroll iterations to paginate older transactions (default: 20).",
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

export default class RevolutConnector extends ConnectorRuntime {
	readonly definition: ConnectorDefinition = {
		key: "revolut",
		name: "Revolut",
		description:
			"Syncs Revolut account transactions from the Revolut web app (no public API). Requires a Chrome instance, with remote debugging enabled, that stays logged in to app.revolut.com.",
		version: "2.0.0",
		faviconDomain: "app.revolut.com",
		authSchema: {
			methods: [
				// CDP only — *not* `cli` cookie capture. Revolut's `app.revolut.com`
				// access token (the `credentials` cookie) is bound to the browser that
				// minted it (device-id header + Cloudflare/TLS fingerprint), so cookies
				// exported from Chrome and replayed in a fresh headless browser get a 401
				// on /api/retail/... and bounce to sso.revolut.com/passcode. The only
				// path that authenticates is connecting over CDP to the *same* Chrome
				// that holds the live session — keep one logged in and reachable.
				{
					type: "browser",
					capture: "cdp",
					defaultCdpUrl: "http://127.0.0.1:9222",
					requiredDomains: REVOLUT_AUTH_DOMAINS,
					description:
						"Connect over CDP to a Chrome logged in to app.revolut.com: lobu memory browser-auth --connector revolut --launch-cdp (log in there, re-enter the passcode whenever Revolut expires the session).",
				},
			],
		},
		feeds: {
			transactions: {
				key: "transactions",
				name: "Transactions",
				description: "Account transactions pulled from the Revolut web app.",
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
			Math.min(100, Number(config.max_scrolls ?? 20) || 20),
		);

		// Primary auth is CDP (connect to the Chrome that holds the live Revolut
		// session). Stored cookies are only a best-effort fallback for the
		// Playwright path — see the auth-schema comment on why they rarely suffice
		// for Revolut. Don't fail the sync just because there are none.
		const userDataDir = getBrowserUserDataDir(ctx.sessionState);
		const cdpUrl = getBrowserCdpUrl(ctx.sessionState) ?? "auto";
		let cookies: ReturnType<typeof getBrowserCookies> = [];
		if (!userDataDir) {
			try {
				cookies = getBrowserCookies(
					ctx.checkpoint as Record<string, unknown> | null,
					ctx.sessionState,
					"revolut",
				);
				validateCookieNotExpired(cookies, "credentials", "revolut");
			} catch {
				cookies = [];
			}
		}

		const result = await browserNetworkSync<RevolutTransaction>({
			config: {
				interceptPatterns: TRANSACTION_API_PATTERNS,
				authDomains: REVOLUT_AUTH_DOMAINS,
				maxScrolls,
				scrollDelayMs: 2500,
				responseTimeoutMs: 8000,
				navigationTimeoutMs: 20000,
				stealth: true,
			},
			url: startUrl,
			cdpUrl,
			cookies,
			userDataDir,
			parseResponse: (_url, json) => extractTransactionsFromResponse(json),
			checkAuth: async (page) => isLoggedIn(page.url()),
		});

		let transactions = filterTransactionsSinceCheckpoint(
			result.items,
			checkpoint,
		);
		if (currencyFilter) {
			transactions = transactions.filter((t) => t.currency === currencyFilter);
		}
		transactions.sort(
			(a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
		);

		const events: EventEnvelope[] = transactions.map(transactionToEvent);
		const newest = transactions[0];
		const newCheckpoint: RevolutCheckpoint = newest
			? {
					last_transaction_id: newest.id,
					last_timestamp: newest.occurredAt.toISOString(),
				}
			: checkpoint;

		return {
			events,
			checkpoint: newCheckpoint as unknown as Record<string, unknown>,
			auth_update: { cookies: result.cookies },
			metadata: {
				items_found: events.length,
				api_calls: result.apiCallCount,
				backend: result.backend,
				...(currencyFilter ? { currency_filter: currencyFilter } : {}),
			},
		};
	}
}
