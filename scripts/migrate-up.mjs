#!/usr/bin/env node
/**
 * Apply db/migrations/*.sql the way dbmate `up` does, with one important fix:
 * `transaction:false` sections run statement-at-a-time so CREATE/DROP INDEX
 * CONCURRENTLY is not trapped inside Postgres's implicit multi-statement
 * transaction (required when a heal DO precedes CONCURRENTLY in the same file).
 *
 * Records versions in public.schema_migrations (dbmate-compatible).
 *
 * Usage:
 *   DATABASE_URL=... node scripts/migrate-up.mjs
 *   MIGRATIONS_DIR=/app/db/migrations node scripts/migrate-up.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const migrationsDir =
  process.env.MIGRATIONS_DIR || join(process.cwd(), "db/migrations");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

function listMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function parseTransactionOption(markerLine) {
  return !/\btransaction\s*:\s*false\b/i.test(markerLine);
}

function loadMigrationUp(dir, file) {
  const content = readFileSync(join(dir, file), "utf-8");
  const upMarker = content.match(/^--\s*migrate:up(.*)$/m);
  const transaction = parseTransactionOption(upMarker?.[0] ?? "-- migrate:up");
  const sql = content
    .split(/^--\s*migrate:down.*$/m)[0]
    .replace(/^--\s*migrate:up.*$/m, "")
    .replace(/^SET transaction_timeout = 0;\s*$/gm, "")
    .trim();
  return { sql, transaction };
}

/** Dollar-quote / string-literal aware statement splitter (see migration-loader.ts). */
function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      current += chunk;
      i += chunk.length;
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      current += chunk;
      i += chunk.length;
      continue;
    }

    if (ch === "$") {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) {
          current += sql.slice(i);
          break;
        }
        current += sql.slice(i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }

    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < n) {
        current += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === ";") {
      pushCurrent();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  pushCurrent();
  return statements;
}

async function executeSection(sqlClient, section) {
  if (!section.sql.trim()) return;
  if (section.transaction) {
    await sqlClient.unsafe(section.sql);
    return;
  }
  for (const statement of splitSqlStatements(section.sql)) {
    await sqlClient.unsafe(statement);
  }
}

async function recordMigration(sqlClient, version) {
  await sqlClient.unsafe(
    `INSERT INTO public.schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
    [version]
  );
}

async function applyMigration(sqlClient, section, version) {
  if (section.transaction) {
    await sqlClient.begin(async (tx) => {
      await executeSection(tx, section);
      await recordMigration(tx, version);
    });
    return;
  }

  // CONCURRENTLY cannot share a transaction with the ledger write. These
  // migrations must therefore remain replay-safe, as dbmate also requires for
  // transaction:false migrations interrupted before their version is recorded.
  await executeSection(sqlClient, section);
  await recordMigration(sqlClient, version);
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
let migrationLockHeld = false;

try {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version character varying(128) NOT NULL PRIMARY KEY
    )
  `);

  // start.sh runs on every replica. Serialize the ledger read + migration loop
  // on one Postgres session so two fresh pods cannot apply the same version.
  await sql.unsafe(`SELECT pg_advisory_lock(hashtext('lobu_migrate_up'))`);
  migrationLockHeld = true;

  const appliedRows = await sql.unsafe(
    `SELECT version FROM public.schema_migrations`
  );
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const file of listMigrationFiles(migrationsDir)) {
    const version = file.split("_")[0] ?? "";
    if (applied.has(version)) continue;
    const up = loadMigrationUp(migrationsDir, file);
    if (!up.sql) continue;

    console.log(`Applying: ${file}`);
    await sql.unsafe("SET search_path TO public");
    await applyMigration(sql, up, version);
    console.log(`Applied: ${file}`);
  }

  console.log("Migrations complete");
} finally {
  if (migrationLockHeld) {
    await sql
      .unsafe(`SELECT pg_advisory_unlock(hashtext('lobu_migrate_up'))`)
      .catch(() => undefined);
  }
  await sql.end({ timeout: 1 }).catch(() => undefined);
}
