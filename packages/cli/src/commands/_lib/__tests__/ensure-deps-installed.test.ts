/**
 * Tests for the project dependency installer (#1181).
 *
 * The installer is exercised against a fake `npm` binary staged on a
 * test-controlled PATH (a recorder script that logs argv + cwd), so no real
 * package-manager work or network happens. npm — not bun — because the bun
 * test runner intercepts spawns of `bun` and runs the real binary regardless
 * of PATH. A `package-lock.json` in each fixture pins `pickInstaller` to npm.
 * The failure path uses a recorder that exits non-zero to assert
 * warn-don't-fail semantics in `lobu init`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, installScaffoldedProjectDeps } from "../../init.js";
import { installProjectDeps } from "../ensure-deps-installed.js";

const ORIGINAL_PATH = process.env.PATH;
const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Project fixture whose package-lock.json pins pickInstaller to npm. */
function mkNpmProject(): string {
  const root = mkTempDir("lobu-proj-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p" }));
  writeFileSync(join(root, "package-lock.json"), "{}");
  return root;
}

/**
 * Stage a fake `npm` on a fresh PATH dir: a recorder script that appends
 * argv + cwd to `logFile` and exits with `exitCode`.
 */
function stageFakeNpm(opts: { logFile: string; exitCode?: number }): string {
  const binDir = mkTempDir("lobu-fake-bin-");
  const script = [
    "#!/bin/sh",
    `{ echo "args=$@"; echo "cwd=$(pwd)"; } >> "${opts.logFile}"`,
    `exit ${opts.exitCode ?? 0}`,
    "",
  ].join("\n");
  const binPath = join(binDir, "npm");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  return binDir;
}

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("installProjectDeps", () => {
  test("invokes the picked installer with --ignore-scripts in the project root", () => {
    const root = mkNpmProject();
    const logFile = join(mkTempDir("lobu-log-"), "install.log");
    process.env.PATH = stageFakeNpm({ logFile });

    const { installer } = installProjectDeps(root, { stdio: "pipe" });

    expect(installer).toBe("npm");
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("args=install --ignore-scripts --no-audit --no-fund");
    // $(pwd) resolves macOS /var → /private/var; compare realpaths.
    expect(log).toContain(`cwd=${realpathSync(root)}`);
  });

  test("throws when the installer exits non-zero", () => {
    const root = mkNpmProject();
    const logFile = join(mkTempDir("lobu-log-"), "install.log");
    process.env.PATH = stageFakeNpm({ logFile, exitCode: 1 });

    expect(() => installProjectDeps(root, { stdio: "pipe" })).toThrow();
  });

  test("throws when the installer binary is missing", () => {
    const root = mkNpmProject();
    process.env.PATH = mkTempDir("lobu-empty-bin-"); // no npm here

    expect(() => installProjectDeps(root, { stdio: "pipe" })).toThrow();
  });
});

describe("installScaffoldedProjectDeps (lobu init wiring)", () => {
  test("returns null on success", () => {
    const root = mkNpmProject();
    const logFile = join(mkTempDir("lobu-log-"), "install.log");
    process.env.PATH = stageFakeNpm({ logFile });

    expect(installScaffoldedProjectDeps(root)).toBeNull();
    expect(readFileSync(logFile, "utf-8")).toContain(
      "args=install --ignore-scripts"
    );
  });

  test("warns (does not throw) when the install fails", () => {
    const root = mkNpmProject();
    const logFile = join(mkTempDir("lobu-log-"), "install.log");
    process.env.PATH = stageFakeNpm({ logFile, exitCode: 1 });

    const warning = installScaffoldedProjectDeps(root);
    expect(warning).toContain("npm install");
    expect(warning).toContain("bun install");
  });

  test("warns (does not throw) when the installer binary is missing", () => {
    const root = mkNpmProject();
    process.env.PATH = mkTempDir("lobu-empty-bin-"); // no npm here

    const warning = installScaffoldedProjectDeps(root);
    expect(warning).toContain("npm install");
  });
});

describe("lobu init runs the dependency install", () => {
  test("scaffold installs devDependencies into the new project", async () => {
    // `--here` into a dir pre-seeded with package-lock.json so pickInstaller
    // selects the fake npm recorder (see header comment for why not bun).
    const projectDir = mkTempDir("lobu-init-cwd-");
    writeFileSync(join(projectDir, "package-lock.json"), "{}");
    const logFile = join(mkTempDir("lobu-log-"), "install.log");
    process.env.PATH = stageFakeNpm({ logFile });

    await initCommand(projectDir, undefined, { yes: true, here: true });

    const pkg = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf-8")
    );
    expect(pkg.devDependencies["@lobu/connector-sdk"]).toBeDefined();
    expect(pkg.devDependencies["@lobu/cli"]).toBeDefined();

    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("args=install --ignore-scripts");
    expect(log).toContain(`cwd=${realpathSync(projectDir)}`);
  }, 30_000);
});
