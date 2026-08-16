/**
 * The entity-write funnel guard is only useful if it rejects both obvious SQL
 * and dynamically selected table names. These probes run in the real scanned
 * tree so the test exercises the same baseline allowlist as CI.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/check-entity-write-funnel.mjs");
const PROBE = join(
  REPO_ROOT,
  "packages/server/src/utils/entity-write-funnel-probe.ts"
);
const STALE_GUARD_PROBE = join(
  REPO_ROOT,
  "scripts/check-entity-write-funnel-stale-probe.mjs"
);
const OUTSIDE_SERVER_PROBE = join(
  REPO_ROOT,
  "packages/core/src/entity-write-funnel-probe.ts"
);

function runGuard() {
  return Bun.spawnSync(["bun", GUARD], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  rmSync(PROBE, { force: true });
  rmSync(STALE_GUARD_PROBE, { force: true });
  rmSync(OUTSIDE_SERVER_PROBE, { force: true });
});

describe("check-entity-write-funnel", () => {
  it("passes on the pinned production baseline", () => {
    const result = runGuard();
    expect(result.exitCode).toBe(0);
  });

  it("rejects a new direct entity write", () => {
    // The statement deliberately starts on a later line than the literal's
    // opening backtick, so the reported line has to come from the match offset
    // rather than from the enclosing node's position.
    writeFileSync(
      PROBE,
      `export async function probe(sql: any) {
  await sql\`
    SELECT 1;
    UPDATE entities SET name = \${"new"} WHERE id = \${1}\`;
}
`
    );

    const result = runGuard();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "entity-write-funnel-probe.ts:4"
    );
  });

  it("rejects formatter-split inserts and hard deletes", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any) {
  await sql\`
    INSERT INTO entities (name)
    VALUES (\${"new"})
  \`;
  await sql\`
    DELETE FROM entities
    WHERE id = \${1}
  \`;
}
`
    );

    const result = runGuard();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("direct entity insert");
    expect(result.stderr.toString()).toContain("direct entity delete");
  });

  it("rejects direct and dynamic insert aliases", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any, table: string) {
  await sql\`INSERT INTO entities AS "entity row" (name) VALUES (\${"new"})\`;
  await sql\`UPDATE entities AS "entity row" SET name = \${"new"}\`;
  await sql.unsafe(\`INSERT INTO public.\${table} AS entity_row (name) VALUES ($1)\`, ["new"]);
}
`
    );

    const result = runGuard();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("direct entity insert");
    expect(stderr).toContain("direct entity update");
    expect(stderr).toContain("dynamic mutation target");
  });

  it("rejects postgres.js row-helper inserts", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any, table: string, row: object) {
  await sql\`INSERT INTO entities \${sql(row)}\`;
  await sql\`INSERT INTO \${table} \${sql(row)}\`;
}
`
    );

    const result = runGuard();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("direct entity insert");
    expect(stderr).toContain("dynamic mutation target");
  });

  it("rejects bare deletes and every table-level mutation form", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any) {
  await sql.unsafe("DELETE FROM ONLY entities");
  await sql.unsafe("UPDATE ONLY entities SET name = 'new'");
  await sql.unsafe("TRUNCATE TABLE entities");
  await sql.unsafe("MERGE INTO ONLY entities AS target USING incoming AS source ON false");
  await sql.unsafe("COPY entities FROM STDIN");
}
`
    );

    const result = runGuard();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("direct entity delete");
    expect(stderr).toContain("direct entity update");
    expect(stderr).toContain("direct entity truncate");
    expect(stderr).toContain("direct entity merge");
    expect(stderr).toContain("direct entity copy");
  });

  it("rejects non-public schema qualification", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any) {
  await sql.unsafe("UPDATE app.entities SET name = 'new'");
}
`
    );

    const result = runGuard();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("direct entity update");
  });

  it("rejects entities later in direct and dynamic TRUNCATE lists", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any, schema: string) {
  await sql.unsafe("TRUNCATE other_table, ONLY app.entities");
  await sql.unsafe(\`TRUNCATE other_table, \${schema}.entities\`);
}
`
    );

    const result = runGuard();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("direct entity truncate");
    expect(stderr).toContain("dynamic mutation target");
  });

  it("rejects an entity writer in another runtime package", () => {
    writeFileSync(
      OUTSIDE_SERVER_PROBE,
      `export async function probe(sql: any) {
  await sql\`DELETE FROM entities\`;
}
`
    );

    const result = runGuard();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "packages/core/src/entity-write-funnel-probe.ts:2"
    );
  });

  it("allows COPY TO entity exports", () => {
    writeFileSync(
      PROBE,
      `export async function exportEntities(sql: any) {
  await sql.unsafe("COPY entities (id, name) TO STDOUT");
}
`
    );

    const result = runGuard();
    expect(result.exitCode).toBe(0);
  });

  it("rejects a dynamically selected mutation target", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any, schema: string, table: string) {
  await sql.unsafe(\`UPDATE \${schema}.entities SET name = $1\`, ["new"]);
  await sql.unsafe(\`DELETE FROM public.\${table}\`);
  await sql.unsafe(\`TRUNCATE \${schema}.\${table}\`);
}
`
    );

    const result = runGuard();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("dynamic mutation target");
  });

  it("rejects quoted dynamic identifiers", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any, table: string) {
  await sql.unsafe(\`UPDATE "\${table}" SET name = $1\`, ["new"]);
  await sql.unsafe(\`DELETE FROM "\${table}"\`);
}
`
    );

    const result = runGuard();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr.match(/dynamic mutation target/g)).toHaveLength(2);
  });

  it("gives actionable advice for a dynamic non-entity target", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any, schema: string) {
  await sql.unsafe(\`INSERT INTO \${schema}.audit_log (message) VALUES ($1)\`, ["new"]);
}
`
    );

    const result = runGuard();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain(
      "A dynamically named table cannot be proven non-entity"
    );
    expect(stderr).not.toContain(
      "Route production entity-row mutations through"
    );
  });

  it("rejects a dynamic target whose expression contains nested braces", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any, key: string) {
  const tables = { entity: "entities" };
  await sql.unsafe(\`UPDATE \${/* } */ tables[\`\${key}\`] /* } */} SET name = $1\`, ["new"]);
}
`
    );

    const result = runGuard();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("dynamic mutation target");
  });

  it("reports the exact line after a multiline interpolation", () => {
    writeFileSync(
      PROBE,
      `export async function probe(sql: any, table: string) {
  await sql.unsafe(\`
    SELECT \${(() => {
      return 1;
    })()};
    UPDATE \${table} SET name = $1
  \`, ["new"]);
}
`
    );

    const result = runGuard();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "entity-write-funnel-probe.ts:6"
    );
  });

  it("rejects a stale bypass allowance", () => {
    const guardSource = readFileSync(GUARD, "utf8");
    writeFileSync(
      STALE_GUARD_PROBE,
      guardSource.replace("1280c3ed0fdded46", "0000000000000000")
    );

    const result = Bun.spawnSync(["bun", STALE_GUARD_PROBE], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("stale allowance(s)");
  });

  it("reports the count for a duplicated stale allowance", () => {
    const guardSource = readFileSync(GUARD, "utf8");
    writeFileSync(
      STALE_GUARD_PROBE,
      guardSource.replace("6c2d50be50c02a93", "0000000000000000")
    );

    const result = Bun.spawnSync(["bun", STALE_GUARD_PROBE], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "x2 [set or rollback default entity view template]"
    );
  });

  it("does not govern test fixtures", () => {
    const testProbe = join(
      REPO_ROOT,
      "packages/server/src/utils/__tests__/entity-write-funnel-probe.test.ts"
    );
    writeFileSync(
      testProbe,
      `export async function seed(sql: any) {
  await sql\`INSERT INTO entities (name) VALUES (\${"fixture"})\`;
}
`
    );
    try {
      const result = runGuard();
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(testProbe, { force: true });
    }
  });
});
