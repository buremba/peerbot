import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findEnclosingMonorepoRoot,
  resolveBackendBundle,
} from "../commands/dev";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

describe("lobu run backend bundle resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds backend bundles copied to the CLI dist root", () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-cli-dist-"));
    tempDirs.push(root);

    const commandsDir = join(root, "dist", "commands");
    mkdirSync(commandsDir, { recursive: true });

    const postgresBundlePath = join(root, "dist", "server.bundle.mjs");
    const pgliteBundlePath = join(root, "dist", "start-local.bundle.mjs");
    writeFileSync(postgresBundlePath, "// bundle placeholder\n");
    writeFileSync(pgliteBundlePath, "// bundle placeholder\n");

    expect(resolveBackendBundle(commandsDir, "postgres")).toBe(
      postgresBundlePath
    );
    expect(resolveBackendBundle(commandsDir, "pglite")).toBe(pgliteBundlePath);
  });

  test("CLI package declares runtime deps for the embedded server bundle", () => {
    const cli = readPackageJson(
      join(repoRoot, "packages", "cli", "package.json")
    );
    const server = readPackageJson(
      join(repoRoot, "packages", "server", "package.json")
    );
    const core = readPackageJson(
      join(repoRoot, "packages", "core", "package.json")
    );
    const connectorSdk = readPackageJson(
      join(repoRoot, "packages", "connector-sdk", "package.json")
    );
    const cliRuntimeDeps = {
      ...cli.dependencies,
      ...cli.optionalDependencies,
    };

    expect(cliRuntimeDeps["@lobu/worker"]).toBeDefined();
    expect(cliRuntimeDeps["@lobu/embeddings"]).toBeDefined();

    const assertDeclared = (deps: Record<string, string> | undefined) => {
      for (const name of Object.keys(deps ?? {})) {
        if (name.startsWith("@lobu/")) continue;
        expect(cliRuntimeDeps[name]).toBeDefined();
      }
    };

    // `lobu run` executes packages/server/dist/server.bundle.mjs from inside
    // the published @lobu/cli package. The bundle inlines @lobu workspace
    // source, while non-workspace packages remain bare imports resolved from
    // @lobu/cli's node_modules.
    assertDeclared(server.dependencies);
    assertDeclared(server.optionalDependencies);
    assertDeclared(core.dependencies);
    assertDeclared(connectorSdk.dependencies);

    // These are server build/dev deps today, but the embedded runtime imports
    // them at startup, while compiling bundled connector code, or while running
    // local PGlite.
    for (const name of [
      "dotenv",
      "esbuild",
      "vite",
      "@electric-sql/pglite",
      "@electric-sql/pglite-socket",
    ]) {
      expect(cliRuntimeDeps[name]).toBeDefined();
    }

    // Compiled connector code deliberately leaves these native/browser deps
    // external, so npx-installed CLIs must provide them too.
    for (const name of ["playwright", "sharp", "jimp"]) {
      expect(cliRuntimeDeps[name]).toBeDefined();
    }
  });

  test("findEnclosingMonorepoRoot walks up from a project subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-cli-monorepo-"));
    tempDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] })
    );
    mkdirSync(join(root, "packages", "agent-worker", "src"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "packages", "agent-worker", "src", "index.ts"),
      "// worker"
    );
    const subdir = join(root, "examples", "office-bot");
    mkdirSync(subdir, { recursive: true });

    expect(findEnclosingMonorepoRoot(subdir)).toBe(root);
    expect(findEnclosingMonorepoRoot(root)).toBe(root);

    const lone = mkdtempSync(join(tmpdir(), "lobu-cli-lone-"));
    tempDirs.push(lone);
    expect(findEnclosingMonorepoRoot(lone)).toBeNull();
  });

  test("findEnclosingMonorepoRoot resolves this repo's root", () => {
    const found = findEnclosingMonorepoRoot(here);
    expect(found).not.toBeNull();
    expect(
      existsSync(join(found!, "packages", "agent-worker", "src", "index.ts"))
    ).toBe(true);
  });

  test("CLI build copies local runtime assets for installed lobu run", () => {
    expect(existsSync(join(repoRoot, "db", "migrations"))).toBe(true);
    expect(
      existsSync(join(repoRoot, "packages", "cli", "scripts", "build.cjs"))
    ).toBe(true);

    const buildScript = readFileSync(
      join(repoRoot, "packages", "cli", "scripts", "build.cjs"),
      "utf8"
    );
    expect(buildScript).toContain('copyDirIfExists("../../db/migrations"');
    expect(buildScript).toContain('"start-local.bundle.mjs"');
  });
});
