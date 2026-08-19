import { describe, expect, it } from "bun:test";
import {
  classifyMigrationSource,
  findIncompatibleDdl,
} from "../lib/migration-compatibility.mjs";

const MARKER = "-- lobu:no-quiesce";

/** The migrate:up statements of the migration that caused the 2026-08-19 window. */
const ADDITIVE_STATEMENTS = [
  "ALTER TABLE public.device_workers\n  ADD COLUMN IF NOT EXISTS agent_kinds text[];",
  "COMMENT ON COLUMN public.device_workers.agent_kinds IS\n  'Agent CLI kinds this device can spawn.';",
];

describe("classifyMigrationSource", () => {
  it("clears an additive migration that carries the marker", () => {
    const verdict = classifyMigrationSource(
      "20260819120000_device_agent_kinds.sql",
      `-- migrate:up\n${MARKER}\n${ADDITIVE_STATEMENTS.join("\n")}`,
      ADDITIVE_STATEMENTS
    );

    expect(verdict.compatible).toBe(true);
  });

  it("blocks the same migration when the marker is absent", () => {
    // The marker is the whole assertion -- without it, additive DDL is still
    // no evidence the old code survives, so the quiesce must stand.
    const verdict = classifyMigrationSource(
      "20260819120000_device_agent_kinds.sql",
      `-- migrate:up\n${ADDITIVE_STATEMENTS.join("\n")}`,
      ADDITIVE_STATEMENTS
    );

    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toMatch(/not marked/);
  });

  it("blocks a marked migration whose DDL contradicts the marker", () => {
    const statements = [
      "ALTER TABLE public.device_workers DROP COLUMN legacy;",
    ];
    const verdict = classifyMigrationSource(
      "20260820000000_drop_legacy.sql",
      `-- migrate:up\n${MARKER}\n${statements[0]}`,
      statements
    );

    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toMatch(/drops an object/);
  });

  it("blocks when only one statement of several is incompatible", () => {
    const statements = [
      "ALTER TABLE a ADD COLUMN IF NOT EXISTS x text;",
      "ALTER TABLE b ALTER COLUMN y SET NOT NULL;",
    ];
    const verdict = classifyMigrationSource(
      "20260820000000_mixed.sql",
      `-- migrate:up\n${MARKER}`,
      statements
    );

    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toMatch(/NOT NULL/);
  });

  it("does not accept a marker that is not its own comment line", () => {
    // Otherwise prose describing the marker would silently arm the fast path.
    const verdict = classifyMigrationSource(
      "20260820000000_prose.sql",
      `-- migrate:up\n-- see the ${MARKER} convention for details\nSELECT 1;`,
      ["SELECT 1;"]
    );

    expect(verdict.compatible).toBe(false);
  });
});

describe("findIncompatibleDdl", () => {
  it("ignores DDL keywords that appear only inside comments", () => {
    expect(
      findIncompatibleDdl(
        "-- this replaces the old DROP COLUMN approach\nALTER TABLE a ADD COLUMN IF NOT EXISTS x text;"
      )
    ).toBeNull();
    expect(
      findIncompatibleDdl(
        "/* previously a RENAME TO */ ALTER TABLE a ADD COLUMN IF NOT EXISTS x text;"
      )
    ).toBeNull();
  });

  it("clears additive shapes that the old code cannot notice", () => {
    expect(
      findIncompatibleDdl("ALTER TABLE a ADD COLUMN IF NOT EXISTS x text[];")
    ).toBeNull();
    expect(findIncompatibleDdl("COMMENT ON COLUMN a.x IS 'note';")).toBeNull();
    expect(
      findIncompatibleDdl("CREATE INDEX CONCURRENTLY idx ON a (x);")
    ).toBeNull();
    expect(
      findIncompatibleDdl("CREATE TABLE b (id text primary key);")
    ).toBeNull();
  });

  it("blocks a NOT NULL column with no DEFAULT but allows one with a DEFAULT", () => {
    // Without a DEFAULT every pre-migration INSERT starts failing.
    expect(
      findIncompatibleDdl("ALTER TABLE a ADD COLUMN x text NOT NULL;")
    ).toMatch(/NOT NULL column with no DEFAULT/);
    expect(
      findIncompatibleDdl(
        "ALTER TABLE a ADD COLUMN x text NOT NULL DEFAULT 'v';"
      )
    ).toBeNull();
  });

  it.each([
    ["ALTER TABLE a DROP COLUMN x;", /drops an object/],
    ["DROP TABLE a;", /drops an object/],
    ["ALTER TABLE a DROP CONSTRAINT c;", /drops an object/],
    ["ALTER TABLE a RENAME COLUMN x TO y;", /renames an object/],
    ["ALTER TABLE a ALTER COLUMN x SET NOT NULL;", /NOT NULL/],
    ["ALTER TABLE a ALTER COLUMN x TYPE bigint;", /column type/],
    ["ALTER TABLE a ADD CONSTRAINT c CHECK (x > 0);", /constraint/],
  ])("blocks %s", (statement, expected) => {
    expect(findIncompatibleDdl(statement)).toMatch(expected);
  });
});
