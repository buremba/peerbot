/**
 * Deterministic weekly investment net-worth snapshot.
 *
 * Connector events remain the source of truth. This reaction normalizes the
 * current Midas and Revolut investment books, obtains this week's security and
 * FX marks through market.quotes, compares the result with the prior immutable
 * snapshot, and persists one bounded summary for the ISO week.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
} as const;

const PAGE_SIZE = 1_000;
const QUOTE_BATCH_SIZE = 50;
const SNAPSHOT_SCHEMA = "net-worth-snapshot/v3";
// The version suffix must track SNAPSHOT_SCHEMA: replaying a save under a
// prior version's key returns that version's persisted metadata as the
// snapshot, so the notification would be built from a stale-schema payload.
const IDEMPOTENCY_PREFIX = "net-worth:v3";
const SOURCE_FRESH_MS = 7 * 24 * 60 * 60 * 1_000;

export interface FinancialEventRow {
  id: number;
  connector_key: "midas" | "revolut";
  connection_id: number;
  connection_slug: string;
  origin_id: string;
  occurred_at: Date | string;
  metadata: Record<string, unknown> | string | null;
}

export type QuoteRow =
  | {
      status: "quoted";
      id: string;
      market: string;
      symbol: string;
      provider_symbol: string;
      provider: string;
      price: number;
      currency: string;
      as_of: string;
      stale: boolean;
      tier: string;
    }
  | {
      status: "quote_unavailable";
      id: string;
      market: string;
      symbol: string;
      provider_symbol: string | null;
      provider: string;
      reason: string;
    };

interface FxMark {
  currency: string;
  pair: string;
  rate: number;
  provider: string;
  provider_symbol: string;
  as_of: string;
  stale: boolean;
  inverted: boolean;
}

interface PositionEffect {
  position_key: string;
  source: string;
  account_key: string;
  asset_class: string;
  native_currency: string;
  quantity_gbp: number;
  price_gbp: number;
  fx_gbp: number;
  addition_gbp: number;
  disposal_gbp: number;
  total_gbp: number;
}

interface FinancialPosition {
  position_key: string;
  source: "midas" | "revolut";
  connection_id: number;
  connection_slug: string;
  origin_id: string;
  institution: "Midas" | "Revolut";
  account_key: string;
  account_type: string;
  asset_key: string;
  asset_class: string;
  market: string | null;
  symbol: string;
  quantity: number;
  native_currency: string;
  native_price: number;
  native_value: number;
  value_gbp: number;
  value_gbp_pence: number;
  price_source: "market_quote" | "broker_snapshot" | "cash_balance";
  price_as_of: string;
  quote_stale: boolean;
  fx_to_gbp: number;
  fx_pair: string;
  fx_source: string;
  fx_as_of: string;
  source_as_of: string;
  source_stale: boolean;
  average_cost?: number;
  acquisition_cost_gbp?: number;
  weekly_effects?: Omit<
    PositionEffect,
    | "position_key"
    | "source"
    | "account_key"
    | "asset_class"
    | "native_currency"
  >;
}

interface SourceCoverage {
  connector_key: "midas" | "revolut";
  scope: string;
  status: "fresh" | "stale" | "missing";
  as_of: string | null;
  stale: boolean;
  position_count: number;
  quoted: number;
  broker_marked: number;
  excluded: number;
  portfolio_balance_gbp?: number;
  cash_gbp?: number;
  portfolio_reconciliation_residual_gbp?: number;
  warning?: string;
}

interface BreakdownRow {
  key: string;
  value_gbp: number;
}

export interface FinancialSnapshot {
  version: 3;
  schema: typeof SNAPSHOT_SCHEMA;
  week: string;
  calculated_at: string;
  base_currency: "GBP";
  scope: "connected_investments_only";
  net_worth_gbp: number;
  previous: {
    week: string;
    event_id: number;
    net_worth_gbp: number;
  } | null;
  sources: SourceCoverage[];
  fx: FxMark[];
  positions: FinancialPosition[];
  breakdowns: {
    by_source: BreakdownRow[];
    by_account: BreakdownRow[];
    by_asset_class: BreakdownRow[];
    by_currency: BreakdownRow[];
  };
  attribution: {
    quantity_gbp: number;
    price_gbp: number;
    fx_gbp: number;
    additions_gbp: number;
    disposals_gbp: number;
    total_gbp: number;
  };
  attribution_positions: PositionEffect[];
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function requiredNumber(
  value: unknown,
  field: string,
  originId: string
): number {
  const number = finiteNumber(value);
  if (number == null) {
    throw new Error(`${originId} has invalid ${field}.`);
  }
  return number;
}

function isoTimestamp(value: Date | string, field: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} is not a valid timestamp.`);
  }
  return date.toISOString();
}

function upper(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function pounds(pence: number): number {
  return pence / 100;
}

function pence(amount: number): number {
  return Math.round(amount * 100);
}

function sourceIsStale(sourceAsOf: string, calculatedAt: string): boolean {
  return (
    new Date(calculatedAt).getTime() - new Date(sourceAsOf).getTime() >
    SOURCE_FRESH_MS
  );
}

export function isoWeekInTimeZone(
  value: Date | string,
  timeZone: string
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Snapshot window_end is not a valid timestamp.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day") =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const localDate = new Date(
    Date.UTC(part("year"), part("month") - 1, part("day"))
  );
  const isoDay = (localDate.getUTCDay() + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() + 3 - isoDay);
  const weekYear = localDate.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstIsoDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - firstIsoDay);
  const week =
    1 +
    Math.round(
      (localDate.getTime() - firstThursday.getTime()) /
        (7 * 24 * 60 * 60 * 1_000)
    );
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Reconnects can leave the same stable source identity live on two active
 * connections. Prefer the newest stored version, but retain event id only as
 * provenance; cross-snapshot identity is always connector_key + origin_id.
 */
export function dedupeFinancialRows(
  rows: FinancialEventRow[]
): FinancialEventRow[] {
  const current = new Map<string, FinancialEventRow>();
  for (const row of rows) {
    const key = `${row.connector_key}:${row.origin_id}`;
    const existing = current.get(key);
    if (!existing || row.id > existing.id) current.set(key, row);
  }
  return [...current.values()].sort((left, right) => left.id - right.id);
}

function quoteId(market: string, symbol: string): string {
  return `${market}:${symbol}`.toUpperCase();
}

function usableQuote(
  quote: QuoteRow | undefined,
  currency: string
): Extract<QuoteRow, { status: "quoted" }> | null {
  if (quote?.status !== "quoted") return null;
  const price = finiteNumber(quote.price);
  return price != null && price > 0 && upper(quote.currency) === currency
    ? quote
    : null;
}

function fxMark(
  currency: string,
  quoteMap: Map<string, QuoteRow>,
  calculatedAt: string
): FxMark {
  if (currency === "GBP") {
    return {
      currency,
      pair: "GBPGBP",
      rate: 1,
      provider: "identity",
      provider_symbol: "GBPGBP",
      as_of: calculatedAt,
      stale: false,
      inverted: false,
    };
  }
  const direct = usableQuote(quoteMap.get(`FX:${currency}:DIRECT`), "GBP");
  if (direct) {
    return {
      currency,
      pair: `${currency}GBP`,
      rate: direct.price,
      provider: direct.provider,
      provider_symbol: direct.provider_symbol,
      as_of: isoTimestamp(direct.as_of, `${currency} FX quote as_of`),
      stale: direct.stale,
      inverted: false,
    };
  }
  const inverse = usableQuote(quoteMap.get(`FX:${currency}:INVERSE`), currency);
  if (inverse) {
    return {
      currency,
      pair: `${currency}GBP`,
      rate: 1 / inverse.price,
      provider: inverse.provider,
      provider_symbol: inverse.provider_symbol,
      as_of: isoTimestamp(inverse.as_of, `${currency} inverse FX quote as_of`),
      stale: inverse.stale,
      inverted: true,
    };
  }
  throw new Error(`Missing a defensible ${currency} to GBP FX rate.`);
}

function requiredFxMark(
  fxByCurrency: Map<string, FxMark>,
  currency: string
): FxMark {
  const mark = fxByCurrency.get(currency);
  if (!mark) {
    throw new Error(`Missing the calculated ${currency} to GBP FX mark.`);
  }
  return mark;
}

function positionKey(row: FinancialEventRow): string {
  return `${row.connector_key}:${row.origin_id}`;
}

function normalizeMidasPosition(
  row: FinancialEventRow,
  quoteMap: Map<string, QuoteRow>,
  fx: FxMark,
  calculatedAt: string
): FinancialPosition | null {
  const metadata = objectValue(row.metadata);
  if (metadata.status !== "active") return null;
  const market = upper(metadata.type);
  const symbol = upper(metadata.symbol);
  const currency = upper(metadata.currency);
  if (!market || !symbol || !currency) {
    throw new Error(`${row.origin_id} has incomplete Midas identity.`);
  }
  const quantity = requiredNumber(metadata.shares, "shares", row.origin_id);
  const brokerPrice = requiredNumber(metadata.price, "price", row.origin_id);
  const statedValue = finiteNumber(metadata.value);
  const averageCost = finiteNumber(metadata.avg_cost);
  if (
    quantity <= 0 ||
    brokerPrice <= 0 ||
    (averageCost != null && averageCost < 0)
  ) {
    throw new Error(`${row.origin_id} has invalid Midas valuation fields.`);
  }
  const sourceAsOf = isoTimestamp(
    row.occurred_at,
    `${row.origin_id} occurred_at`
  );
  const marketQuote = usableQuote(
    quoteMap.get(quoteId(market, symbol)),
    currency
  );
  const nativePrice = marketQuote?.price ?? brokerPrice;
  const nativeValue = marketQuote
    ? quantity * nativePrice
    : statedValue != null && statedValue > 0
      ? statedValue
      : quantity * brokerPrice;
  const valuePence = pence(nativeValue * fx.rate);
  return {
    position_key: positionKey(row),
    source: "midas",
    connection_id: row.connection_id,
    connection_slug: row.connection_slug,
    origin_id: row.origin_id,
    institution: "Midas",
    account_key: "midas-investments",
    account_type: "brokerage",
    asset_key: `${market}:${symbol}`,
    asset_class: "security",
    market,
    symbol,
    quantity,
    native_currency: currency,
    native_price: nativePrice,
    native_value: nativeValue,
    value_gbp: pounds(valuePence),
    value_gbp_pence: valuePence,
    price_source: marketQuote ? "market_quote" : "broker_snapshot",
    price_as_of: marketQuote
      ? isoTimestamp(marketQuote.as_of, `${symbol} quote as_of`)
      : sourceAsOf,
    quote_stale: marketQuote?.stale ?? sourceIsStale(sourceAsOf, calculatedAt),
    fx_to_gbp: fx.rate,
    fx_pair: fx.pair,
    fx_source: fx.provider,
    fx_as_of: fx.as_of,
    source_as_of: sourceAsOf,
    source_stale: sourceIsStale(sourceAsOf, calculatedAt),
    ...(averageCost == null
      ? {}
      : {
          average_cost: averageCost,
          acquisition_cost_gbp: pounds(pence(quantity * averageCost * fx.rate)),
        }),
  };
}

function normalizeRevolutPosition(
  row: FinancialEventRow,
  fx: FxMark,
  calculatedAt: string
): FinancialPosition | null {
  const metadata = objectValue(row.metadata);
  if (metadata.closed === true) return null;
  const portfolioId = String(metadata.portfolio_id ?? "").trim();
  const ref = String(metadata.ref ?? "").trim();
  const symbol = upper(metadata.ticker ?? ref);
  const currency = upper(metadata.value_currency);
  const quantity = requiredNumber(metadata.quantity, "quantity", row.origin_id);
  const nativeValue = requiredNumber(metadata.value, "value", row.origin_id);
  if (
    !portfolioId ||
    !ref ||
    !symbol ||
    !currency ||
    quantity <= 0 ||
    nativeValue < 0
  ) {
    throw new Error(`${row.origin_id} has invalid Revolut position fields.`);
  }
  const sourceAsOf = isoTimestamp(
    row.occurred_at,
    `${row.origin_id} occurred_at`
  );
  const valuePence = pence(nativeValue * fx.rate);
  return {
    position_key: positionKey(row),
    source: "revolut",
    connection_id: row.connection_id,
    connection_slug: row.connection_slug,
    origin_id: row.origin_id,
    institution: "Revolut",
    account_key: `revolut:${portfolioId}`,
    account_type: String(metadata.account_type ?? "investment"),
    asset_key: ref,
    asset_class: String(metadata.instrument_type ?? "security").toLowerCase(),
    market: null,
    symbol,
    quantity,
    native_currency: currency,
    // The portfolio's additive value is authoritative. Deriving a unit price
    // from it guarantees quantity × price equals that value for attribution.
    native_price: nativeValue / quantity,
    native_value: nativeValue,
    value_gbp: pounds(valuePence),
    value_gbp_pence: valuePence,
    price_source: "broker_snapshot",
    price_as_of: sourceAsOf,
    quote_stale: sourceIsStale(sourceAsOf, calculatedAt),
    fx_to_gbp: fx.rate,
    fx_pair: fx.pair,
    fx_source: fx.provider,
    fx_as_of: fx.as_of,
    source_as_of: sourceAsOf,
    source_stale: sourceIsStale(sourceAsOf, calculatedAt),
  };
}

function normalizeRevolutCash(
  row: FinancialEventRow,
  fx: FxMark,
  calculatedAt: string
): FinancialPosition | null {
  const metadata = objectValue(row.metadata);
  if (metadata.closed === true) return null;
  const portfolioId = String(metadata.portfolio_id ?? "").trim();
  const currency = upper(metadata.currency);
  const cash = requiredNumber(
    metadata.cash_balance,
    "cash_balance",
    row.origin_id
  );
  if (!portfolioId || !currency || cash < 0) {
    throw new Error(`${row.origin_id} has invalid Revolut cash fields.`);
  }
  if (cash === 0) return null;
  const sourceAsOf = isoTimestamp(
    row.occurred_at,
    `${row.origin_id} occurred_at`
  );
  const valuePence = pence(cash * fx.rate);
  return {
    position_key: `revolut:${row.origin_id}:cash:${currency}`,
    source: "revolut",
    connection_id: row.connection_id,
    connection_slug: row.connection_slug,
    origin_id: row.origin_id,
    institution: "Revolut",
    account_key: `revolut:${portfolioId}`,
    account_type: String(metadata.account_type ?? "investment"),
    asset_key: `CASH:${currency}`,
    asset_class: "cash",
    market: null,
    symbol: currency,
    quantity: cash,
    native_currency: currency,
    native_price: 1,
    native_value: cash,
    value_gbp: pounds(valuePence),
    value_gbp_pence: valuePence,
    price_source: "cash_balance",
    price_as_of: sourceAsOf,
    quote_stale: sourceIsStale(sourceAsOf, calculatedAt),
    fx_to_gbp: fx.rate,
    fx_pair: fx.pair,
    fx_source: fx.provider,
    fx_as_of: fx.as_of,
    source_as_of: sourceAsOf,
    source_stale: sourceIsStale(sourceAsOf, calculatedAt),
  };
}

function latestTimestamp(rows: FinancialEventRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => {
    const occurredAt = isoTimestamp(
      row.occurred_at,
      `${row.origin_id} occurred_at`
    );
    return !latest || occurredAt > latest ? occurredAt : latest;
  }, null);
}

function breakdown(
  positions: FinancialPosition[],
  key: (position: FinancialPosition) => string
): BreakdownRow[] {
  const values = new Map<string, number>();
  for (const position of positions) {
    values.set(
      key(position),
      (values.get(key(position)) ?? 0) + position.value_gbp_pence
    );
  }
  return [...values]
    .map(([rowKey, value]) => ({ key: rowKey, value_gbp: pounds(value) }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function attribution(
  positions: FinancialPosition[],
  previous: FinancialSnapshot | null
): { summary: FinancialSnapshot["attribution"]; effects: PositionEffect[] } {
  if (!previous) {
    return {
      summary: {
        quantity_gbp: 0,
        price_gbp: 0,
        fx_gbp: 0,
        additions_gbp: 0,
        disposals_gbp: 0,
        total_gbp: 0,
      },
      effects: [],
    };
  }
  const currentByKey = new Map(
    positions.map((position) => [position.position_key, position])
  );
  const previousByKey = new Map(
    previous.positions.map((position) => [position.position_key, position])
  );
  const keys = new Set([...currentByKey.keys(), ...previousByKey.keys()]);
  const effects: PositionEffect[] = [];
  let quantityPence = 0;
  let pricePence = 0;
  let fxPence = 0;
  let additionsPence = 0;
  let disposalsPence = 0;
  for (const key of [...keys].sort()) {
    const current = currentByKey.get(key);
    const prior = previousByKey.get(key);
    const template = current ?? prior;
    if (!template) continue;
    let quantity = 0;
    let price = 0;
    let fx = 0;
    let addition = 0;
    let disposal = 0;
    let total = 0;
    if (!prior && current) {
      quantity = current.value_gbp_pence;
      addition = current.value_gbp_pence;
      total = current.value_gbp_pence;
    } else if (prior && !current) {
      quantity = -prior.value_gbp_pence;
      disposal = -prior.value_gbp_pence;
      total = -prior.value_gbp_pence;
    } else if (prior && current) {
      total = current.value_gbp_pence - prior.value_gbp_pence;
      if (current.native_currency !== prior.native_currency) {
        quantity = total;
        addition = current.value_gbp_pence;
        disposal = -prior.value_gbp_pence;
      } else {
        quantity = pence(
          (current.quantity - prior.quantity) *
            prior.native_price *
            prior.fx_to_gbp
        );
        price = pence(
          current.quantity *
            (current.native_price - prior.native_price) *
            prior.fx_to_gbp
        );
        // Assign penny-rounding remainder to FX so every position and the full
        // bridge reconcile exactly while retaining the telescoping order.
        fx = total - quantity - price;
      }
    }
    quantityPence += quantity;
    pricePence += price;
    fxPence += fx;
    additionsPence += addition;
    disposalsPence += disposal;
    effects.push({
      position_key: key,
      source: template.source,
      account_key: template.account_key,
      asset_class: template.asset_class,
      native_currency: template.native_currency,
      quantity_gbp: pounds(quantity),
      price_gbp: pounds(price),
      fx_gbp: pounds(fx),
      addition_gbp: pounds(addition),
      disposal_gbp: pounds(disposal),
      total_gbp: pounds(total),
    });
  }
  const totalPence =
    positions.reduce((sum, position) => sum + position.value_gbp_pence, 0) -
    previous.positions.reduce(
      (sum, position) => sum + position.value_gbp_pence,
      0
    );
  if (quantityPence + pricePence + fxPence !== totalPence) {
    throw new Error("Net-worth attribution did not reconcile to the penny.");
  }
  return {
    summary: {
      quantity_gbp: pounds(quantityPence),
      price_gbp: pounds(pricePence),
      fx_gbp: pounds(fxPence),
      additions_gbp: pounds(additionsPence),
      disposals_gbp: pounds(disposalsPence),
      total_gbp: pounds(totalPence),
    },
    effects,
  };
}

export function buildFinancialSnapshot(args: {
  midasRows: FinancialEventRow[];
  revolutPositionRows: FinancialEventRow[];
  revolutBalanceRows: FinancialEventRow[];
  quoteRows: QuoteRow[];
  previous: { event_id: number; snapshot: FinancialSnapshot } | null;
  calculatedAt: string;
}): FinancialSnapshot {
  const calculatedAt = isoTimestamp(args.calculatedAt, "calculated_at");
  const midasRows = dedupeFinancialRows(args.midasRows).filter(
    (row) => objectValue(row.metadata).status === "active"
  );
  const revolutPositionRows = dedupeFinancialRows(
    args.revolutPositionRows
  ).filter((row) => objectValue(row.metadata).closed !== true);
  const revolutBalanceRows = dedupeFinancialRows(
    args.revolutBalanceRows
  ).filter((row) => objectValue(row.metadata).closed !== true);
  const quoteMap = new Map(
    args.quoteRows.map((row) => [row.id.trim().toUpperCase(), row])
  );
  const currencies = new Set<string>();
  for (const row of midasRows)
    currencies.add(upper(objectValue(row.metadata).currency));
  for (const row of revolutPositionRows) {
    currencies.add(upper(objectValue(row.metadata).value_currency));
  }
  for (const row of revolutBalanceRows)
    currencies.add(upper(objectValue(row.metadata).currency));
  currencies.delete("");
  const fx = [...currencies]
    .map((currency) => fxMark(currency, quoteMap, calculatedAt))
    .sort((left, right) => left.currency.localeCompare(right.currency));
  const fxByCurrency = new Map(fx.map((mark) => [mark.currency, mark]));
  const positions: FinancialPosition[] = [];
  for (const row of midasRows) {
    const currency = upper(objectValue(row.metadata).currency);
    const position = normalizeMidasPosition(
      row,
      quoteMap,
      requiredFxMark(fxByCurrency, currency),
      calculatedAt
    );
    if (position) positions.push(position);
  }
  for (const row of revolutPositionRows) {
    const currency = upper(objectValue(row.metadata).value_currency);
    const position = normalizeRevolutPosition(
      row,
      requiredFxMark(fxByCurrency, currency),
      calculatedAt
    );
    if (position) positions.push(position);
  }
  for (const row of revolutBalanceRows) {
    const currency = upper(objectValue(row.metadata).currency);
    const position = normalizeRevolutCash(
      row,
      requiredFxMark(fxByCurrency, currency),
      calculatedAt
    );
    if (position) positions.push(position);
  }
  positions.sort((left, right) =>
    left.position_key.localeCompare(right.position_key)
  );
  if (positions.length === 0) {
    throw new Error(
      "No current Midas or Revolut investment positions are available."
    );
  }

  const revolutByPortfolio = new Map<string, number>();
  for (const position of positions.filter(
    (position) => position.source === "revolut"
  )) {
    revolutByPortfolio.set(
      position.account_key,
      (revolutByPortfolio.get(position.account_key) ?? 0) +
        position.value_gbp_pence
    );
  }
  let portfolioBalancePence = 0;
  let portfolioResidualPence = 0;
  let cashPence = 0;
  for (const row of revolutBalanceRows) {
    const metadata = objectValue(row.metadata);
    const portfolioId = String(metadata.portfolio_id ?? "").trim();
    const currency = upper(metadata.currency);
    const mark = requiredFxMark(fxByCurrency, currency);
    const balancePence = pence(
      requiredNumber(metadata.balance, "balance", row.origin_id) * mark.rate
    );
    portfolioBalancePence += balancePence;
    portfolioResidualPence +=
      (revolutByPortfolio.get(`revolut:${portfolioId}`) ?? 0) - balancePence;
    cashPence += pence(
      requiredNumber(metadata.cash_balance, "cash_balance", row.origin_id) *
        mark.rate
    );
  }

  const midasAsOf = latestTimestamp(midasRows);
  const revolutAsOf = latestTimestamp([
    ...revolutPositionRows,
    ...revolutBalanceRows,
  ]);
  const midasPositions = positions.filter(
    (position) => position.source === "midas"
  );
  const revolutPositions = positions.filter(
    (position) => position.source === "revolut"
  );
  const sources: SourceCoverage[] = [
    {
      connector_key: "midas",
      scope: "investment positions",
      status: !midasAsOf
        ? "missing"
        : sourceIsStale(midasAsOf, calculatedAt)
          ? "stale"
          : "fresh",
      as_of: midasAsOf,
      stale: !midasAsOf || sourceIsStale(midasAsOf, calculatedAt),
      position_count: midasPositions.length,
      quoted: midasPositions.filter(
        (position) => position.price_source === "market_quote"
      ).length,
      broker_marked: midasPositions.filter(
        (position) => position.price_source === "broker_snapshot"
      ).length,
      excluded: 0,
      ...(!midasAsOf ? { warning: "No current Midas investment rows." } : {}),
    },
    {
      connector_key: "revolut",
      scope: "Invest portfolios only; current-account cash is unavailable",
      status: !revolutAsOf
        ? "missing"
        : sourceIsStale(revolutAsOf, calculatedAt)
          ? "stale"
          : "fresh",
      as_of: revolutAsOf,
      stale: !revolutAsOf || sourceIsStale(revolutAsOf, calculatedAt),
      position_count: revolutPositions.length,
      quoted: 0,
      broker_marked: revolutPositions.filter(
        (position) => position.price_source === "broker_snapshot"
      ).length,
      excluded: 0,
      portfolio_balance_gbp: pounds(portfolioBalancePence),
      cash_gbp: pounds(cashPence),
      portfolio_reconciliation_residual_gbp: pounds(portfolioResidualPence),
      warning:
        "Revolut coverage includes Invest portfolios, not retail current-account cash.",
    },
  ];

  const previousSnapshot = args.previous?.snapshot ?? null;
  const bridge = attribution(positions, previousSnapshot);
  const effectsByKey = new Map(
    bridge.effects.map((effect) => [effect.position_key, effect])
  );
  for (const position of positions) {
    const effect = effectsByKey.get(position.position_key);
    if (!effect) continue;
    position.weekly_effects = {
      quantity_gbp: effect.quantity_gbp,
      price_gbp: effect.price_gbp,
      fx_gbp: effect.fx_gbp,
      addition_gbp: effect.addition_gbp,
      disposal_gbp: effect.disposal_gbp,
      total_gbp: effect.total_gbp,
    };
  }
  const netWorthPence = positions.reduce(
    (sum, position) => sum + position.value_gbp_pence,
    0
  );
  return {
    version: 3,
    schema: SNAPSHOT_SCHEMA,
    week: isoWeekInTimeZone(calculatedAt, "Europe/London"),
    calculated_at: calculatedAt,
    base_currency: "GBP",
    scope: "connected_investments_only",
    net_worth_gbp: pounds(netWorthPence),
    previous: args.previous
      ? {
          week: args.previous.snapshot.week,
          event_id: args.previous.event_id,
          net_worth_gbp: args.previous.snapshot.net_worth_gbp,
        }
      : null,
    sources,
    fx,
    positions,
    breakdowns: {
      by_source: breakdown(positions, (position) => position.source),
      by_account: breakdown(positions, (position) => position.account_key),
      by_asset_class: breakdown(positions, (position) => position.asset_class),
      by_currency: breakdown(positions, (position) => position.native_currency),
    },
    attribution: bridge.summary,
    attribution_positions: bridge.effects,
  };
}

function connectionRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  const object = objectValue(value);
  return Array.isArray(object.connections)
    ? (object.connections as Array<Record<string, unknown>>)
    : [];
}

function quoteRows(value: unknown): QuoteRow[] {
  const object = objectValue(value);
  return Array.isArray(object.quotes) ? (object.quotes as QuoteRow[]) : [];
}

async function readPages(
  client: ReactionClient,
  query: (offset: number) => string
): Promise<FinancialEventRow[]> {
  const rows: FinancialEventRow[] = [];
  while (true) {
    const page = (await client.query(
      query(rows.length)
    )) as FinancialEventRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return dedupeFinancialRows(rows);
  }
}

function quoteInputs(args: {
  midasRows: FinancialEventRow[];
  revolutPositionRows: FinancialEventRow[];
  revolutBalanceRows: FinancialEventRow[];
}): Array<Record<string, string>> {
  const inputs = new Map<string, Record<string, string>>();
  const currencies = new Set<string>();
  for (const row of args.midasRows) {
    const metadata = objectValue(row.metadata);
    const market = upper(metadata.type);
    const symbol = upper(metadata.symbol);
    const currency = upper(metadata.currency);
    if (market && symbol) {
      inputs.set(quoteId(market, symbol), { market, symbol });
    }
    if (currency) currencies.add(currency);
  }
  for (const row of args.revolutPositionRows) {
    const currency = upper(objectValue(row.metadata).value_currency);
    if (currency) currencies.add(currency);
  }
  for (const row of args.revolutBalanceRows) {
    const currency = upper(objectValue(row.metadata).currency);
    if (currency) currencies.add(currency);
  }
  for (const currency of currencies) {
    if (currency === "GBP") continue;
    inputs.set(`FX:${currency}:DIRECT`, {
      id: `FX:${currency}:DIRECT`,
      market: "FX",
      symbol: `${currency}GBP=X`,
      provider_symbol: `${currency}GBP=X`,
    });
    inputs.set(`FX:${currency}:INVERSE`, {
      id: `FX:${currency}:INVERSE`,
      market: "FX",
      symbol: `GBP${currency}=X`,
      provider_symbol: `GBP${currency}=X`,
    });
  }
  return [...inputs.values()];
}

function formatGbp(amount: number): string {
  return `GBP ${amount.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function snapshotDigest(snapshot: FinancialSnapshot): string {
  const lines = [
    `Net worth: ${formatGbp(snapshot.net_worth_gbp)} (${snapshot.week}).`,
    snapshot.previous
      ? `Weekly change: ${formatGbp(snapshot.attribution.total_gbp)}; quantity ${formatGbp(snapshot.attribution.quantity_gbp)}, price ${formatGbp(snapshot.attribution.price_gbp)}, FX ${formatGbp(snapshot.attribution.fx_gbp)}.`
      : "This is the first consolidated baseline; weekly attribution starts with the next snapshot.",
    ...snapshot.sources.map((source) =>
      `${source.connector_key}: ${source.status}, ${source.position_count} included position${source.position_count === 1 ? "" : "s"}. ${source.warning ?? ""}`.trim()
    ),
    "Coverage is connected investments only; it is not complete household net worth.",
  ];
  return lines.join("\n");
}

async function notifyNeedsAttention(
  ctx: ReactionContext,
  client: ReactionClient,
  reason: string
): Promise<void> {
  await client.notifications.send({
    title: "Net worth needs attention",
    body: reason,
    idempotency_key: `${IDEMPOTENCY_PREFIX}:needs-attention:week:${isoWeekInTimeZone(ctx.window.window_end, "Europe/London")}`,
    behavior_source: {
      behavior_id: ctx.behavior.id,
      window_id: ctx.window.id,
    },
  });
}

export default async function runNetWorthSnapshot(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> {
  const calculatedAt = isoTimestamp(ctx.window.window_end, "window_end");
  const week = isoWeekInTimeZone(calculatedAt, "Europe/London");
  const eventColumns =
    "events.id, events.connector_key, events.connection_id, connections.slug AS connection_slug, events.origin_id, events.occurred_at, events.metadata";
  const midasRows = await readPages(
    client,
    (offset) => `SELECT ${eventColumns}
       FROM events
       JOIN connections ON connections.id = events.connection_id
        AND connections.connector_key = events.connector_key
       WHERE events.connector_key = 'midas'
         AND connections.status = 'active'
         AND events.semantic_type = 'financial_asset'
         AND events.metadata->>'status' = 'active'
       ORDER BY events.origin_id, events.id
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`
  );
  const revolutPositionRows = await readPages(
    client,
    (offset) => `SELECT ${eventColumns}
       FROM events
       JOIN connections ON connections.id = events.connection_id
        AND connections.connector_key = events.connector_key
       WHERE events.connector_key = 'revolut'
         AND connections.status = 'active'
         AND events.semantic_type = 'investment_position'
         AND events.metadata->>'closed' IS DISTINCT FROM 'true'
       ORDER BY events.origin_id, events.id
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`
  );
  const revolutBalanceRows = await readPages(
    client,
    (offset) => `SELECT ${eventColumns}
       FROM events
       JOIN connections ON connections.id = events.connection_id
        AND connections.connector_key = events.connector_key
       WHERE events.connector_key = 'revolut'
         AND connections.status = 'active'
         AND events.semantic_type = 'investment_balance'
         AND events.metadata->>'closed' IS DISTINCT FROM 'true'
       ORDER BY events.origin_id, events.id
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`
  );
  if (
    midasRows.length === 0 &&
    revolutPositionRows.length === 0 &&
    revolutBalanceRows.length === 0
  ) {
    await notifyNeedsAttention(
      ctx,
      client,
      "No current Midas or Revolut investment data is available. Sync the investment feeds and retry."
    );
    return;
  }

  const previousRows = (await client.query(
    `SELECT id, metadata
       FROM events
       WHERE semantic_type = 'summary'
         AND metadata->>'schema' = '${SNAPSHOT_SCHEMA}'
         AND metadata->>'week' <> '${week}'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
  )) as Array<{ id: number; metadata: FinancialSnapshot | string }>;
  const previousRow = previousRows[0];
  const previous = previousRow
    ? {
        event_id: Number(previousRow.id),
        snapshot: objectValue(
          previousRow.metadata
        ) as unknown as FinancialSnapshot,
      }
    : null;

  const requestedQuotes = quoteInputs({
    midasRows,
    revolutPositionRows,
    revolutBalanceRows,
  });
  const allQuotes: QuoteRow[] = [];
  if (requestedQuotes.length > 0) {
    const listedConnections = await client.connections.list({
      connector_key: "market.quotes",
      status: "active",
      limit: 10,
    });
    const quoteConnection = connectionRows(listedConnections).find(
      (connection) => connection.slug === "market-quotes"
    );
    const quoteConnectionId = finiteNumber(quoteConnection?.id);
    if (
      quoteConnectionId == null ||
      !Number.isSafeInteger(quoteConnectionId) ||
      quoteConnectionId <= 0
    ) {
      throw new Error(
        "The active market-quotes connection is missing from this workspace."
      );
    }
    const batches = Array.from(
      { length: Math.ceil(requestedQuotes.length / QUOTE_BATCH_SIZE) },
      (_, index) =>
        requestedQuotes.slice(
          index * QUOTE_BATCH_SIZE,
          (index + 1) * QUOTE_BATCH_SIZE
        )
    );
    for (const [index, batch] of batches.entries()) {
      const operation = await client.operations.execute({
        connection_id: quoteConnectionId,
        operation_key: "quote",
        input: { symbols: batch },
        idempotency_key: `${IDEMPOTENCY_PREFIX}:quotes:week:${week}:batch:${index + 1}`,
        behavior_source: {
          behavior_id: ctx.behavior.id,
          window_id: ctx.window.id,
        },
      });
      if (operation.status !== "completed") {
        throw new Error(
          `Market quote operation did not complete (${operation.status ?? "unknown"}): ${operation.error_message ?? "no error detail"}`
        );
      }
      allQuotes.push(...quoteRows(operation.output));
    }
  }

  let snapshot: FinancialSnapshot;
  try {
    snapshot = buildFinancialSnapshot({
      midasRows,
      revolutPositionRows,
      revolutBalanceRows,
      quoteRows: allQuotes,
      previous,
      calculatedAt,
    });
  } catch (error) {
    await notifyNeedsAttention(
      ctx,
      client,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
  const saved = await client.knowledge.save({
    content: snapshotDigest(snapshot),
    semantic_type: "summary",
    title: `Net worth snapshot · ${week}`,
    payload_type: "markdown",
    metadata: snapshot as unknown as Record<string, unknown>,
    occurred_at: snapshot.calculated_at,
    idempotency_key: `${IDEMPOTENCY_PREFIX}:snapshot:week:${week}`,
    behavior_source: {
      behavior_id: ctx.behavior.id,
      window_id: ctx.window.id,
    },
  });
  const persistedSnapshot = saved.created
    ? snapshot
    : (saved.metadata as unknown as FinancialSnapshot);
  await client.notifications.send({
    title: "Net worth updated",
    body: snapshotDigest(persistedSnapshot).slice(0, 1_000),
    idempotency_key: `${IDEMPOTENCY_PREFIX}:notification:week:${week}`,
    behavior_source: {
      behavior_id: ctx.behavior.id,
      window_id: ctx.window.id,
    },
  });
}
