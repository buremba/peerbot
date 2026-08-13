/**
 * Deterministic weekly Midas valuation.
 *
 * Stored reactions are single-file artifacts, so the valuation logic lives
 * here instead of importing a project helper. It reads current active Midas
 * holdings, marks each holding through the same-org market.quotes
 * action, persists one derived snapshot event, and sends a concise digest.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
} as const;

const MIDAS_HOLDING_PAGE_SIZE = 1_000;

export interface MidasHoldingMetadata {
  symbol?: string;
  type?: string;
  shares?: number;
  price?: number;
  avg_cost?: number;
  value?: number;
  currency?: string;
  status?: "active" | "closed";
}

export interface MidasHoldingRow {
  origin_id: string;
  occurred_at: Date | string;
  metadata: MidasHoldingMetadata | string | null;
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

interface MidasSnapshotPosition {
  origin_id: string;
  market: string;
  symbol: string;
  quantity: number;
  currency: string;
  average_cost: number;
  acquisition_cost: number;
  broker_price: number;
  broker_value: number;
  current_price: number;
  current_value: number;
  mark_source: "market_quote" | "broker_snapshot";
  quote_status: QuoteRow["status"];
  quote_provider: string | null;
  quote_tier: string | null;
  quote_stale: boolean | null;
  quote_as_of: string | null;
  quote_reason: string | null;
}

interface MidasSnapshotTotal {
  currency: string;
  current_value: number;
  broker_value: number;
  acquisition_cost: number;
  unrealized_gain: number;
  position_count: number;
  quoted_count: number;
  stale_quote_count: number;
  unavailable_count: number;
}

interface MidasNetWorthSnapshot {
  version: 2;
  scope: "midas";
  calculated_at: string;
  broker_as_of: string;
  quote_as_of: string | null;
  by_currency: MidasSnapshotTotal[];
  positions: MidasSnapshotPosition[];
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

function isoTimestamp(value: Date | string, field: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Midas ${field} is not a valid timestamp.`);
  }
  return date.toISOString();
}

function quoteId(market: string, symbol: string): string {
  return `${market.trim().toUpperCase()}:${symbol.trim().toUpperCase()}`;
}

function normalizeHolding(row: MidasHoldingRow): {
  originId: string;
  market: string;
  symbol: string;
  quantity: number;
  currency: string;
  averageCost: number;
  brokerPrice: number;
  brokerValue: number;
  occurredAt: string;
} {
  const metadata = objectValue(row.metadata);
  const market = String(metadata.type ?? "")
    .trim()
    .toUpperCase();
  const symbol = String(metadata.symbol ?? "")
    .trim()
    .toUpperCase();
  const currency = String(metadata.currency ?? "")
    .trim()
    .toUpperCase();
  const quantity = finiteNumber(metadata.shares);
  const averageCost = finiteNumber(metadata.avg_cost);
  const brokerPrice = finiteNumber(metadata.price);
  const statedValue = finiteNumber(metadata.value);
  const status = metadata.status;

  if (!market || !symbol || !currency) {
    throw new Error(`Midas holding ${row.origin_id} has incomplete identity.`);
  }
  if (quantity == null || quantity <= 0) {
    throw new Error(`Midas holding ${row.origin_id} has invalid shares.`);
  }
  if (averageCost == null || averageCost < 0) {
    throw new Error(`Midas holding ${row.origin_id} has invalid average cost.`);
  }
  if (brokerPrice == null || brokerPrice <= 0) {
    throw new Error(`Midas holding ${row.origin_id} has invalid broker price.`);
  }
  if (status !== "active") {
    throw new Error(`Midas holding ${row.origin_id} is not explicitly active.`);
  }
  const brokerValue =
    statedValue != null && statedValue > 0
      ? statedValue
      : quantity * brokerPrice;

  return {
    originId: row.origin_id,
    market,
    symbol,
    quantity,
    currency,
    averageCost,
    brokerPrice,
    brokerValue,
    occurredAt: isoTimestamp(row.occurred_at, "holding occurred_at"),
  };
}

function unavailableQuote(
  id: string,
  market: string,
  symbol: string,
  reason: string,
  provider: string | null = null
): Extract<QuoteRow, { status: "quote_unavailable" }> {
  return {
    status: "quote_unavailable",
    id,
    market,
    symbol,
    provider_symbol: null,
    provider: provider ?? "unknown",
    reason,
  };
}

function fallbackQuote(
  quote: QuoteRow,
  id: string,
  market: string,
  symbol: string
): Extract<QuoteRow, { status: "quote_unavailable" }> {
  return quote.status === "quote_unavailable"
    ? quote
    : unavailableQuote(id, market, symbol, "quote could not be used");
}

export function buildMidasSnapshot(
  holdingRows: MidasHoldingRow[],
  quoteRows: QuoteRow[],
  calculatedAt: string
): MidasNetWorthSnapshot {
  if (holdingRows.length === 0) {
    throw new Error("Midas has no active holdings.");
  }

  const holdings = holdingRows.map(normalizeHolding);
  const quotes = new Map(
    quoteRows.map((quote) => [quote.id.trim().toUpperCase(), quote])
  );
  const positions: MidasSnapshotPosition[] = holdings.map((holding) => {
    const id = quoteId(holding.market, holding.symbol);
    let quote =
      quotes.get(id) ??
      unavailableQuote(
        id,
        holding.market,
        holding.symbol,
        "quote action returned no row for this holding"
      );

    if (quote.status === "quoted") {
      const quotePrice = finiteNumber(quote.price);
      const quoteCurrency = quote.currency.trim().toUpperCase();
      if (quotePrice == null || quotePrice <= 0) {
        quote = unavailableQuote(
          id,
          holding.market,
          holding.symbol,
          "quote price is not a positive finite number",
          quote.provider
        );
      } else if (quoteCurrency !== holding.currency) {
        quote = unavailableQuote(
          id,
          holding.market,
          holding.symbol,
          `quote currency ${quoteCurrency} does not match holding currency ${holding.currency}`,
          quote.provider
        );
      } else {
        return {
          origin_id: holding.originId,
          market: holding.market,
          symbol: holding.symbol,
          quantity: holding.quantity,
          currency: holding.currency,
          average_cost: holding.averageCost,
          acquisition_cost: holding.quantity * holding.averageCost,
          broker_price: holding.brokerPrice,
          broker_value: holding.brokerValue,
          current_price: quotePrice,
          current_value: holding.quantity * quotePrice,
          mark_source: "market_quote" as const,
          quote_status: quote.status,
          quote_provider: quote.provider,
          quote_tier: quote.tier,
          quote_stale: quote.stale,
          quote_as_of: quote.as_of,
          quote_reason: null,
        };
      }
    }

    const unavailable = fallbackQuote(
      quote,
      id,
      holding.market,
      holding.symbol
    );
    return {
      origin_id: holding.originId,
      market: holding.market,
      symbol: holding.symbol,
      quantity: holding.quantity,
      currency: holding.currency,
      average_cost: holding.averageCost,
      acquisition_cost: holding.quantity * holding.averageCost,
      broker_price: holding.brokerPrice,
      broker_value: holding.brokerValue,
      current_price: holding.brokerPrice,
      current_value: holding.brokerValue,
      mark_source: "broker_snapshot",
      quote_status: unavailable.status,
      quote_provider:
        unavailable.provider === "unknown" ? null : unavailable.provider,
      quote_tier: null,
      quote_stale: null,
      quote_as_of: null,
      quote_reason: unavailable.reason,
    };
  });

  const totals = new Map<string, MidasSnapshotTotal>();
  for (const position of positions) {
    const total = totals.get(position.currency) ?? {
      currency: position.currency,
      current_value: 0,
      broker_value: 0,
      acquisition_cost: 0,
      unrealized_gain: 0,
      position_count: 0,
      quoted_count: 0,
      stale_quote_count: 0,
      unavailable_count: 0,
    };
    total.current_value += position.current_value;
    total.broker_value += position.broker_value;
    total.acquisition_cost += position.acquisition_cost;
    total.position_count += 1;
    if (position.mark_source === "market_quote") {
      total.quoted_count += 1;
      if (position.quote_stale) total.stale_quote_count += 1;
    } else {
      total.unavailable_count += 1;
    }
    total.unrealized_gain = total.current_value - total.acquisition_cost;
    totals.set(position.currency, total);
  }

  const brokerAsOf = holdings.reduce(
    (latest, holding) =>
      new Date(holding.occurredAt).getTime() > new Date(latest).getTime()
        ? holding.occurredAt
        : latest,
    holdings[0]?.occurredAt ?? calculatedAt
  );
  const quoteAsOf = positions.reduce<string | null>((latest, position) => {
    if (!position.quote_as_of) return latest;
    if (!latest) return position.quote_as_of;
    return new Date(position.quote_as_of).getTime() > new Date(latest).getTime()
      ? position.quote_as_of
      : latest;
  }, null);

  return {
    version: 2,
    scope: "midas",
    calculated_at: isoTimestamp(calculatedAt, "calculated_at"),
    broker_as_of: brokerAsOf,
    quote_as_of: quoteAsOf,
    by_currency: [...totals.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency)
    ),
    positions,
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

function formatAmount(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function snapshotDigest(snapshot: MidasNetWorthSnapshot): string {
  const totals = snapshot.by_currency.map(
    (total) =>
      `${formatAmount(total.currency, total.current_value)} current; ` +
      `${formatAmount(total.currency, total.acquisition_cost)} acquisition cost; ` +
      `${formatAmount(total.currency, total.unrealized_gain)} unrealized gain. ` +
      `${total.quoted_count}/${total.position_count} positions quoted` +
      (total.stale_quote_count > 0
        ? ` (${total.stale_quote_count} stale)`
        : "") +
      (total.unavailable_count > 0
        ? `; ${total.unavailable_count} using broker snapshots`
        : "")
  );
  return [
    `Midas valuation calculated ${snapshot.calculated_at}.`,
    ...totals,
    `Broker snapshot: ${snapshot.broker_as_of}. Latest market mark: ${
      snapshot.quote_as_of ?? "none"
    }.`,
  ].join("\n");
}

async function notifySyncNeeded(
  ctx: ReactionContext,
  client: ReactionClient,
  reason: string
): Promise<void> {
  await client.notifications.send({
    title: "Midas net worth needs attention",
    body: `${reason} Open Atlas in the paired browser and sync Midas before the next valuation.`,
    idempotency_key: `midas-net-worth:needs-sync:window:${ctx.window.id}`,
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
  const behaviorSource = {
    behavior_id: ctx.behavior.id,
    window_id: ctx.window.id,
  };
  const holdings: MidasHoldingRow[] = [];
  while (true) {
    const page = (await client.query(
      `SELECT origin_id, occurred_at, metadata
       FROM events
       WHERE connector_key = 'midas'
         AND semantic_type = 'financial_asset'
         AND origin_id LIKE 'midas-holding-%'
         AND metadata->>'status' = 'active'
       ORDER BY origin_id, id
       LIMIT ${MIDAS_HOLDING_PAGE_SIZE}
       OFFSET ${holdings.length}`
    )) as MidasHoldingRow[];
    holdings.push(...page);
    if (page.length < MIDAS_HOLDING_PAGE_SIZE) break;
  }
  if (holdings.length === 0) {
    await notifySyncNeeded(
      ctx,
      client,
      "No explicitly active Midas holdings exist."
    );
    return;
  }

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

  const symbols = holdings.map((row) => {
    const metadata = objectValue(row.metadata);
    return {
      market: String(metadata.type ?? "")
        .trim()
        .toUpperCase(),
      symbol: String(metadata.symbol ?? "")
        .trim()
        .toUpperCase(),
    };
  });
  const allQuotes: QuoteRow[] = [];
  const batches = Array.from(
    { length: Math.ceil(symbols.length / 50) },
    (_, index) => symbols.slice(index * 50, (index + 1) * 50)
  );
  for (const [index, batch] of batches.entries()) {
    const operation = await client.operations.execute({
      connection_id: quoteConnectionId,
      operation_key: "quote",
      input: { symbols: batch },
      idempotency_key:
        batches.length === 1
          ? `midas-net-worth:quotes:window:${ctx.window.id}`
          : `midas-net-worth:quotes:window:${ctx.window.id}:batch:${index + 1}`,
      behavior_source: behaviorSource,
    });
    if (operation.status !== "completed") {
      throw new Error(
        `Market quote operation did not complete (${operation.status ?? "unknown"}): ${
          operation.error_message ?? "no error detail"
        }`
      );
    }
    const batchQuotes = quoteRows(operation.output);
    if (batchQuotes.length === 0) {
      throw new Error("Market quote operation completed without quote rows.");
    }
    allQuotes.push(...batchQuotes);
  }

  const snapshot = buildMidasSnapshot(
    holdings,
    allQuotes,
    ctx.window.window_end
  );
  const digest = snapshotDigest(snapshot);
  const saved = await client.knowledge.save({
    content: digest,
    semantic_type: "summary",
    title: "Midas net worth snapshot",
    payload_type: "markdown",
    metadata: snapshot as unknown as Record<string, unknown>,
    occurred_at: snapshot.calculated_at,
    idempotency_key: `midas-net-worth:snapshot:window:${ctx.window.id}`,
    behavior_source: behaviorSource,
  });
  const persistedSnapshot = saved.created
    ? snapshot
    : (saved.metadata as unknown as MidasNetWorthSnapshot);
  await client.notifications.send({
    title: "Midas net worth updated",
    body: snapshotDigest(persistedSnapshot).slice(0, 1_000),
    idempotency_key: `midas-net-worth:notification:window:${ctx.window.id}`,
    behavior_source: behaviorSource,
  });
}
