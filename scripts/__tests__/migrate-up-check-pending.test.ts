import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const MIGRATE_UP = join(REPO_ROOT, "scripts/migrate-up.mjs");

/** One of the two statuses (3 = nothing pending, 4 = all backward-compatible)
 * that let charts/lobu/files/migrate-upgrade.sh skip its quiesce. The tests
 * below pin the fail-closed paths against this one; the sibling
 * migration-compatibility.test.ts covers the 4 path. */
const NOTHING_PENDING = 3;

function runCheckPending(env: Record<string, string>) {
  return Bun.spawnSync(["node", MIGRATE_UP, "--check-pending"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("migrate-up --check-pending", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrate-up-check-pending-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when the ledger cannot be read", () => {
    writeFileSync(
      join(dir, "20260803140000_automation_outputs.sql"),
      "-- migrate:up\nSELECT 1;"
    );

    const result = runCheckPending({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/unreachable",
      MIGRATIONS_DIR: dir,
    });

    // An unreachable database must never read as "nothing pending" -- those
    // are the statuses that let the pre-upgrade hook skip its quiesce.
    expect(result.exitCode).not.toBe(NOTHING_PENDING);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toMatch(
      /could not determine pending migrations/i
    );
  });

  it("fails closed when DATABASE_URL is missing", () => {
    const result = runCheckPending({
      DATABASE_URL: "",
      MIGRATIONS_DIR: dir,
    });

    expect(result.exitCode).not.toBe(NOTHING_PENDING);
    expect(result.exitCode).toBe(1);
  });

  it("fails closed on a duplicate migration version", () => {
    writeFileSync(
      join(dir, "20260803140000_automation_outputs.sql"),
      "-- migrate:up\nSELECT 1;"
    );
    writeFileSync(
      join(dir, "20260803140000_mcp_client_id.sql"),
      "-- migrate:up\nSELECT 1;"
    );

    const result = runCheckPending({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/unreachable",
      MIGRATIONS_DIR: dir,
    });

    expect(result.exitCode).not.toBe(NOTHING_PENDING);
  });
});
