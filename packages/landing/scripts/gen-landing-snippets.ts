#!/usr/bin/env bun
/**
 * Pulls real source files from `examples/<id>/` and emits a JSON manifest the
 * landing page imports at build time.
 *
 * Round 3 constraint: every code block on the landing must fit without an
 * internal scrollbar at a normal viewport. So this script DOESN'T just dump
 * the full file — it extracts a focused slice per snippet:
 *
 *   - lobu.toml             -> the `[agents.<id>]` table + first
 *                              `[[agents.<id>.providers]]` block + `[memory]`
 *   - models/schema.yaml    -> two slim views of the same file:
 *                              * memorySchemaYaml: first 1-2 entity types,
 *                                with descriptions and x-table-* metadata
 *                                pruned
 *                              * watcherYaml: the first watcher only, with
 *                                long prose prompts collapsed to a single
 *                                literal line
 *   - models/reactions/...  -> the first *.reaction.ts (already small)
 *   - connectors/...        -> the first *.connector.ts (must be small in
 *                              the source — see CONNECTORS_MAX_LINES check)
 *
 * Each snippet records its display path and a GitHub permalink so the
 * `CodeBlock` component can render a "see on github →" footer.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

const CONNECTORS_MAX_LINES = 40;

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

/* -------------------------------------------------------------------------- */
/*  TOML extraction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Pull the `[agents.<id>]`, first `[[agents.<id>.providers]]`, and `[memory]`
 * tables out of a lobu.toml. Drops the leading docstring comment and any
 * other `[agents.<id>.<sub>]` tables (network rules, guardrails, etc.).
 */
function trimAgentToml(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let inSection = false;
  let inProviders = false;
  let providersSeen = false;
  for (const line of lines) {
    const sectionMatch = /^\s*\[\[?([\w.-]+)\]\]?\s*$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1];
      // Top-level [agents.<id>] table (e.g. agents.sales)
      const isAgentTop = /^agents\.[\w-]+$/.test(name);
      const isFirstProvider =
        /^agents\.[\w-]+\.providers$/.test(name) && !providersSeen;
      const isMemory = name === "memory";
      inSection = isAgentTop || isFirstProvider || isMemory;
      inProviders = isFirstProvider;
      if (inProviders) providersSeen = true;
      if (inSection) {
        if (out.length > 0) out.push("");
        out.push(line);
      }
      continue;
    }
    if (inSection) {
      // Skip the `dir` line in [agents.<id>] (filesystem detail, not load-bearing)
      // and trailing blank lines inside a section.
      if (/^\s*dir\s*=/.test(line)) continue;
      out.push(line);
    }
  }
  // Compact: drop runs of >1 blank line, trim trailing whitespace.
  return collapseBlanks(out).join("\n");
}

/* -------------------------------------------------------------------------- */
/*  YAML extraction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Extract a top-level YAML list, returning the leading `<key>:` line plus the
 * first `n` items at indent depth 2 (or whatever the first `- ` indent is).
 */
function extractYamlListItems(
  raw: string,
  topKey: string,
  itemCount: number
): string[] {
  const lines = raw.split("\n");
  let inSection = false;
  let header: string | null = null;
  const items: string[][] = [];
  let current: string[] | null = null;
  let baseIndent = -1;

  for (const line of lines) {
    if (/^[A-Za-z_][\w-]*:/.test(line)) {
      const key = line.split(":")[0];
      if (key === topKey) {
        inSection = true;
        header = line;
        continue;
      }
      if (inSection) break;
    }
    if (!inSection) continue;
    const dashMatch = /^(\s*)-\s/.exec(line);
    if (dashMatch) {
      if (baseIndent < 0) baseIndent = dashMatch[1].length;
      if (dashMatch[1].length === baseIndent) {
        // New item.
        if (current) items.push(current);
        current = [line];
        continue;
      }
    }
    if (current) {
      // Continuation of current item (deeper indent or comment line).
      // Stop if we drop below baseIndent at a non-dash level.
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim() === "" || indent > baseIndent) {
        current.push(line);
      } else {
        // Belongs to a sibling top-level key — stop.
        break;
      }
    }
  }
  if (current) items.push(current);
  if (!header) return [];
  const slice = items.slice(0, itemCount).flat();
  return [header, ...slice];
}

/**
 * Drop verbose entity-type metadata that doesn't teach anything on the landing:
 * `description:`, `icon:`, `color:`, the `x-table-*` extensions, enum blocks,
 * normalize/namespace blocks. Also caps each entity's `properties:` to the
 * first 4 keys so very wide schemas (e.g. market.Company) stay on screen.
 */
function pruneEntityMetadata(yamlLines: string[]): string[] {
  return capProperties(stripNoiseLines(yamlLines), 4);
}

function stripNoiseLines(yamlLines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < yamlLines.length) {
    const line = yamlLines[i];
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("description:") ||
      trimmed.startsWith("icon:") ||
      trimmed.startsWith("color:") ||
      /^x-/.test(trimmed) ||
      trimmed.startsWith("namespace:") ||
      trimmed.startsWith("normalize:")
    ) {
      i++;
      continue;
    }
    // Drop an `enum:` block (header + nested `- value` items).
    const enumMatch = /^(\s*)enum\s*:\s*$/.exec(line);
    if (enumMatch) {
      const baseIndent = enumMatch[1].length;
      let j = i + 1;
      while (j < yamlLines.length) {
        const sub = yamlLines[j];
        if (sub.trim() === "") {
          j++;
          continue;
        }
        const subInd = sub.length - sub.trimStart().length;
        if (subInd <= baseIndent) break;
        j++;
      }
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out;
}

function capProperties(yamlLines: string[], maxKeys: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < yamlLines.length) {
    const line = yamlLines[i];
    const propsMatch = /^(\s*)properties\s*:\s*$/.exec(line);
    if (!propsMatch) {
      out.push(line);
      i++;
      continue;
    }
    const baseIndent = propsMatch[1].length;
    const propIndent = baseIndent + 2;
    out.push(line);
    let j = i + 1;
    let propsKept = 0;
    let totalProps = 0;
    let copying = false;
    while (j < yamlLines.length) {
      const sub = yamlLines[j];
      if (sub.trim() === "") {
        j++;
        continue;
      }
      const subInd = sub.length - sub.trimStart().length;
      if (subInd <= baseIndent) break;
      const isPropKey =
        subInd === propIndent && /^[A-Za-z_][\w-]*\s*:/.test(sub.trimStart());
      if (isPropKey) {
        totalProps++;
        copying = propsKept < maxKeys;
        if (copying) propsKept++;
      }
      if (copying) out.push(sub);
      j++;
    }
    if (totalProps > propsKept) {
      out.push(`${" ".repeat(propIndent)}# …${totalProps - propsKept} more`);
    }
    i = j;
  }
  return out;
}

/**
 * Collapse multi-line block scalars (`prompt: |` / `prompt: >`) and other
 * deeply-nested doc fields down to a single representative line so the
 * watcher block stays compact.
 */
function compressWatcher(yamlLines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < yamlLines.length) {
    const line = yamlLines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Detect a block-scalar prompt: `<indent>prompt: |` or `prompt: >`
    const blockMatch = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*[|>][+-]?\s*$/.exec(line);
    if (blockMatch && blockMatch[2] === "prompt") {
      const baseIndent = blockMatch[1].length;
      // Collect the first non-blank child line as the canonical example.
      let child = "";
      let j = i + 1;
      while (j < yamlLines.length) {
        const childLine = yamlLines[j];
        if (childLine.trim() === "") {
          j++;
          continue;
        }
        const childIndent = childLine.length - childLine.trimStart().length;
        if (childIndent <= baseIndent) break;
        child = childLine.trimStart();
        break;
      }
      // Skip past the whole block scalar.
      while (j < yamlLines.length) {
        const childLine = yamlLines[j];
        if (childLine.trim() === "") {
          j++;
          continue;
        }
        const childIndent = childLine.length - childLine.trimStart().length;
        if (childIndent <= baseIndent) break;
        j++;
      }
      out.push(`${" ".repeat(indent)}prompt: "${child.replace(/"/g, '\\"')}"`);
      i = j;
      continue;
    }

    if (
      trimmed.startsWith("description:") ||
      trimmed.startsWith("expected_output_count:") ||
      trimmed.startsWith("max_runs_per_day:") ||
      trimmed.startsWith("max_invocations_per_event:") ||
      trimmed.startsWith("retry_policy:") ||
      trimmed.startsWith("rate_limit:") ||
      trimmed.startsWith("notification_priority:") ||
      trimmed.startsWith("tags:") ||
      trimmed.startsWith("min_cooldown_seconds:") ||
      trimmed.startsWith("reaction_script:") ||
      trimmed.startsWith("name:")
    ) {
      i++;
      continue;
    }

    // Compact a sprawling extraction_schema: keep the header, the top-level
    // `type:` + `required:` line(s), and the property *names* only.
    const extractionMatch = /^(\s*)extraction_schema\s*:\s*$/.exec(line);
    if (extractionMatch) {
      const baseIndent = extractionMatch[1].length;
      const childIndent = baseIndent + 2;
      out.push(line);
      let j = i + 1;
      let typeLine: string | null = null;
      let requiredLines: string[] = [];
      const propNames: string[] = [];
      // Walk the schema body.
      while (j < yamlLines.length) {
        const child = yamlLines[j];
        if (child.trim() === "") {
          j++;
          continue;
        }
        const ind = child.length - child.trimStart().length;
        if (ind <= baseIndent) break;
        const ct = child.trimStart();
        if (ind === childIndent && ct.startsWith("type:")) {
          typeLine = child;
          j++;
          continue;
        }
        if (ind === childIndent && ct.startsWith("required:")) {
          // Capture the required: line; if it's a block-style list (next
          // lines start with `- `) collect them.
          requiredLines.push(child);
          let k = j + 1;
          while (k < yamlLines.length) {
            const sub = yamlLines[k];
            const subTrim = sub.trimStart();
            if (subTrim.startsWith("- ")) {
              requiredLines.push(sub);
              k++;
              continue;
            }
            break;
          }
          j = k;
          continue;
        }
        if (ind === childIndent && ct === "properties:") {
          j++;
          // Read property names at childIndent + 2.
          const propIndent = childIndent + 2;
          while (j < yamlLines.length) {
            const sub = yamlLines[j];
            if (sub.trim() === "") {
              j++;
              continue;
            }
            const subInd = sub.length - sub.trimStart().length;
            if (subInd < propIndent) break;
            if (subInd === propIndent) {
              const m = /^([A-Za-z_][\w-]*)\s*:/.exec(sub.trimStart());
              if (m) propNames.push(m[1]);
            }
            j++;
          }
          continue;
        }
        // Unknown child — skip.
        j++;
      }
      const pad = " ".repeat(childIndent);
      if (typeLine) out.push(typeLine);
      if (requiredLines.length > 0) {
        out.push(...requiredLines);
      }
      if (propNames.length > 0) {
        out.push(`${pad}properties:`);
        for (const name of propNames.slice(0, 4)) {
          out.push(`${pad}  ${name}: { type: string }`);
        }
        if (propNames.length > 4) {
          out.push(`${pad}  # …${propNames.length - 4} more`);
        }
      }
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function collapseBlanks(lines: string[]): string[] {
  const out: string[] = [];
  let blank = false;
  for (const line of lines) {
    const isBlank = line.trim() === "";
    if (isBlank && blank) continue;
    out.push(line);
    blank = isBlank;
  }
  // Trim leading/trailing blanks.
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

function firstFile(dir: string, suffix: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const entries = readdirSync(dir);
  const match = entries.find((f) => f.endsWith(suffix));
  return match ? resolve(dir, match) : undefined;
}

function snippetFrom(
  useCase: string,
  absPath: string,
  relativePath: string,
  language: Language,
  transform?: (raw: string) => string
): Snippet {
  const raw = readFileSync(absPath, "utf-8");
  const code = (transform ? transform(raw) : raw).replace(/\s+$/, "");
  return {
    code,
    path: relativePath,
    githubUrl: githubUrlFor(useCase, relativePath),
    language,
  };
}

function buildForUseCase(useCase: string): UseCaseSnippets {
  const root = resolve(examplesDir, useCase);
  const tomlPath = resolve(root, "lobu.toml");
  const schemaPath = resolve(root, "models/schema.yaml");
  if (!existsSync(tomlPath)) throw new Error(`Missing ${tomlPath}`);
  if (!existsSync(schemaPath)) throw new Error(`Missing ${schemaPath}`);

  const agentToml = snippetFrom(
    useCase,
    tomlPath,
    "lobu.toml",
    "toml",
    trimAgentToml
  );

  const memorySchemaYaml = snippetFrom(
    useCase,
    schemaPath,
    "models/schema.yaml",
    "yaml",
    (raw) =>
      collapseBlanks(
        pruneEntityMetadata(extractYamlListItems(raw, "entities", 2))
      ).join("\n")
  );

  const watcherYaml = snippetFrom(
    useCase,
    schemaPath,
    "models/schema.yaml",
    "yaml",
    (raw) =>
      collapseBlanks(
        compressWatcher(extractYamlListItems(raw, "watchers", 1))
      ).join("\n")
  );

  const reactionPath = firstFile(
    resolve(root, "models/reactions"),
    ".reaction.ts"
  );
  let reactionTs: Snippet | undefined;
  if (reactionPath) {
    const rel = `models/reactions/${reactionPath.split("/").pop()}`;
    reactionTs = snippetFrom(useCase, reactionPath, rel, "typescript");
  }

  const connectorPath = firstFile(resolve(root, "connectors"), ".connector.ts");
  let connectorTs: Snippet | undefined;
  if (connectorPath) {
    const rel = `connectors/${connectorPath.split("/").pop()}`;
    connectorTs = snippetFrom(useCase, connectorPath, rel, "typescript");
    const lineCount = connectorTs.code.split("\n").length;
    if (lineCount > CONNECTORS_MAX_LINES) {
      console.warn(
        `gen-landing-snippets: ${useCase}/${rel} is ${lineCount} lines — landing wants ≤ ${CONNECTORS_MAX_LINES} so the code block fits without scrolling.`
      );
    }
  }

  return { agentToml, memorySchemaYaml, watcherYaml, reactionTs, connectorTs };
}

function main() {
  const out: Record<string, UseCaseSnippets> = {};
  for (const useCase of USE_CASES) {
    out[useCase] = buildForUseCase(useCase);
  }
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
  console.log(
    `gen-landing-snippets: wrote ${Object.keys(out).length} use cases to ${outFile}`
  );
}

main();
