#!/usr/bin/env node
// Guard: the per-user connection-visibility READ-SEAM gate must live in exactly
// one place — the compiler at packages/server/src/authz/connection-visibility.ts.
//
// The authorization guarantee (M0/M1) is that connection-sourced data never
// reaches a user beyond what that user can see in the source system. Every read
// seam that exposes connection-sourced rows (the SQL buildScopedQuery, recall's
// search/list paths, get_content) must scope them through the ONE compiler
// (`compileConnectionFkVisibility`), not re-derive the predicate inline. A
// re-derived copy is how the gate silently drifts: a finding leaks because one
// copy was never updated.
//
// The precise, low-false-positive signal for a re-derivation is the FK subquery
// SHAPE itself:
//
//   ... <table>.connection_id [IS NULL OR ...] IN ( SELECT ... FROM connections
//        ... WHERE ... visibility ... )
//
// i.e. a table is filtered to "connections this principal may see" via a
// `connection_id IN (SELECT ... FROM connections ... visibility ...)` subquery.
// That shape is the read-seam gate. It is DISTINCT from legitimate connection
// MANAGEMENT code (manage_connections CRUD, rest-api listing, connector
// pushdown), which filters the `connections` row directly (`c.visibility = 'org'
// OR c.created_by = ...`) and never builds the FK subquery — so those are not
// flagged.
//
// HONEST GAP: a re-derivation that avoids this exact subquery shape (e.g. a JOIN
// instead of `IN (SELECT ...)`, or building the connection-id set in JS) is NOT
// caught here. The durable backstops for those are the per-seam deny-tests
// (merge blocker) and reviewer attention. Escape hatch: put
// `connection-visibility-ok` in a comment on or just above a genuinely-safe
// occurrence.
//
// No DB, no build — pure static text analysis.
// Run: `node scripts/check-connection-visibility-compiler.mjs`

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SRC = join(REPO_ROOT, "packages/server/src");

// The one place the FK read-seam gate is allowed to live.
const COMPILER_FILE = join(SERVER_SRC, "authz/connection-visibility.ts");

// The FK read-seam-gate subquery shape (case-insensitive, across newlines):
// a table's connection_id constrained by a SELECT over the connections table
// that filters on `visibility`. The bounded `[^;]{0,N}` windows keep it to a
// single statement and avoid matching across unrelated SQL.
const FK_GATE =
  /connection_id\b[^;]{0,80}\bIN\b[^;]{0,200}?\bconnections\b[^;]{0,240}?visibility/is;

const ESCAPE_HATCH = "connection-visibility-ok";

/** Recursively collect *.ts files under dir, excluding tests. */
function collectTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...collectTsFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const file of collectTsFiles(SERVER_SRC)) {
  if (file === COMPILER_FILE) continue;
  const src = readFileSync(file, "utf8");
  const m = FK_GATE.exec(src);
  if (!m) continue;
  // Allow an explicit escape hatch in a comment near the match.
  const lineNo = src.slice(0, m.index).split("\n").length;
  const lines = src.split("\n");
  const nearby = [lines[lineNo - 2], lines[lineNo - 1], lines[lineNo]].join(
    "\n"
  );
  if (nearby.includes(ESCAPE_HATCH)) continue;
  violations.push({ file: relative(REPO_ROOT, file), lineNo });
}

if (violations.length > 0) {
  console.error(
    "\n✖ connection-visibility read-seam gate re-derived outside the compiler:\n"
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.lineNo}`);
  }
  console.error(
    "\nThe FK read-seam gate (connection_id IN (SELECT ... FROM connections ... visibility ...))\n" +
      "must come from compileConnectionFkVisibility() in\n" +
      "  packages/server/src/authz/connection-visibility.ts\n" +
      "so the per-user visibility rule lives in one place. Route this read through\n" +
      "the compiler (or buildConnectionVisibilityClause, which adapts to it). If this\n" +
      `is genuinely safe, add a "${ESCAPE_HATCH}" comment on the line.\n`
  );
  process.exit(1);
}

console.log(
  "✓ connection-visibility read-seam gate is compiler-only (no re-derivations)"
);
