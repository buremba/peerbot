/**
 * Shared environment defaults for the example scripts. Bun auto-loads `.env`
 * from the working directory; these fall back to the values in `env.example`
 * so the scripts also work without one.
 */

export const GATEWAY_URL = (
  process.env.LOBU_URL ?? "http://127.0.0.1:8787"
).replace(/\/$/, "");

export const WAREHOUSE_URL =
  process.env.KELDER_WAREHOUSE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:6543/kelder_warehouse?sslmode=disable";

/** The warehouse connection's slug — declared in lobu.config.ts and created by
 *  `lobu run`. `query_sql`/`compose.ts` push governed SQL down through it. */
export const WAREHOUSE_CONNECTION_SLUG = "kelder-warehouse";

/** The one governed rollup — the virtual feed's live query AND the pinned
 *  verified query are this exact SQL. */
export const CHURN_ROLLUP_SQL = `SELECT to_char(date_trunc('month', cancelled_at), 'YYYY-MM') AS month,
       count(*)::int AS cancellations
  FROM subscriptions
 WHERE cancelled_at IS NOT NULL
 GROUP BY 1
 ORDER BY 1`;

/** Admin URL for the warehouse server (same server, `postgres` database) —
 *  used only to CREATE DATABASE kelder_warehouse. */
export function warehouseAdminUrl(): string {
  const url = new URL(WAREHOUSE_URL);
  url.pathname = "/postgres";
  return url.toString();
}

export function warehouseDbName(): string {
  return (
    new URL(WAREHOUSE_URL).pathname.replace(/^\//, "") || "kelder_warehouse"
  );
}
