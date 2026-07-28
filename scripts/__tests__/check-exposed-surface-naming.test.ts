/**
 * The naming guard is only worth having if it actually fails on a regression.
 * Three earlier revisions of it passed clean on violations they were written to
 * catch: a key-anchored regex that could not match `watcher_source`, a scan that
 * saw only `*Namespace` method names, and one that saw only direct members of
 * exported types.
 *
 * These fixtures mutate a scratch copy of the real scanned files, run the guard
 * as a subprocess, and assert the exit code — the same signal `make pre-pr` and
 * CI act on.
 */

import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/check-exposed-surface-naming.ts");
const NAMESPACE_FILE = join(
  REPO_ROOT,
  "packages/server/src/sandbox/namespaces/behaviors.ts"
);
const CONTRACT_FILE = join(
  REPO_ROOT,
  "packages/core/src/contracts/tools/manage-entity.ts"
);
const PUBLIC_ACTIVITY_FILE = join(
  REPO_ROOT,
  "packages/server/src/tools/admin/manage_operations/activity-feed.ts"
);
/** Defines `AuthProfileKind`, which the auth-profiles namespace imports aliased. */
const IMPORTED_TYPE_FILE = join(
  REPO_ROOT,
  "packages/server/src/utils/auth-profiles.ts"
);

/** Namespace whose method signature the alias fixture hangs a probe type off. */
const CATALOG_NAMESPACE_FILE = join(
  REPO_ROOT,
  "packages/server/src/sandbox/namespaces/catalog.ts"
);
/** Written and deleted per-test; reached only via the `@lobu/core/` alias. */
const CORE_PROBE_FILE = join(REPO_ROOT, "packages/core/src/guard-probe.ts");

const touched: string[] = [];
const created: string[] = [];

function mutate(file: string, anchor: string, insert: string): void {
  // Back up only on first touch: a fixture that mutates the same file twice
  // would otherwise overwrite the pristine copy with an already-mutated one and
  // leave the repo dirty after the run.
  if (!touched.includes(file)) {
    copyFileSync(file, `${file}.guardbak`);
    touched.push(file);
  }
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found in ${file}: ${anchor}`);
  writeFileSync(file, source.slice(0, at) + insert + source.slice(at));
}

function create(file: string, contents: string): void {
  created.push(file);
  writeFileSync(file, contents);
}

function runGuard(): number {
  const result = Bun.spawnSync(["bun", GUARD], { cwd: REPO_ROOT });
  return result.exitCode;
}

afterEach(() => {
  for (const file of touched.splice(0)) {
    copyFileSync(`${file}.guardbak`, file);
    rmSync(`${file}.guardbak`, { force: true });
  }
  for (const file of created.splice(0)) {
    rmSync(file, { force: true });
  }
});

describe("check-exposed-surface-naming", () => {
  it("passes on the clean tree", () => {
    expect(runGuard()).toBe(0);
  });

  it("fails on a snake_case wire key in a TypeBox tool contract", () => {
    mutate(
      CONTRACT_FILE,
      "  behavior_source: Type.Optional(",
      "  watcher_source: Type.Optional(Type.Number()),\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a camelCase key in a TypeBox tool contract", () => {
    mutate(
      CONTRACT_FILE,
      "  behavior_source: Type.Optional(",
      "  watcherId: Type.Optional(Type.String()),\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a banned key in a plain public response type", () => {
    mutate(
      PUBLIC_ACTIVITY_FILE,
      "\tbehavior_id?: number;",
      "\twatcher_id?: number;"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a banned key in an exported namespace input type", () => {
    mutate(
      NAMESPACE_FILE,
      "export interface",
      "export interface GuardFixtureDirect { watcher_id: number }\n\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a banned key nested inside an exported type", () => {
    mutate(
      NAMESPACE_FILE,
      "export interface",
      "export interface GuardFixtureNested { source: { watcher_id: number } }\n\n"
    );
    expect(runGuard()).toBe(1);
  });

  // `auth-profiles` namespace exposes `profile_kind: AuthProfileKind`, which
  // resolves through `Exclude<StoredAuthProfileKind, …>` to a type imported
  // *under an alias* from ../../utils/auth-profiles. The banned value therefore
  // lives in a file the guard never scans directly and is reachable only by
  // following the reference — and by mapping the alias back to the name the
  // defining module actually declares. Adding the union member to the real
  // referenced type is what makes this fixture exercise that path; a fresh
  // unreferenced type would prove nothing, since nothing points at it.
  it("fails on a banned literal inside an aliased imported type", () => {
    // Anchored on the first union member so the inserted one joins the existing
    // declaration rather than creating a second, unreferenced one.
    mutate(IMPORTED_TYPE_FILE, "  | 'env'", "  | 'watcher_kind'\n");
    expect(runGuard()).toBe(1);
  });

  // `@lobu/core/...` is not a relative specifier, so an earlier revision skipped
  // it as "not ours" — while `CatalogNamespace.listCatalog` takes a type
  // imported from exactly there. The probe type lives outside
  // contracts/tools so the TypeBox scanner cannot claim the catch; only alias
  // resolution reaches it.
  it("fails on a banned key reached through a workspace-alias import", () => {
    create(
      CORE_PROBE_FILE,
      "export interface GuardProbeInput { watcher_id: number }\n"
    );
    mutate(
      CATALOG_NAMESPACE_FILE,
      "\tlistCatalog(",
      "\tprobe(input: GuardProbeInput): Promise<void>;\n"
    );
    mutate(
      CATALOG_NAMESPACE_FILE,
      "import type",
      'import type { GuardProbeInput } from "@lobu/core/guard-probe";\n'
    );
    expect(runGuard()).toBe(1);
  });

  // An inherited member is on the wire exactly like a declared one, and
  // `extends` parses as ExpressionWithTypeArguments rather than a
  // TypeReferenceNode — so following only type references walked straight past
  // it.
  it("fails on a banned key inherited through an extends clause", () => {
    mutate(
      NAMESPACE_FILE,
      "export interface",
      "interface GuardBase { watcher_id: number }\nexport interface GuardChild extends GuardBase {}\n\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a banned key in an inline method parameter type", () => {
    mutate(
      NAMESPACE_FILE,
      "export interface",
      "export interface GuardFixtureNamespace {\n  run(input: { watcher_id: number }): Promise<void>;\n}\n\n"
    );
    expect(runGuard()).toBe(1);
  });
});
