import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GATE = join(REPO_ROOT, "scripts/check-directory-structure.mjs");

/** Build `packages/<pkg>/src/...` inside a throwaway root and run the gate there. */
function runGate(dir: string) {
  return Bun.spawnSync(["node", GATE], {
    cwd: dir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeSrc(dir: string, relPath: string, lines: number) {
  const full = join(dir, "packages", "svc", "src", relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    Array.from({ length: lines }, () => "export {};").join("\n")
  );
}

describe("check-directory-structure", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dir-structure-gate-"));
    mkdirSync(join(dir, "packages", "svc", "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes a tree with no repeated segment and no stalled extraction", () => {
    writeSrc(dir, "gateway/worker-dispatch/worker-gateway.ts", 400);
    writeSrc(dir, "tools/manage_ops.ts", 40);
    writeSrc(dir, "tools/manage_ops/handlers.ts", 900);

    const result = runGate(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("clean");
  });

  it("rule 1: rejects a directory that repeats its parent's name", () => {
    writeSrc(dir, "gateway/gateway/index.ts", 1200);

    const result = runGate(dir);
    expect(result.exitCode).toBe(1);
    const err = result.stderr.toString();
    expect(err).toContain("[rule 1]");
    expect(err).toContain("gateway/gateway");
  });

  it("rule 2: rejects a facade larger than the directory it extracted into", () => {
    writeSrc(dir, "tools/manage_ops.ts", 3500);
    writeSrc(dir, "tools/manage_ops/activity.ts", 600);

    const result = runGate(dir);
    expect(result.exitCode).toBe(1);
    const err = result.stderr.toString();
    expect(err).toContain("[rule 2]");
    expect(err).toContain("manage_ops.ts");
  });

  it("rule 2: ignores a small sibling directory, which is not a stalled extraction", () => {
    // `core/src/types.ts` beside a 32-line `core/src/types/` is a real, benign
    // shape in this repo. Below the weight threshold the rule must stay quiet.
    writeSrc(dir, "types.ts", 435);
    writeSrc(dir, "types/branded.ts", 30);

    const result = runGate(dir);
    expect(result.exitCode).toBe(0);
  });

  it("rule 2: accepts the finished facade shape", () => {
    writeSrc(dir, "tools/get_content.ts", 20);
    writeSrc(dir, "tools/get_content/search.ts", 3200);

    const result = runGate(dir);
    expect(result.exitCode).toBe(0);
  });

  it("does not walk __tests__, dist, or generated trees", () => {
    writeSrc(dir, "gateway/__tests__/__tests__/nested.ts", 10);
    writeSrc(dir, "gateway/dist/dist/bundle.ts", 10);
    writeSrc(dir, "gateway/generated/generated/types.ts", 10);

    const result = runGate(dir);
    expect(result.exitCode).toBe(0);
  });

  it("skips the owletto submodule, which has its own conventions", () => {
    const owletto = join(dir, "packages", "owletto", "src", "app", "app");
    mkdirSync(owletto, { recursive: true });
    writeFileSync(join(owletto, "index.ts"), "export {};");

    const result = runGate(dir);
    expect(result.exitCode).toBe(0);
  });

  it("governs handwritten client source but not its generated surface", () => {
    // packages/client mixes a tool-authored src/generated/** tree with ~670
    // lines of handwritten source. Excluding the whole package to skip the
    // generated half would leave the handwritten half ungoverned, so the
    // generated tree is skipped by SKIPPED_DIRS and the package is not.
    const clientSrc = join(dir, "packages", "client", "src");
    mkdirSync(join(clientSrc, "generated", "generated"), { recursive: true });
    writeFileSync(
      join(clientSrc, "generated", "generated", "types.ts"),
      "export {};"
    );
    mkdirSync(join(clientSrc, "session", "session"), { recursive: true });
    writeFileSync(
      join(clientSrc, "session", "session", "index.ts"),
      "export {};"
    );

    const result = runGate(dir);
    expect(result.exitCode).toBe(1);
    const err = result.stderr.toString();
    expect(err).toContain("1 violation(s)");
    expect(err).toContain(join("client", "src", "session", "session"));
    expect(err).not.toContain("generated");
  });

  it("reports every violation, not just the first", () => {
    writeSrc(dir, "gateway/gateway/index.ts", 1200);
    writeSrc(dir, "tools/manage_ops.ts", 3500);
    writeSrc(dir, "tools/manage_ops/activity.ts", 600);

    const result = runGate(dir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("2 violation(s)");
  });
});
