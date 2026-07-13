/**
 * Provision the fake Kelder Coffee warehouse: a `kelder_warehouse` database
 * with one `subscriptions` table (~2000 rows). Deterministic — reseeding
 * always produces the same data.
 *
 * The shape of the story (what the context layer will explain):
 *  - 30 organic cancellations per month, 2025-07 .. 2026-06
 *  - +20 payment-failure cancellations per month — a customer's card fails and
 *    the subscription is auto-cancelled. Each carries a `dunning_started_at`
 *    (when Recharge began retrying the card). ~12/month are cancelled INSIDE the
 *    28-day dunning grace (the retry window — churn v2 says these should not
 *    count, they usually self-recover); ~8/month fall OUTSIDE it (real churn,
 *    v2 keeps them). This cohort is why churn v2 yields a DIFFERENT number than
 *    v1 over the same warehouse — see churn_rate v2 in seed.ts.
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

/** The 28-day dunning grace window churn v2 excludes payment-failures within.
 *  Kept here as the ground truth the warehouse rows are built against; the
 *  governing predicate in seed.ts references the same 28 days. */
const DUNNING_GRACE_DAYS = 28;

interface SubscriptionRow {
  id: number;
  customer_id: number;
  plan: string;
  started_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  /** For payment_failure cancellations: when the card-retry (dunning) cycle
   *  began. NULL for every other row. churn v2 keys its 28-day grace off this. */
  dunning_started_at: string | null;
}

/** One scheduled cancellation. `dunningStartedAt` is set only for
 *  payment_failure rows (the anchor churn v2's grace is measured from). */
interface ScheduledCancellation {
  date: Date;
  reason: string;
  dunningStartedAt: Date | null;
}

function iso(d: Date): string {
  return d.toISOString();
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 86_400_000);
}

/** Build the deterministic cancellation schedule. */
function cancellationSchedule(): ScheduledCancellation[] {
  const out: ScheduledCancellation[] = [];
  const organic = (date: Date, reason: string): ScheduledCancellation => ({
    date,
    reason,
    dunningStartedAt: null,
  });

  // 30 organic cancellations per month, 2025-07 .. 2026-06.
  const months: Array<[number, number]> = [];
  for (let m = 6; m < 12; m++) months.push([2025, m]); // Jul..Dec 2025
  for (let m = 0; m < 6; m++) months.push([2026, m]); // Jan..Jun 2026
  for (const [year, month] of months) {
    for (let i = 0; i < 30; i++) {
      const day = 1 + ((i * 7 + month) % 27);
      out.push(
        organic(
          new Date(Date.UTC(year, month, day, 9 + (i % 12))),
          "customer_request"
        )
      );
    }
  }

  // 20 payment-failure cancellations per month, every month in the window.
  // For each, a `dunning_started_at` anchors churn v2's 28-day grace: the first
  // 12 are cancelled INSIDE the grace (7 days after dunning began — the card
  // never recovered but v2 treats an in-grace cancel as noise, not churn); the
  // last 8 are cancelled OUTSIDE it (35 days after — real churn v2 still counts).
  // So under v2 each plain month loses 12 of its 20 payment-failures.
  for (const [year, month] of months) {
    for (let i = 0; i < 20; i++) {
      const day = 2 + ((i * 5 + month) % 26);
      const cancelledAt = new Date(Date.UTC(year, month, day, 8 + (i % 10)));
      const inGrace = i < 12;
      const graceOffsetDays = inGrace ? 7 : DUNNING_GRACE_DAYS + 7; // 7 or 35
      out.push({
        date: cancelledAt,
        reason: "payment_failure",
        dunningStartedAt: daysBefore(cancelledAt, graceOffsetDays),
      });
    }
  }

  // 2026-03: the billing migration writes ~500 false cancellations on 12/13.
  for (let i = 0; i < 500; i++) {
    const day = i < 250 ? 12 : 13;
    out.push(
      organic(
        new Date(Date.UTC(2026, 2, day, i % 24, (i * 13) % 60)),
        "billing_migration_artifact"
      )
    );
  }
  // 2026-05: courier strike, 45 extra genuine cancellations on 19..21.
  for (let i = 0; i < 45; i++) {
    const day = 19 + (i % 3);
    out.push(
      organic(new Date(Date.UTC(2026, 4, day, 10 + (i % 10))), "courier_strike")
    );
  }
  return out;
}

function buildRows(): SubscriptionRow[] {
  const cancellations = cancellationSchedule();
  const rows: SubscriptionRow[] = [];
  for (let i = 0; i < TOTAL_SUBSCRIPTIONS; i++) {
    const cancelled = i < cancellations.length ? cancellations[i]! : null;
    const started = cancelled
      ? daysBefore(cancelled.date, 90 + ((i * 17) % 300))
      : new Date(Date.UTC(2025, 0, 1 + ((i * 11) % 540)));
    rows.push({
      id: i + 1,
      customer_id: 10_000 + i,
      plan: PLANS[i % PLANS.length]!,
      started_at: iso(started),
      cancelled_at: cancelled ? iso(cancelled.date) : null,
      cancel_reason: cancelled ? cancelled.reason : null,
      dunning_started_at: cancelled?.dunningStartedAt
        ? iso(cancelled.dunningStartedAt)
        : null,
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
      id                 integer PRIMARY KEY,
      customer_id        integer NOT NULL,
      plan               text NOT NULL,
      started_at         timestamptz NOT NULL,
      cancelled_at       timestamptz,
      cancel_reason      text,
      dunning_started_at timestamptz
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

    // Show raw (churn v1) next to what churn v2 keeps (payment-failures inside
    // the 28-day dunning grace dropped), so the warehouse itself demonstrates
    // that the definition change moves the number — not just labels it.
    const monthly = await sql`
      SELECT to_char(date_trunc('month', cancelled_at), 'YYYY-MM') AS month,
             count(*)::int AS raw_v1,
             count(*) FILTER (
               WHERE NOT (
                 cancel_reason = 'payment_failure'
                 AND dunning_started_at IS NOT NULL
                 AND cancelled_at <= dunning_started_at + interval '${sql.unsafe(String(DUNNING_GRACE_DAYS))} days'
               )
             )::int AS v2_governed
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
