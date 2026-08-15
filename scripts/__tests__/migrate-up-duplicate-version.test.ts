import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const MIGRATE_UP = join(REPO_ROOT, "scripts/migrate-up.mjs");

describe("migrate-up migration ledger versions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrate-up-versions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects duplicate versions before connecting to Postgres", () => {
    writeFileSync(
      join(dir, "20260803140000_automation_outputs.sql"),
      "-- migrate:up\nSELECT 1;"
    );
    writeFileSync(
      join(dir, "20260803140000_mcp_client_id.sql"),
      "-- migrate:up\nSELECT 1;"
    );

    const result = Bun.spawnSync(["node", MIGRATE_UP], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/unreachable",
        MIGRATIONS_DIR: dir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(
      /duplicate migration version 20260803140000/i
    );
  });
});
