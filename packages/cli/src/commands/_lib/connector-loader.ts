/**
 * Connector source resolution + compilation for the CLI.
 *
 * Mirrors `packages/server/src/utils/connector-catalog.ts` (the server-side
 * versions of these helpers) but inlined here so the CLI doesn't depend on
 * @lobu/server — that package is private and never published, while the CLI
 * is what end users install from npm.
 *
 * Lookup order for bundled connector source:
 *   1. dist/connectors/ next to this file (published CLI runtime — see
 *      packages/cli/scripts/build.cjs which copies packages/connectors/src
 *      there at build time).
 *   2. ../../../connectors/src relative to this file (monorepo dev).
 *   3. process.cwd()/packages/connectors/src (running from a parent dir).
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, type Plugin } from "esbuild";

const require_ = createRequire(import.meta.url);
const SDK_ENTRY = require_.resolve("@lobu/connector-sdk");

// Single source of truth lives in @lobu/connector-worker. Duplicated here as
// a flat string array to keep this file self-contained — drift cost is low
// (the list is tiny and rarely changes; if a new external dep is added the
// CLI surfaces a clear bundling error and we update both places).
const EXTERNAL_RUNTIME_DEPS = ["playwright", "sharp", "jimp"] as const;

const SOURCE_DIR_CANDIDATES = [
  // Published CLI runtime: packages/cli/scripts/build.cjs copies the
  // connector .ts sources into dist/connectors right next to this file.
  resolve(import.meta.dirname ?? __dirname, "../../connectors"),
  // Monorepo source layout.
  resolve(import.meta.dirname ?? __dirname, "../../../../connectors/src"),
  // Project-root fallback.
  resolve(process.cwd(), "packages/connectors/src"),
];

const bundledFileCache = new Map<string, string | null>();

export function findBundledConnectorFile(key: string): string | null {
  const cached = bundledFileCache.get(key);
  if (cached !== undefined) return cached;
  const fileName = `${key.replace(/\./g, "_")}.ts`;
  let found: string | null = null;
  for (const candidate of SOURCE_DIR_CANDIDATES) {
    const filePath = resolve(candidate, fileName);
    if (existsSync(filePath)) {
      found = filePath;
      break;
    }
  }
  bundledFileCache.set(key, found);
  return found;
}

// Connectors import npm deps with the `npm:` prefix. Strip it so esbuild
// resolves the bare specifier against the local node_modules; mark unresolved
// ones external so the CLI bundle still produces (the runtime will fail loud
// if a missing dep is actually used).
const npmSpecifierPlugin: Plugin = {
  name: "npm-specifier",
  setup(b) {
    b.onResolve({ filter: /^npm:/ }, async (args) => {
      const bare = args.path
        .slice(4)
        .replace(/^(@[^/]+\/[^/@]+)@[^/]*/, "$1")
        .replace(/^([^/@]+)@[^/]*/, "$1");
      const resolved = await b.resolve(bare, {
        resolveDir: args.resolveDir,
        kind: args.kind,
      });
      if (resolved.errors.length > 0) {
        return { path: bare, external: true, errors: [], warnings: [] };
      }
      return resolved;
    });
  },
};

const compiledFileCache = new Map<string, { mtimeMs: number; code: string }>();

export async function compileConnectorFromFile(
  filePath: string
): Promise<string> {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
    const cached = compiledFileCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.code;
  } catch {
    // stat failed — fall through and let the build surface the real error.
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "lobu-cli-connector-"));
  const outPath = join(tmpDir, "out.mjs");

  try {
    await build({
      entryPoints: [filePath],
      outfile: outPath,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      alias: { lobu: SDK_ENTRY, "@lobu/connector-sdk": SDK_ENTRY },
      banner: {
        js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
      },
      plugins: [npmSpecifierPlugin],
      external: [...EXTERNAL_RUNTIME_DEPS],
      write: true,
      minify: false,
      sourcemap: false,
    });

    const code = await readFile(outPath, "utf-8");
    if (mtimeMs !== null) compiledFileCache.set(filePath, { mtimeMs, code });
    return code;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
