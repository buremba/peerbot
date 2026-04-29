import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBackendBundle } from "../commands/dev";

describe("lobu run backend bundle resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds the backend bundle copied to the CLI dist root", () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-cli-dist-"));
    tempDirs.push(root);

    const commandsDir = join(root, "dist", "commands");
    mkdirSync(commandsDir, { recursive: true });

    const bundlePath = join(root, "dist", "server.bundle.mjs");
    writeFileSync(bundlePath, "// bundle placeholder\n");

    expect(resolveBackendBundle(commandsDir)).toBe(bundlePath);
  });
});
