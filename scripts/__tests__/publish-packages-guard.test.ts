/**
 * @lobu/worker@14.3.0 shipped to the registry declaring runtime dependencies on
 * five private workspace packages at their `0.0.0` placeholder versions,
 * breaking external installs (issue #2186).
 *
 * The cause was `rewriteWorkspaceRefs` resolving `workspace:*` against whatever
 * version it read off disk without checking the target is published.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "bun:test";
import { __testing, rewriteWorkspaceRefs } from "../publish-packages.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function workerManifest() {
  return {
    name: "@lobu/worker",
    version: "14.3.0",
    dependencies: {
      "@lobu/core": "workspace:*",
      "@lobu/plugin-api": "workspace:*",
      "@lobu/plugin-host": "workspace:*",
      "@lobu/plugin-mcp": "workspace:*",
      "@lobu/plugin-memory": "workspace:*",
    },
  };
}

describe("rewriteWorkspaceRefs publishability guard", () => {
  it("refuses a runtime dependency on a package the script does not publish", () => {
    expect(() => rewriteWorkspaceRefs(workerManifest())).toThrow(
      /@lobu\/plugin-mcp/
    );
  });

  it("names the offending package and both remedies, not just 'failed'", () => {
    let message = "";
    try {
      rewriteWorkspaceRefs(workerManifest());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("@lobu/worker");
    expect(message).toContain("@lobu/plugin-mcp");
    expect(message).toContain("bundling");
    expect(message).toContain("PACKAGES");
  });

  it("guards every runtime dependency section, including explicit versions", () => {
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      expect(() =>
        rewriteWorkspaceRefs({
          name: "@lobu/worker",
          version: "14.3.0",
          [section]: { "@lobu/plugin-mcp": "1.2.3" },
        })
      ).toThrow(/@lobu\/plugin-mcp/);
    }
  });

  it("still rewrites refs when every runtime dependency is published", () => {
    const pkg = rewriteWorkspaceRefs({
      name: "@lobu/cli",
      version: "14.3.0",
      dependencies: { "@lobu/core": "workspace:*" },
    }) as { dependencies: Record<string, string> };
    // Resolved to the real on-disk version, and no longer a workspace: ref.
    expect(pkg.dependencies["@lobu/core"]).not.toContain("workspace:");
    expect(pkg.dependencies["@lobu/core"]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("allows a private workspace package as a devDependency", () => {
    // devDependencies are not installed by consumers, so a private dev-only
    // tool is legitimate and must not trip the guard.
    const pkg = rewriteWorkspaceRefs({
      name: "@lobu/cli",
      version: "14.3.0",
      dependencies: {},
      devDependencies: { "@lobu/plugin-mcp": "workspace:*" },
    }) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["@lobu/plugin-mcp"]).not.toContain("workspace:");
  });

  it("still rejects a workspace ref outside the @lobu scope", () => {
    expect(() =>
      rewriteWorkspaceRefs({
        name: "@lobu/cli",
        version: "14.3.0",
        dependencies: { "some-other-pkg": "workspace:*" },
      })
    ).toThrow(/outside @lobu scope/);
  });
});

describe("blocked-dependency skip ordering", () => {
  it("lists PACKAGES so dependencies precede their dependents", () => {
    // The skip logic relies on seeing a blocked dependency before any package
    // that depends on it. If PACKAGES is ever reordered, dependents would be
    // published against a missing dependency again.
    const order = __testing.PACKAGES.map((p: { dir: string }) => p.dir);
    const indexOf = (dir: string) => order.indexOf(dir);
    for (const { dir } of __testing.PACKAGES) {
      for (const dep of __testing.lobuRuntimeDeps(dir)) {
        const depDir = __testing.PACKAGES.find(
          (p: { dir: string }) => __testing.packageNameFor(p.dir) === dep
        )?.dir;
        if (!depDir) continue; // Unpublished dep — the guard above covers it.
        expect(indexOf(depDir)).toBeLessThan(indexOf(dir));
      }
    }
  });

  it("propagates an unavailable package to transitive dependents", () => {
    const unavailable = new Set(["@lobu/missing"]);
    expect(
      __testing.markUnavailablePackage(
        "@lobu/direct-dependent",
        ["@lobu/missing"],
        unavailable
      )
    ).toEqual({
      name: "@lobu/direct-dependent",
      missingDeps: ["@lobu/missing"],
    });
    expect(
      __testing.markUnavailablePackage(
        "@lobu/transitive-dependent",
        ["@lobu/direct-dependent"],
        unavailable
      )
    ).toEqual({
      name: "@lobu/transitive-dependent",
      missingDeps: ["@lobu/direct-dependent"],
    });
  });
});

/**
 * The guard tests above drive helpers directly. This suite runs the real
 * publish loop as a subprocess against a stub `npm` placed earlier on PATH, so
 * the E404 → skip-dependents path that actually shipped the bug is executed
 * rather than reasoned about.
 */
describe("publish loop (subprocess, stub npm)", () => {
  const scratch = join(REPO_ROOT, ".publish-guard-scratch");
  const binDir = join(scratch, "bin");
  const logFile = join(scratch, "publish.log");

  /**
   * Stub npm: `view` reports nothing published, `publish` returns E404 for the
   * blockNames and succeeds otherwise. Every publish attempt is appended to
   * logFile so the test can assert exactly who was and wasn't published.
   */
  function writeStubNpm(blockNames: string[]) {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "npm"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `const blocked = ${JSON.stringify(blockNames)};`,
        `const log = ${JSON.stringify(logFile)};`,
        // `npm view <pkg>@<ver> version` → nothing is published yet.
        "if (args[0] === 'view') { process.exit(1); }",
        "if (args[0] === 'publish') {",
        "  const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));",
        "  fs.appendFileSync(log, pkg.name + '\\n');",
        "  if (blocked.includes(pkg.name)) {",
        "    process.stderr.write('npm ERR! code E404\\n');",
        "    process.exit(1);",
        "  }",
        "  process.exit(0);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      { mode: 0o755 }
    );
  }

  function runPublishScript() {
    return spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, "scripts/publish-packages.mjs"),
        "--skip-bump",
        "--skip-build",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      }
    );
  }

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("skips dependents of a blocked package and exits nonzero", () => {
    // @lobu/core is blocked; every other published package depends on it.
    writeStubNpm(["@lobu/core"]);
    const result = runPublishScript();
    const attempted = existsSync(logFile)
      ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
      : [];

    // The blocked package was attempted...
    expect(attempted).toContain("@lobu/core");
    // ...and its dependents were never handed to npm publish. This is the
    // exact regression that shipped: dependents published anyway, producing
    // manifests pointing at a version that does not exist.
    expect(attempted).not.toContain("@lobu/connector-sdk");
    expect(attempted).not.toContain("@lobu/cli");
    // Packages with no runtime @lobu dependency are unaffected and still ship
    // — the guard must not turn one blocked package into a total outage.
    expect(attempted).toContain("@lobu/client");
    // @lobu/worker still declares @lobu/core on disk, but publishes a manifest
    // with zero @lobu dependencies because the bundle inlines the graph. The
    // gate must read the transformed manifest: reading the raw one skipped the
    // worker here, reinstating the bootstrap wait this change removes.
    expect(attempted).toContain("@lobu/worker");

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("skipped");
  });

  it("publishes the whole fleet when every manifest is publishable", () => {
    // With @lobu/worker's private plugins now inlined into its bundle, no
    // manifest declares an unpublishable dependency, so a release run should
    // complete. Before that fix this aborted at @lobu/worker (#2186).
    writeStubNpm([]);
    const result = runPublishScript();
    const attempted = existsSync(logFile)
      ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
      : [];

    expect(result.status).toBe(0);
    expect(attempted.length).toBe(__testing.PACKAGES.length);
    expect(attempted).toContain("@lobu/worker");
    expect(attempted).toContain("@lobu/cli");
  });
});

/**
 * The published @lobu/worker manifest is the artifact consumers actually
 * install, and it diverges from the in-repo one on purpose (bundle entry, no
 * src/, no @lobu deps). These lock that shape in — verified end to end by
 * packing the tarball and installing it into an empty directory, where it
 * imports and the `lobu-worker` bin runs.
 */
describe("published @lobu/worker manifest", () => {
  const transformed = (() => {
    const entry = __testing.PACKAGES.find(
      (p: { dir: string }) => p.dir === "packages/agent-worker"
    );
    const manifest = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "packages/agent-worker/package.json"),
        "utf8"
      )
    );
    return entry.transform(manifest) as {
      main: string;
      bin: Record<string, string>;
      files: string[];
      exports: Record<string, unknown>;
      dependencies: Record<string, string>;
    };
  })();

  it("declares no @lobu dependencies — the whole workspace graph is inlined", () => {
    // The exact defect from #2186. @lobu/core, plugin-api and plugin-host are
    // CommonJS while the bundle is ESM, so they are inlined too; declaring
    // them would also keep the release blocked on a bootstrap publish.
    const lobuDeps = Object.keys(transformed.dependencies ?? {}).filter((d) =>
      d.startsWith("@lobu/")
    );
    expect(lobuDeps).toEqual([]);
  });

  it("points every entry at the bundle and ships no src/", () => {
    expect(transformed.main).toBe("./dist/index.bundle.mjs");
    expect(transformed.bin["lobu-worker"]).toBe("./dist/index.bundle.mjs");
    // Shipping src/ would reintroduce the unresolvable private-plugin imports,
    // and the `bun` export condition pointed straight at it.
    expect(transformed.files).not.toContain("src");
    expect(JSON.stringify(transformed.exports)).not.toContain("src/");
  });

  it("keeps the in-repo manifest on the src/ dev path", () => {
    // The transform is publish-time only. The server resolves @lobu/worker's
    // src/index.ts in-repo, so mutating the real manifest would break dev.
    const inRepo = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "packages/agent-worker/package.json"),
        "utf8"
      )
    );
    expect(inRepo.files).toContain("src");
    expect(inRepo.exports["."].bun).toBe("./src/index.ts");
  });
});

/**
 * The server spawns the worker by resolving a path inside the INSTALLED
 * @lobu/worker package. If the publish transform stops shipping the file that
 * resolver names, every published-CLI worker start fails at runtime with a
 * missing entry point — invisible to typecheck and to any in-repo test, because
 * in-repo the src/ path wins. This pins the two together.
 */
describe("installed worker entry point is actually published", () => {
  const RESOLVER = join(
    REPO_ROOT,
    "packages/server/src/gateway/config/index.ts"
  );

  /** dist/... paths the resolver can hand back for an installed package. */
  function resolverInstalledEntries() {
    const source = readFileSync(RESOLVER, "utf8");
    return [
      ...source.matchAll(/workerPackageRoot,\s*\n?\s*"(dist\/[^"]+)"/g),
    ].map((m) => m[1]);
  }

  it("ships every dist entry the server can resolve to", () => {
    const entry = __testing.PACKAGES.find(
      (p: { dir: string }) => p.dir === "packages/agent-worker"
    );
    const published = entry.transform(
      JSON.parse(
        readFileSync(
          join(REPO_ROOT, "packages/agent-worker/package.json"),
          "utf8"
        )
      )
    ) as { files: string[] };

    const candidates = resolverInstalledEntries();
    // Guard the guard: if the resolver is refactored so this regex stops
    // matching, an empty list would vacuously pass.
    expect(candidates.length).toBeGreaterThan(0);

    // EVERY dist path the resolver can name must be shipped. Asserting only
    // the first is too weak — source order is not resolution order, so a
    // resolver that fell back to an unshipped path would still pass.
    const unshipped = candidates.filter((c) => !published.files.includes(c));
    expect(unshipped).toEqual([]);
  });
});

/**
 * `bump-version.mjs` used to accept any string as an explicit version, so a
 * stray flag rewrote every package.json in the workspace to a nonsense value
 * (`node scripts/bump-version.mjs --help` → `"version": "--help"`). These run
 * the real script and assert it refuses BEFORE writing anything.
 */
describe("bump-version input validation (subprocess)", () => {
  // bump-version writes the root manifest AND every workspace package it lists,
  // so all of them are snapshotted and restored. Restoring only the root left
  // 9 packages bumped to the test's version — a test must never mutate the repo.
  const manifests = [
    join(REPO_ROOT, "package.json"),
    ...__testing.PACKAGES.map((p: { dir: string }) =>
      join(REPO_ROOT, p.dir, "package.json")
    ),
  ];

  function runBump(arg: string) {
    const before = new Map(
      manifests.map((file) => [file, readFileSync(file, "utf8")])
    );
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts/bump-version.mjs"), arg],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    let wrote = false;
    for (const [file, original] of before) {
      if (readFileSync(file, "utf8") !== original) {
        wrote = true;
        writeFileSync(file, original);
      }
    }
    return { result, wrote };
  }

  it.each([
    "--help",
    "-v",
    "latest",
    "1.2",
    "v1.2.3",
    "",
  ])("rejects %p without writing any manifest", (bad) => {
    const { result, wrote } = runBump(bad);
    // Empty string is falsy — the script no-ops rather than erroring, but it
    // must still never write a bad version.
    expect(wrote).toBe(false);
    if (bad !== "") expect(result.status).not.toBe(0);
  });

  it.each(["9.9.9", "9.9.9-beta.1"])("accepts explicit semver %p", (good) => {
    const { result, wrote } = runBump(good);
    expect(result.status).toBe(0);
    expect(wrote).toBe(true);
  });
});
