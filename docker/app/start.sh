#!/bin/bash
set -e

MODE="${1:-server}"

echo "Starting Lobu backend (Node)"
echo "================================"

echo "Environment:"
echo "  DATABASE_URL: ${DATABASE_URL:+***set***}"
echo "  GITHUB_TOKEN: ${GITHUB_TOKEN:+***set***}"
echo "  JWT_SECRET: ${JWT_SECRET:+***set***}"

preflight_database() {
  echo "Checking database connectivity..."
  node --input-type=module <<'NODE'
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const timeoutSeconds = Number(process.env.DB_PREFLIGHT_TIMEOUT_SECONDS || 10);

if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  max: 1,
  connect_timeout: timeoutSeconds,
  idle_timeout: 1,
  onnotice: () => {},
});

try {
  const rows = await sql`select current_database() as database`;
  console.log(`Database preflight passed (${rows[0]?.database ?? "unknown"})`);
} catch (error) {
  console.error("ERROR: database preflight failed");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Refusing to run migrations against an unreachable or missing production database.");
  process.exit(1);
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
NODE
}

# Fail FAST, before dbmate touches anything, when a PENDING migration will
# `ALTER COLUMN ... SET NOT NULL` on a column that still has NULL rows. That is
# the signature of a contract migration whose out-of-band backfill precondition
# was skipped (incident 2026-06-24: a classifier-collapse contract migration hit
# this, dbmate errored mid-run, the Helm pre-upgrade hook failed, and the
# HelmRelease wedged + rolled back for hours, spamming #devops). dbmate's own
# error ("column X contains null values") is buried after partial work; this
# surfaces the exact table.column + NULL count + remediation up front.
#
# Fail OPEN by design: any parse/connect/unknown error logs a warning and
# continues so the preflight can never itself become a new deploy wedge. It only
# HARD-fails when it positively finds NULLs in an existing targeted column.
preflight_not_null_preconditions() {
  echo "Checking pending migrations for unsatisfied NOT NULL preconditions..."
  MIGRATIONS_DIR=/app/db/migrations node --input-type=module <<'NODE'
import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const databaseUrl = process.env.DATABASE_URL;
const dir = process.env.MIGRATIONS_DIR || "/app/db/migrations";
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 1, onnotice: () => {} });

try {
  let applied;
  try {
    const rows = await sql`SELECT version FROM schema_migrations`;
    applied = new Set(rows.map((r) => r.version));
  } catch {
    // Fresh DB with no schema_migrations yet → nothing applied and no rows that
    // could violate a NOT NULL. Nothing to check.
    console.log("schema_migrations not present — skipping NOT NULL preflight");
    process.exit(0);
  }

  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  } catch (e) {
    console.warn(`preflight: cannot read ${dir} (${e.message}) — skipping`);
    process.exit(0);
  }

  const violations = [];
  for (const file of files) {
    const version = file.split("_")[0];
    if (applied.has(version)) continue; // already applied

    let text;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    // Only consider the up section, statement by statement. A statement that
    // both names a table and SETs a column NOT NULL targets an existing column.
    const up = text.split(/--\s*migrate:down/i)[0];
    for (const stmt of up.split(";")) {
      if (!/alter\s+column/i.test(stmt) || !/set\s+not\s+null/i.test(stmt)) continue;
      const tableM = stmt.match(/alter\s+table\s+(?:only\s+)?(?:public\.)?"?(\w+)"?/i);
      const colM = stmt.match(/alter\s+column\s+"?(\w+)"?\s+set\s+not\s+null/i);
      if (!tableM || !colM) continue;
      const table = tableM[1];
      const col = colM[1];
      try {
        // table/col are \w+ extracted from our own migration files — not user input.
        const rows = await sql.unsafe(
          `SELECT count(*)::bigint AS n FROM public.${table} WHERE ${col} IS NULL`
        );
        const n = Number(rows[0]?.n ?? 0);
        if (n > 0) violations.push({ file, table, col, n });
      } catch (e) {
        // Column/table may be created by an earlier still-pending migration, so
        // it can't be pre-verified — let dbmate handle it. Fail open.
        console.warn(`preflight: cannot check ${table}.${col} (${file}): ${e.message}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error("");
    console.error("ERROR: refusing to run migrations — a pending NOT NULL constraint has unbacked NULLs:");
    for (const v of violations) {
      console.error(`  - ${v.file}: ${v.table}.${v.col} SET NOT NULL, but ${v.n} row(s) are NULL`);
    }
    console.error("");
    console.error("This is a contract migration whose out-of-band backfill must run to completion FIRST");
    console.error("(see the migration header / scripts/). Run the backfill, confirm 0 NULLs, then redeploy.");
    console.error("Aborting before dbmate so the deploy fails fast with a clear cause, not mid-migration.");
    process.exit(1);
  }
  console.log("NOT NULL preflight passed");
} catch (error) {
  // Never let an unexpected preflight error block a deploy.
  console.warn(`preflight: unexpected error, continuing (${error instanceof Error ? error.message : String(error)})`);
  process.exit(0);
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
NODE
}

run_migrations() {
  if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL not set"
    exit 1
  fi

  if [ "${NODE_ENV:-}" = "production" ] && [ "${ALLOW_DB_CREATE:-0}" != "1" ]; then
    preflight_database
  fi

  preflight_not_null_preconditions

  echo ""
  echo "Running database migrations..."
  dbmate --url "$DATABASE_URL" --migrations-dir /app/db/migrations --no-dump-schema up
  echo "Migrations complete"
}

if [ "$MODE" = "migrate" ]; then
  run_migrations
  exit 0
fi

echo ""
echo "Starting backend on port 8787..."

# When the Helm chart's pre-upgrade migration Job is enabled, it has
# already applied migrations before this Deployment is rolled. Set
# SKIP_MIGRATIONS=1 in that environment so the per-pod start doesn't
# block on a migration that may take longer than livenessProbe allows.
if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "SKIP_MIGRATIONS=1 — assuming the pre-upgrade Job applied migrations."
else
  run_migrations
fi

# Run under Node so V8 native addons (isolated-vm) load. Bun uses
# JavaScriptCore and cannot link the V8 ABI surface that isolated-vm needs;
# the execute MCP tool silently degrades to RuntimeUnavailable under bun.
#
# We run a pre-bundled artifact (built by scripts/build-server-bundle.mjs
# in the builder stage) instead of TS source via tsx. Bundling at build
# time inlines workspace packages (@lobu/core et al.) so Node never has to
# bind named imports against their CJS dist barrels — that's what crashed
# #430. External npm deps are resolved by Node from node_modules, which
# is hoisted (see Dockerfile `bun install --linker=hoisted`) so the flat
# layout matches what Node expects.
exec node /app/packages/server/dist/server.bundle.mjs
