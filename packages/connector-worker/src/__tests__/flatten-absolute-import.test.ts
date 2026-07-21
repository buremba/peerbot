import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { flattenConnectorSourceFromFile } from "../compile/index.js";

/**
 * Containment: flattening runs esbuild with bundle:true, so an absolute-path
 * import in a connector source would otherwise have its host-file contents
 * inlined into the persisted snapshot before the downstream source-text import
 * guard ever runs. flattenConnectorSourceFromFile must hard-reject it here.
 */
describe("flattenConnectorSourceFromFile absolute-import containment", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lobu-flatten-abs-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hard-rejects an absolute-path import instead of inlining the host file", async () => {
    // A VALID-JS file at an absolute path: without the guard, esbuild's default
    // resolver reads it and silently inlines SECRET into the snapshot (no throw
    // — the exfiltration). With the guard, flattening fails with our specific
    // error, so a plain toThrow() is not enough — assert the message.
    const secretPath = join(dir, "host-secret.ts");
    await writeFile(secretPath, "export const SECRET = 'exfiltrated-host-file';\n");
    const entry = join(dir, "abs-connector.ts");
    await writeFile(
      entry,
      `import { SECRET } from '${secretPath}';\nexport default () => SECRET;\n`
    );
    await expect(flattenConnectorSourceFromFile(entry)).rejects.toThrow(
      /Unsupported absolute import/
    );
  });

  it("still inlines a sibling relative import and leaves bare/node imports external", async () => {
    await writeFile(join(dir, "helper.ts"), "export const HELP = 42;\n");
    const entry = join(dir, "ok-connector.ts");
    await writeFile(
      entry,
      [
        "import { readFile } from 'node:fs/promises';",
        "import { HELP } from './helper.ts';",
        "export default () => HELP + (readFile ? 0 : 1);",
      ].join("\n") + "\n"
    );
    const flattened = await flattenConnectorSourceFromFile(entry);
    // Relative sibling is inlined (source text present, import removed)...
    expect(flattened).toContain("HELP = 42");
    expect(flattened).not.toContain("./helper.ts");
    // ...while the node builtin stays an external import for the real compiler.
    expect(flattened).toContain("node:fs/promises");
  });
});
