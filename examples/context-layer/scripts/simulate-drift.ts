/**
 * Demo helper: nudge the warehouse so the drift canary has something to catch.
 *
 * Inserts ONE new cancellation into the fake Kelder warehouse. The pinned
 * verified-query answer was captured before this row existed, so the next
 * `bun run drift` will report a one-cancellation drift for the affected month —
 * exactly the "the warehouse moved under a pinned answer" case the trust loop
 * is built to surface.
 *
 * Idempotent-ish: each run adds one more cancellation in the current demo
 * month, so drift grows by one each time. Re-run `seed:warehouse` to reset.
 *
 * Prereq: `bun run seed:warehouse` has provisioned the warehouse.
 */

import postgres from "postgres";
import { WAREHOUSE_URL } from "./lib/env.ts";

const sql = postgres(WAREHOUSE_URL, { max: 1 });
try {
  // Pick a stable demo month at the end of the seeded window so the drift shows
  // up on a clean (unflagged) month rather than a distorted one.
  const cancelledAt = "2026-06-15T12:00:00Z";

  const [{ next_id }] = (await sql`
    SELECT coalesce(max(id), 0) + 1 AS next_id FROM subscriptions
  `) as unknown as Array<{ next_id: number }>;

  await sql`
    INSERT INTO subscriptions (id, customer_id, plan, started_at, cancelled_at, cancel_reason)
    VALUES (
      ${next_id},
      ${900000 + next_id},
      'regular',
      '2026-01-01T00:00:00Z',
      ${cancelledAt},
      'customer_request'
    )
  `;

  const [{ june }] = (await sql`
    SELECT count(*)::int AS june
      FROM subscriptions
     WHERE to_char(date_trunc('month', cancelled_at), 'YYYY-MM') = '2026-06'
  `) as unknown as Array<{ june: number }>;

  console.log(
    `Inserted 1 new cancellation (id ${next_id}) into 2026-06. ` +
      `Warehouse now reports ${june} cancellations for that month.`
  );
  console.log("Run `bun run drift` — the canary should now report drift.");
} finally {
  await sql.end();
}
