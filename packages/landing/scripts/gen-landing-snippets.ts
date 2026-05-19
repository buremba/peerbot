#!/usr/bin/env bun
/**
 * Pulls real source files from `examples/<id>/` and emits a JSON manifest the
 * landing page imports at build time.
 *
 * For each of the 8 dev-focused use cases the landing page features, we read:
 *   - lobu.toml                                              -> agent snippet
 *   - models/schema.yaml (top-level `entities:` section)     -> memory snippet
 *   - models/schema.yaml (top-level `watchers:` section)     -> watcher snippet
 *   - first models/reactions/*.reaction.ts (optional)        -> reaction snippet
 *   - first connectors/*.connector.ts (optional)             -> connector snippet
 *
 * Each snippet records its display path and a GitHub permalink so the
 * `CodeBlock` component can render a "See on GitHub →" footer.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(__dirname, "../../../examples");
const outFile = resolve(__dirname, "../src/generated/use-case-snippets.json");

const USE_CASES = [
  "legal",
  "finance",
  "sales",
  "delivery",
  "leadership",
  "agent-community",
  "ecommerce",
  "market",
] as const;

type Language = "toml" | "yaml" | "typescript";

type Snippet = {
  code: string;
  path: string;
  githubUrl: string;
  language: Language;
};

type UseCaseSnippets = {
  agentToml: Snippet;
  memorySchemaYaml: Snippet;
  watcherYaml: Snippet;
  connectorTs?: Snippet;
  reactionTs?: Snippet;
};

const GITHUB_BASE = "https://github.com/lobu-ai/lobu/blob/main/examples";

function githubUrlFor(useCase: string, relativePath: string): string {
  return `${GITHUB_BASE}/${useCase}/${relativePath}`;
}

/**
 * Split a YAML doc on its top-level keys. Returns just the chunk for the
 * requested top-level key (e.g. `entities:` or `watchers:`) plus optional
 * leading `version:` / comment lines so the snippet still parses as YAML.
 */
function extractYamlSection(yaml: string, sectionKey: string): string {
  const lines = yaml.split("\n");
  const out: string[] = [];
  let inSection = false;
  let captured = false;

  // Capture leading top-level scalars (e.g. `version: 2`) and blank lines
  // before any other section starts, so the snippet has context.
  for (const line of lines) {
    if (/^[A-Za-z_][\w-]*:/.test(line)) {
      const key = line.split(":")[0];
      if (key === sectionKey) {
        inSection = true;
        captured = true;
        out.push(line);
        continue;
      }
      if (key === "version" && !captured) {
        out.push(line);
        continue;
      }
      // Hit a different top-level section -> stop capturing if we were in.
      if (inSection) break;
      // Hit a different top-level section before ours -> skip its body.
      // We continue scanning; nested lines (starting with space) below
      // will be skipped by the outer `if` test until we see the next
      // top-level key.
      continue;
    }
    if (inSection) {
      out.push(line);
      continue;
    }
    if (!captured && line.trim().startsWith("#")) {
      // Leading comment before any section starts.
      out.push(line);
    }
  }

  // Trim trailing blank lines.
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

function firstFile(dir: string, suffix: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const entries = readdirSync(dir);
  const match = entries.find((f) => f.endsWith(suffix));
  return match ? resolve(dir, match) : undefined;
}

function buildSnippet(
  useCase: string,
  absPath: string,
  relativePath: string,
  language: Language,
  transform?: (raw: string) => string
): Snippet {
  const raw = readFileSync(absPath, "utf-8");
  const code = transform ? transform(raw) : raw;
  return {
    code: code.replace(/\s+$/, ""),
    path: relativePath,
    githubUrl: githubUrlFor(useCase, relativePath),
    language,
  };
}

function buildForUseCase(useCase: string): UseCaseSnippets {
  const root = resolve(examplesDir, useCase);

  const tomlPath = resolve(root, "lobu.toml");
  const schemaPath = resolve(root, "models/schema.yaml");
  if (!existsSync(tomlPath)) {
    throw new Error(`Missing ${tomlPath}`);
  }
  if (!existsSync(schemaPath)) {
    throw new Error(`Missing ${schemaPath}`);
  }

  const agentToml = buildSnippet(
    useCase,
    tomlPath,
    "lobu.toml",
    "toml"
  );

  const memorySchemaYaml = buildSnippet(
    useCase,
    schemaPath,
    "models/schema.yaml",
    "yaml",
    (raw) => extractYamlSection(raw, "entities")
  );

  const watcherYaml = buildSnippet(
    useCase,
    schemaPath,
    "models/schema.yaml",
    "yaml",
    (raw) => extractYamlSection(raw, "watchers")
  );

  const reactionPath = firstFile(
    resolve(root, "models/reactions"),
    ".reaction.ts"
  );
  let reactionTs: Snippet | undefined;
  if (reactionPath) {
    const rel = `models/reactions/${reactionPath.split("/").pop()}`;
    reactionTs = buildSnippet(useCase, reactionPath, rel, "typescript");
  }

  const connectorPath = firstFile(
    resolve(root, "connectors"),
    ".connector.ts"
  );
  let connectorTs: Snippet | undefined;
  if (connectorPath) {
    const rel = `connectors/${connectorPath.split("/").pop()}`;
    connectorTs = buildSnippet(useCase, connectorPath, rel, "typescript");
  }

  return { agentToml, memorySchemaYaml, watcherYaml, reactionTs, connectorTs };
}

function main() {
  const out: Record<string, UseCaseSnippets> = {};
  for (const useCase of USE_CASES) {
    out[useCase] = buildForUseCase(useCase);
  }
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
  // eslint-disable-next-line no-console
  console.log(
    `gen-landing-snippets: wrote ${Object.keys(out).length} use cases to ${outFile}`
  );
}

main();
