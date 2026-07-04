/**
 * Embed `skills/lobu/SKILL.md` into a committed TS constant the server bundles.
 *
 * Why embed instead of reading the file at runtime: the server ships as a
 * single esbuild bundle (see build-server-bundle.mjs) and `skills/` is a
 * repo-root dir that is NOT copied into the deployed server image. A runtime
 * path scan would work in local dev and 404 in prod. Bundling the string keeps
 * the `skill://lobu` MCP resource identical across dev and prod.
 *
 * Run: `bun run scripts/gen-skill-resource.ts`
 * A sync test guards the generated file against drift.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const SKILL_MD = resolve(REPO_ROOT, "skills/lobu/SKILL.md");
const OUT = resolve(
  REPO_ROOT,
  "packages/server/src/skills/lobu-skill.generated.ts"
);

const BANNER = `// GENERATED FILE — do not edit by hand.
// Source: skills/lobu/SKILL.md
// Regenerate: bun run scripts/gen-skill-resource.ts
// A sync test (skills/__tests__/lobu-skill-resource.test.ts) guards this against drift.
`;

async function main(): Promise<void> {
  const md = await readFile(SKILL_MD, "utf8");
  const body = `export const LOBU_SKILL_MARKDOWN = ${JSON.stringify(md)};\n`;
  await writeFile(OUT, `${BANNER}\n${body}`);
  process.stdout.write(`wrote ${OUT} (${md.length} chars)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
