/**
 * Connector source resolution + compilation for the CLI.
 *
 * Lookup order for bundled connector source:
 *   1. dist/connectors/ next to this file (published CLI runtime — see
 *      packages/cli/scripts/build.cjs which copies packages/connectors/src
 *      there at build time).
 *   2. ../../../connectors/src relative to this file (monorepo dev).
 *   3. process.cwd()/packages/connectors/src (running from a parent dir).
 *
 * The resolver + esbuild bundle pipeline themselves live in
 * `@lobu/connector-worker/compile` so the three call-sites (worker, CLI,
 * server) share one implementation.
 */
import { resolve } from "node:path";
import {
  createConnectorCompiler,
  findBundledConnectorFile as findInDirs,
} from "@lobu/connector-worker/compile";

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
  const found = findInDirs(key, SOURCE_DIR_CANDIDATES);
  bundledFileCache.set(key, found);
  return found;
}

const compiler = createConnectorCompiler();

export const compileConnectorFromFile = compiler.compileConnectorFromFile;
