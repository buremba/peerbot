/**
 * Provision the fake Kelder Coffee warehouse: a `kelder_warehouse` database
 * with one `subscriptions` table (~2000 rows). Deterministic — reseeding
 * always produces the same data.
 *
 * The shape of the story (what the context layer will explain):
 *  - 30 organic cancellations per month, 2025-07 .. 2026-06
 *  - +500 cancellations on 2026-03-12/13 — billing-migration artifacts
 *    (rows written by a bad Recharge migration, not customers leaving)
 *  - +45 cancellations on 2026-05-19..21 — a courier strike (real, temporary)
 *
 * By default the database is created inside the embedded Postgres cluster
 * `lobu run` boots for this example (LOBU_PG_PORT pins its port), so there is
 * no external prerequisite. Point KELDER_WAREHOUSE_URL at any local Postgres
 * (e.g. the dev-stack one) to use that instead. Run `lobu run` first.
 */

import postgres from "postgres";
import {
  WAREHOUSE_URL,
  warehouseAdminUrl,
  warehouseDbName,
} from "./lib/env.ts";

const PLANS = ["starter", "regular", "fanatic"] as const;
const TOTAL_SUBSCRIPTIONS = 2000;

interface SubscriptionRow {
  id: number;
  customer_id: number;
  plan: string;
  started_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

function iso(d: Date): string {
  return d.toISOString();
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 86_400_000);
}

/** Build the deterministic cancellation schedule: [date, reason][] */
function cancellationSchedule(): Array<[Date, string]> {
  const out: Array<[Date, string]> = [];
  // 30 organic cancellations per month, 2025-07 .. 2026-06.
  const months: Array<[number, number]> = [];
  for (let m = 6; m < 12; m++) months.push([2025, m]); // Jul..Dec 2025
  for (let m = 0; m < 6; m++) months.push([2026, m]); // Jan..Jun 2026
  for (const [year, month] of months) {
    for (let i = 0; i < 30; i++) {
      const day = 1 + ((i * 7 + month) % 27);
      out.push([
        new Date(Date.UTC(year, month, day, 9 + (i % 12))),
        "customer_request",
      ]);
    }
  }
  // 2026-03: the billing migration writes ~500 false cancellations on 12/13.
  for (let i = 0; i < 500; i++) {
    const day = i < 250 ? 12 : 13;
    out.push([
      new Date(Date.UTC(2026, 2, day, i % 24, (i * 13) % 60)),
      "billing_migration_artifact",
    ]);
  }
  // 2026-05: courier strike, 45 extra genuine cancellations on 19..21.
  for (let i = 0; i < 45; i++) {
    const day = 19 + (i % 3);
    out.push([
      new Date(Date.UTC(2026, 4, day, 10 + (i % 10))),
      "courier_strike",
    ]);
  }
  return out;
}

function buildRows(): SubscriptionRow[] {
  const cancellations = cancellationSchedule();
  const rows: SubscriptionRow[] = [];
  for (let i = 0; i < TOTAL_SUBSCRIPTIONS; i++) {
    const cancelled = i < cancellations.length ? cancellations[i]! : null;
    const started = cancelled
      ? daysBefore(cancelled[0], 90 + ((i * 17) % 300))
      : new Date(Date.UTC(2025, 0, 1 + ((i * 11) % 540)));
    rows.push({
      id: i + 1,
      customer_id: 10_000 + i,
      plan: PLANS[i % PLANS.length]!,
      started_at: iso(started),
      cancelled_at: cancelled ? iso(cancelled[0]) : null,
      cancel_reason: cancelled ? cancelled[1] : null,
    });
  }
  return rows;
}

async function ensureDatabase(): Promise<void> {
  const admin = postgres(warehouseAdminUrl(), { max: 1 });
  const dbName = warehouseDbName();
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
    throw new Error(`Unsafe warehouse database name: ${dbName}`);
  }
  try {
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    console.log(`Created database ${dbName}`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "42P04") throw err; // 42P04 = already exists
    console.log(`Database ${dbName} already exists`);
  } finally {
    await admin.end();
  }
}

async function main() {
  await ensureDatabase();

  const sql = postgres(WAREHOUSE_URL, { max: 1 });
  try {
    await sql`DROP TABLE IF EXISTS subscriptions`;
    await sql`CREATE TABLE subscriptions (
      id            integer PRIMARY KEY,
      customer_id   integer NOT NULL,
      plan          text NOT NULL,
      started_at    timestamptz NOT NULL,
      cancelled_at  timestamptz,
      cancel_reason text
    )`;

    const rows = buildRows();
    for (let i = 0; i < rows.length; i += 500) {
      await sql`INSERT INTO subscriptions ${sql(rows.slice(i, i + 500))}`;
    }

    const [{ total, cancelled }] = (await sql`
      SELECT count(*)::int AS total, count(cancelled_at)::int AS cancelled
        FROM subscriptions
    `) as unknown as Array<{ total: number; cancelled: number }>;
    console.log(`Seeded ${total} subscriptions (${cancelled} cancelled)`);

    const monthly = await sql`
      SELECT to_char(date_trunc('month', cancelled_at), 'YYYY-MM') AS month,
             count(*)::int AS cancellations
        FROM subscriptions
       WHERE cancelled_at IS NOT NULL
       GROUP BY 1 ORDER BY 1
    `;
    console.table(monthly.map((r) => ({ ...r })));
  } finally {
    await sql.end();
  }
}

await main();
