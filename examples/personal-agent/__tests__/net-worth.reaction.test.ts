import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import runNetWorthSnapshot, {
  buildMidasSnapshot,
  type MidasBalanceRow,
  type MidasHoldingMetadata,
  type MidasHoldingRow,
  type QuoteRow,
} from "../net-worth.reaction";

const balance: MidasBalanceRow = {
  run_id: 22,
  occurred_at: "2026-08-10T08:00:00.000Z",
};

function holding(
  symbol: string,
  value: number,
  overrides: Partial<MidasHoldingMetadata> = {}
): MidasHoldingRow {
  return {
    origin_id: `midas-holding-US-${symbol}`,
    occurred_at: "2026-08-10T08:00:00.000Z",
    metadata: {
      symbol,
      type: "US",
      shares: 2,
      price: value / 2,
      avg_cost: value / 4,
      value,
      currency: "USD",
      ...overrides,
    },
  };
}

const ctx: ReactionContext = {
  extracted_data: { summary: "Run the deterministic valuation." },
  entities: [],
  window: {
    id: 91,
    run_id: 300,
    behavior_id: 45,
    window_start: "2026-08-12T08:59:00.000Z",
    window_end: "2026-08-12T09:00:00.000Z",
    granularity: "week",
    content_analyzed: 0,
  },
  behavior: {
    id: 45,
    slug: "midas-net-worth",
    name: "Midas net worth",
    version: 1,
  },
  organization_id: "org-buremba",
  organization_slug: "buremba",
};

describe("buildMidasSnapshot", () => {
  test("uses live quotes while retaining unavailable holdings at their broker mark", () => {
    const holdings = [holding("AAPL", 200), holding("NOPE", 80)];
    const quotes: QuoteRow[] = [
      {
        status: "quoted",
        id: "US:AAPL",
        market: "US",
        symbol: "AAPL",
        provider_symbol: "AAPL",
        provider: "yahoo",
        price: 250,
        currency: "USD",
        as_of: "2026-08-12T08:58:00.000Z",
        stale: false,
        tier: "delayed",
      },
      {
        status: "quote_unavailable",
        id: "US:NOPE",
        market: "US",
        symbol: "NOPE",
        provider_symbol: "NOPE",
        provider: "yahoo",
        reason: "not found",
      },
    ];

    const snapshot = buildMidasSnapshot(
      balance,
      holdings,
      quotes,
      "2026-08-12T09:00:00.000Z"
    );

    expect(snapshot.midas_run_id).toBe(22);
    expect(snapshot.positions).toHaveLength(2);
    expect(snapshot.positions[0]).toMatchObject({
      symbol: "AAPL",
      current_value: 500,
      mark_source: "market_quote",
      acquisition_cost: 100,
    });
    expect(snapshot.positions[1]).toMatchObject({
      symbol: "NOPE",
      current_value: 80,
      mark_source: "broker_snapshot",
      quote_status: "quote_unavailable",
    });
    expect(snapshot.by_currency).toEqual([
      {
        currency: "USD",
        current_value: 580,
        broker_value: 280,
        acquisition_cost: 140,
        unrealized_gain: 440,
        position_count: 2,
        quoted_count: 1,
        stale_quote_count: 0,
        unavailable_count: 1,
      },
    ]);
  });

  test("rejects a quote in a different currency instead of mixing currencies", () => {
    const snapshot = buildMidasSnapshot(
      balance,
      [holding("AAPL", 200)],
      [
        {
          status: "quoted",
          id: "US:AAPL",
          market: "US",
          symbol: "AAPL",
          provider_symbol: "AAPL",
          provider: "yahoo",
          price: 250,
          currency: "EUR",
          as_of: "2026-08-12T08:58:00.000Z",
          stale: false,
          tier: "delayed",
        },
      ],
      "2026-08-12T09:00:00.000Z"
    );

    expect(snapshot.positions[0]).toMatchObject({
      current_value: 200,
      mark_source: "broker_snapshot",
      quote_status: "quote_unavailable",
      quote_reason: "quote currency EUR does not match holding currency USD",
    });
  });
});

describe("weekly net-worth reaction", () => {
  test("queries one Midas cohort, executes the local quote action, and saves one derived event", async () => {
    const queries: string[] = [];
    const operationInputs: unknown[] = [];
    const saved: unknown[] = [];
    const notified: unknown[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return queries.length === 1
          ? [balance]
          : [holding("AAPL", 200), holding("NOPE", 80)];
      },
      connections: {
        list: async () => ({
          connections: [
            {
              id: 77,
              slug: "market-quotes",
              connector_key: "market.quotes",
              status: "active",
            },
          ],
        }),
      },
      operations: {
        execute: async (input: unknown) => {
          operationInputs.push(input);
          return {
            status: "completed",
            output: {
              quotes: [
                {
                  status: "quoted",
                  id: "US:AAPL",
                  market: "US",
                  symbol: "AAPL",
                  provider_symbol: "AAPL",
                  provider: "yahoo",
                  price: 250,
                  currency: "USD",
                  as_of: "2026-08-12T08:58:00.000Z",
                  stale: false,
                  tier: "delayed",
                },
                {
                  status: "quote_unavailable",
                  id: "US:NOPE",
                  market: "US",
                  symbol: "NOPE",
                  provider_symbol: "NOPE",
                  provider: "yahoo",
                  reason: "not found",
                },
              ],
            },
          };
        },
      },
      knowledge: {
        save: async (input: unknown) => {
          saved.push(input);
          return { id: 501, created: true, metadata: {} };
        },
      },
      notifications: {
        send: async (input: unknown) => {
          notified.push(input);
          return { notified_count: 1, event_id: 502, url: null };
        },
      },
      log: () => undefined,
    } as unknown as ReactionClient;

    await runNetWorthSnapshot(ctx, client);

    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("run_id = 22");
    expect(operationInputs).toEqual([
      {
        connection_id: 77,
        operation_key: "quote",
        input: {
          symbols: [
            { market: "US", symbol: "AAPL" },
            { market: "US", symbol: "NOPE" },
          ],
        },
        idempotency_key: "midas-net-worth:quotes:window:91:midas-run:22",
        behavior_source: { behavior_id: 45, window_id: 91 },
      },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      semantic_type: "summary",
      title: "Midas net worth snapshot",
      idempotency_key: "midas-net-worth:snapshot:window:91",
      behavior_source: { behavior_id: 45, window_id: 91 },
      metadata: {
        scope: "midas",
        midas_run_id: 22,
        by_currency: [{ currency: "USD", current_value: 580 }],
      },
    });
    expect(notified).toHaveLength(1);
  });

  test("excludes closed holdings from the cohort so one sale cannot fail the valuation", async () => {
    const closed = holding("NOVA", 0, {
      shares: 0,
      price: 0,
      avg_cost: 0,
      value: 0,
      status: "closed",
    });
    // Stands in for Postgres: the row is withheld only if the SQL actually
    // filters it out. Drop the exclusion from the query and the closed row
    // reaches normalization, which rejects shares <= 0 and throws.
    const client = {
      query: async (sql: string) => {
        if (sql.includes("midas-balance")) return [balance];
        const rows = [holding("AAPL", 200), closed];
        return sql.includes("<> 'closed'")
          ? rows.filter((row) => row.metadata.status !== "closed")
          : rows;
      },
      connections: {
        list: async () => ({
          connections: [
            {
              id: 77,
              slug: "market-quotes",
              connector_key: "market.quotes",
              status: "active",
            },
          ],
        }),
      },
      operations: {
        execute: async () => ({
          status: "completed",
          output: {
            quotes: [
              {
                status: "quoted",
                id: "US:AAPL",
                market: "US",
                symbol: "AAPL",
                provider_symbol: "AAPL",
                provider: "yahoo",
                price: 250,
                currency: "USD",
                as_of: "2026-08-12T08:58:00.000Z",
                stale: false,
                tier: "delayed",
              },
            ],
          },
        }),
      },
      knowledge: {
        save: async () => ({ id: 501, created: true, metadata: {} }),
      },
      notifications: {
        send: async () => ({ notified_count: 1, event_id: 502, url: null }),
      },
      log: () => undefined,
    } as unknown as ReactionClient;

    await runNetWorthSnapshot(ctx, client);
  });

  test("a closed holding reaching normalization is rejected", () => {
    // Why the SQL exclusion above is load-bearing rather than cosmetic.
    expect(() =>
      buildMidasSnapshot(
        balance,
        [holding("NOVA", 0, { shares: 0, price: 0, value: 0 })],
        [],
        ctx.window.window_end
      )
    ).toThrow(/invalid shares/);
  });

  test("notifies from the persisted snapshot after an idempotent save replay", async () => {
    const persistedSnapshot = buildMidasSnapshot(
      balance,
      [holding("AAPL", 200)],
      [],
      ctx.window.window_end
    );
    const notified: Array<{ body?: string }> = [];
    const client = {
      query: async (sql: string) =>
        sql.includes("midas-balance") ? [balance] : [holding("AAPL", 200)],
      connections: {
        list: async () => ({
          connections: [
            {
              id: 77,
              slug: "market-quotes",
              connector_key: "market.quotes",
              status: "active",
            },
          ],
        }),
      },
      operations: {
        execute: async () => ({
          status: "completed",
          output: {
            quotes: [
              {
                status: "quoted",
                id: "US:AAPL",
                market: "US",
                symbol: "AAPL",
                provider_symbol: "AAPL",
                provider: "yahoo",
                price: 250,
                currency: "USD",
                as_of: "2026-08-12T08:58:00.000Z",
                stale: false,
                tier: "delayed",
              },
            ],
          },
        }),
      },
      knowledge: {
        save: async () => ({
          id: 501,
          created: false,
          metadata: persistedSnapshot as unknown as Record<string, unknown>,
        }),
      },
      notifications: {
        send: async (input: { body?: string }) => {
          notified.push(input);
          return { notified_count: 1, event_id: 502, url: null };
        },
      },
      log: () => undefined,
    } as unknown as ReactionClient;

    await runNetWorthSnapshot(ctx, client);

    expect(notified[0]?.body).toContain("USD 200.00 current");
    expect(notified[0]?.body).not.toContain("USD 500.00 current");
  });

  test("includes every holding when a Midas cohort contains more than 200 positions", async () => {
    const cohort = Array.from({ length: 1_001 }, (_, index) =>
      holding(`STOCK${index}`, 4)
    );
    const saved: Array<{ metadata?: { positions?: unknown[] } }> = [];
    const client = {
      query: async (sql: string) => {
        if (sql.includes("midas-balance")) return [balance];
        const limit = Number(sql.match(/LIMIT (\d+)/)?.[1] ?? cohort.length);
        const offset = Number(sql.match(/OFFSET (\d+)/)?.[1] ?? 0);
        return cohort.slice(offset, offset + limit);
      },
      connections: {
        list: async () => ({
          connections: [
            {
              id: 77,
              slug: "market-quotes",
              connector_key: "market.quotes",
              status: "active",
            },
          ],
        }),
      },
      operations: {
        execute: async (input: {
          input: { symbols: Array<{ market: string; symbol: string }> };
        }) => ({
          status: "completed",
          output: {
            quotes: input.input.symbols.map(({ market, symbol }) => ({
              status: "quoted",
              id: `${market}:${symbol}`,
              market,
              symbol,
              provider_symbol: symbol,
              provider: "yahoo",
              price: 2,
              currency: "USD",
              as_of: "2026-08-12T08:58:00.000Z",
              stale: false,
              tier: "delayed",
            })),
          },
        }),
      },
      knowledge: {
        save: async (input: { metadata?: { positions?: unknown[] } }) => {
          saved.push(input);
          return { id: 501, created: true, metadata: {} };
        },
      },
      notifications: {
        send: async () => ({ notified_count: 1, event_id: 502, url: null }),
      },
      log: () => undefined,
    } as unknown as ReactionClient;

    await runNetWorthSnapshot(ctx, client);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.metadata?.positions).toHaveLength(cohort.length);
  });

  test("fails closed when the configured quote connection is absent", async () => {
    const client = {
      query: async (sql: string) =>
        sql.includes("midas-balance") ? [balance] : [holding("AAPL", 200)],
      connections: { list: async () => ({ connections: [] }) },
      log: () => undefined,
    } as unknown as ReactionClient;

    await expect(runNetWorthSnapshot(ctx, client)).rejects.toThrow(
      /active market-quotes connection/i
    );
  });
});
