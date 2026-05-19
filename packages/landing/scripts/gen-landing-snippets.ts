#!/usr/bin/env bun
/**
 * Pulls real source files from `examples/<id>/` and emits a JSON manifest the
 * landing page imports at build time.
 *
 * Round 4 budget — every code block has to fit in the landing's flat
 * left-column without scrolling. Targets:
 *
 *   lobu.toml   ≤ 10 lines  (one [agents.<id>] table, one provider, [memory])
 *   memory      ≤ 20 lines  (ONE entity, 2-3 properties, type only)
 *   watcher     ≤ 15 lines  (slug + agent + trigger + 1-line prompt +
 *                           extraction_schema.type + required)
 *   connector   ≤ 28 lines  (handled by the source files themselves)
 *   reaction    untouched   (real example code)
 *
 * Each snippet records its display path and a GitHub permalink so the
 * `CodeBlock` component can render a "see on github" footer.
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

const BUDGETS = {
  agentToml: 12,
  memorySchemaYaml: 22,
  watcherYaml: 16,
  connectorTs: 40,
  reactionTs: 50,
};

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

const TOML_AGENT_KEEP_KEYS = new Set(["name"]);
const TOML_PROVIDER_KEEP_KEYS = new Set(["id", "model", "key"]);
const TOML_MEMORY_KEEP_KEYS = new Set([
  "enabled",
  "org",
  "models",
  "data",
]);

function trimAgentToml(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  type Mode = "skip" | "agent" | "provider" | "memory";
  let mode: Mode = "skip";
  let providersSeen = false;
  for (const line of lines) {
    const sectionMatch = /^\s*\[\[?([\w.-]+)\]\]?\s*$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1];
      const isAgentTop = /^agents\.[\w-]+$/.test(name);
      const isFirstProvider =
        /^agents\.[\w-]+\.providers$/.test(name) && !providersSeen;
      const isMemory = name === "memory";
      if (isAgentTop) mode = "agent";
      else if (isFirstProvider) {
        mode = "provider";
        providersSeen = true;
      } else if (isMemory) mode = "memory";
      else mode = "skip";
      if (mode !== "skip") {
        out.push(line.trimEnd());
      }
      continue;
    }
    if (mode === "skip") continue;
    const kvMatch = /^\s*([A-Za-z_][\w-]*)\s*=/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const keep =
      (mode === "agent" && TOML_AGENT_KEEP_KEYS.has(key)) ||
      (mode === "provider" && TOML_PROVIDER_KEEP_KEYS.has(key)) ||
      (mode === "memory" && TOML_MEMORY_KEEP_KEYS.has(key));
    if (keep) out.push(line.trimEnd());
  }
  return collapseBlanks(out).join("\n");
}

/* -------------------------------------------------------------------------- */
/*  YAML helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Extract the first N list items at the top-level `<key>:` of a YAML doc. */
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
        if (current) items.push(current);
        current = [line];
        continue;
      }
    }
    if (current) {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim() === "" || indent > baseIndent) {
        current.push(line);
      } else {
        break;
      }
    }
  }
  if (current) items.push(current);
  if (!header) return [];
  return [header, ...items.slice(0, itemCount).flat()];
}

/* -------------------------------------------------------------------------- */
/*  Memory (entity) compression                                               */
/* -------------------------------------------------------------------------- */

/**
 * Strict entity-section shrinker. Keeps:
 *   - the `entities:` header
 *   - the first entity's `- slug:` and `name:`
 *   - the entity's `metadata_schema.type:`
 *   - `properties:` with the first 3 keys, each rendered as a single line
 *     (`<key>: { type: <type> }`) regardless of the source's expanded form
 *
 * Everything else (description, icon, color, enum, x-*, nested objects,
 * extra entities) is dropped.
 */
function compressEntities(yamlLines: string[]): string[] {
  if (yamlLines.length === 0) return [];
  const out: string[] = [];
  let i = 0;
  // Header
  if (/^entities:/.test(yamlLines[0])) {
    out.push("entities:");
    i++;
  }
  // First item
  while (i < yamlLines.length && yamlLines[i].trim() === "") i++;
  if (i >= yamlLines.length) return out;

  const firstLine = yamlLines[i];
  const dashMatch = /^(\s*)-\s/.exec(firstLine);
  if (!dashMatch) return out;
  const baseIndent = dashMatch[1].length;
  const childIndent = baseIndent + 2;
  const pad = " ".repeat(baseIndent);
  const padChild = " ".repeat(childIndent);

  // Walk the first item collecting slug, name, properties.
  let slug = "";
  let name = "";
  const props: Array<{ key: string; type: string }> = [];

  let cursor = i;
  // Read first-line `- slug: foo`
  const slugInline = /^\s*-\s*slug:\s*(.+)$/.exec(firstLine);
  if (slugInline) slug = slugInline[1].trim();
  cursor++;

  // childIndent is where direct children of the `- slug: …` mapping live
  // (e.g. `name:`, `metadata_schema:` — aligned with `slug` after the dash).
  // The source uses YAML's 2-space-per-indent style, so children are at
  // baseIndent + 2. metadata_schema's body lives at +4, and the property
  // *names* under metadata_schema.properties live at +6.
  let inProperties = false;
  let currentPropName: string | null = null;
  let currentPropType: string | null = null;
  while (cursor < yamlLines.length) {
    const ln = yamlLines[cursor];
    if (ln.trim() === "") {
      cursor++;
      continue;
    }
    const ind = ln.length - ln.trimStart().length;
    if (ind <= baseIndent) break;
    const trimmed = ln.trimStart();

    if (ind === childIndent) {
      // Direct child of the entity mapping.
      if (trimmed.startsWith("slug:")) {
        slug = trimmed.slice("slug:".length).trim();
      } else if (trimmed.startsWith("name:")) {
        name = trimmed.slice("name:".length).trim();
      }
      inProperties = false;
      currentPropName = null;
      currentPropType = null;
      cursor++;
      continue;
    }
    if (trimmed === "properties:" && ind === childIndent + 2) {
      inProperties = true;
      currentPropName = null;
      currentPropType = null;
      cursor++;
      continue;
    }
    if (inProperties && ind === childIndent + 4) {
      const m = /^([A-Za-z_][\w-]*)\s*:/.exec(trimmed);
      if (m) {
        if (currentPropName && currentPropType) {
          props.push({ key: currentPropName, type: currentPropType });
        }
        currentPropName = m[1];
        currentPropType = "string";
      }
    } else if (inProperties && currentPropName && trimmed.startsWith("type:")) {
      currentPropType = trimmed.slice("type:".length).trim();
    }
    cursor++;
  }
  if (currentPropName && currentPropType) {
    props.push({ key: currentPropName, type: currentPropType });
  }

  out.push(`${pad}- slug: ${slug || "entity"}`);
  if (name) out.push(`${padChild}name: ${name}`);
  out.push(`${padChild}metadata_schema:`);
  out.push(`${padChild}  type: object`);
  out.push(`${padChild}  properties:`);
  const shownProps = props.slice(0, 3);
  for (const p of shownProps) {
    out.push(`${padChild}    ${p.key}: { type: ${p.type} }`);
  }
  if (props.length > shownProps.length) {
    out.push(`${padChild}    # ${props.length - shownProps.length} more…`);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Watcher compression                                                       */
/* -------------------------------------------------------------------------- */

const WATCHER_KEEP_TOP_KEYS = new Set(["slug", "agent", "on", "schedule"]);

/**
 * Strict watcher shrinker — output layout:
 *   watchers:
 *     - slug: <name>
 *       agent: <id>
 *       (on | schedule): <value>
 *       prompt: "<first non-blank line of the source prompt>"
 *       extraction_schema:
 *         type: object
 *         required: [<top-level required keys>]
 */
function compressWatcher(yamlLines: string[]): string[] {
  if (yamlLines.length === 0) return [];
  const out: string[] = [];
  if (/^watchers:/.test(yamlLines[0])) {
    out.push("watchers:");
  }
  // First item
  let i = 1;
  while (i < yamlLines.length && yamlLines[i].trim() === "") i++;
  if (i >= yamlLines.length) return out;

  const firstLine = yamlLines[i];
  const dashMatch = /^(\s*)-\s/.exec(firstLine);
  if (!dashMatch) return out;
  const baseIndent = dashMatch[1].length;
  const childIndent = baseIndent + 2;
  const pad = " ".repeat(baseIndent);
  const padChild = " ".repeat(childIndent);

  const fields: Record<string, string> = {};
  let prompt = "";
  let extractionRequired: string[] = [];

  // Parse inline first line: `- slug: <value>`
  const slugInline = /^\s*-\s*slug:\s*(.+)$/.exec(firstLine);
  if (slugInline) fields.slug = slugInline[1].trim();

  let cursor = i + 1;
  while (cursor < yamlLines.length) {
    const ln = yamlLines[cursor];
    if (ln.trim() === "") {
      cursor++;
      continue;
    }
    const ind = ln.length - ln.trimStart().length;
    if (ind <= baseIndent) break;
    const trimmed = ln.trimStart();

    // Top-level child of the watcher (slug, agent, on, schedule, prompt, …)
    if (ind === childIndent) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed);
      if (!kv) {
        cursor++;
        continue;
      }
      const [, key, value] = kv;
      // Block scalar prompt
      if (key === "prompt") {
        if (value === "|" || value === ">" || value === "" || value === "|-" || value === ">-") {
          // Collect first non-blank child line.
          let k = cursor + 1;
          while (k < yamlLines.length) {
            const sub = yamlLines[k];
            if (sub.trim() === "") {
              k++;
              continue;
            }
            const subInd = sub.length - sub.trimStart().length;
            if (subInd <= childIndent) break;
            prompt = sub.trimStart();
            break;
          }
          // Skip the rest of the block.
          while (k < yamlLines.length) {
            const sub = yamlLines[k];
            if (sub.trim() === "") {
              k++;
              continue;
            }
            const subInd = sub.length - sub.trimStart().length;
            if (subInd <= childIndent) break;
            k++;
          }
          cursor = k;
          continue;
        }
        prompt = value;
        cursor++;
        continue;
      }
      // extraction_schema block: harvest the FIRST `required:` we see at the
      // expected nesting depth (childIndent + 2). Nested `required:` lists
      // inside object properties don't belong on the landing.
      if (key === "extraction_schema") {
        const schemaInd = childIndent + 2;
        let k = cursor + 1;
        let captured = false;
        while (k < yamlLines.length) {
          const sub = yamlLines[k];
          if (sub.trim() === "") {
            k++;
            continue;
          }
          const subInd = sub.length - sub.trimStart().length;
          if (subInd <= childIndent) break;
          if (!captured && subInd === schemaInd && sub.trimStart().startsWith("required:")) {
            const sct = sub.trimStart();
            const inline = sct.slice("required:".length).trim();
            if (inline.startsWith("[") && inline.endsWith("]")) {
              extractionRequired = inline
                .slice(1, -1)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              captured = true;
              k++;
              continue;
            }
            // Block list form — collect lines at schemaInd + 2 starting with `- `.
            k++;
            while (k < yamlLines.length) {
              const sub2 = yamlLines[k];
              if (sub2.trim() === "") {
                k++;
                continue;
              }
              const sub2Ind = sub2.length - sub2.trimStart().length;
              const sub2Trim = sub2.trimStart();
              if (sub2Ind === schemaInd + 2 && sub2Trim.startsWith("- ")) {
                extractionRequired.push(sub2Trim.slice(2).trim());
                k++;
                continue;
              }
              break;
            }
            captured = true;
            continue;
          }
          k++;
        }
        cursor = k;
        continue;
      }
      if (WATCHER_KEEP_TOP_KEYS.has(key)) {
        fields[key] = value;
      }
    }
    cursor++;
  }

  out.push(`${pad}- slug: ${fields.slug ?? "watcher"}`);
  if (fields.agent) out.push(`${padChild}agent: ${fields.agent}`);
  if (fields.on) out.push(`${padChild}on: ${fields.on}`);
  if (fields.schedule) out.push(`${padChild}schedule: ${fields.schedule}`);
  if (prompt) {
    const compact = prompt.replace(/^["'`]?|["'`]?$/g, "").replace(/\s+/g, " ");
    out.push(`${padChild}prompt: "${compact}"`);
  }
  out.push(`${padChild}extraction_schema:`);
  out.push(`${padChild}  type: object`);
  if (extractionRequired.length > 0) {
    out.push(
      `${padChild}  required: [${extractionRequired.slice(0, 5).join(", ")}${
        extractionRequired.length > 5
          ? `, …${extractionRequired.length - 5}`
          : ""
      }]`
    );
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

function warnOverBudget(useCase: string, name: string, lines: number, budget: number) {
  if (lines > budget) {
    console.warn(
      `gen-landing-snippets: ${useCase}/${name} is ${lines} lines — landing budget is ≤ ${budget}.`
    );
  }
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
  warnOverBudget(useCase, "lobu.toml", agentToml.code.split("\n").length, BUDGETS.agentToml);

  const memorySchemaYaml = snippetFrom(
    useCase,
    schemaPath,
    "models/schema.yaml",
    "yaml",
    (raw) => collapseBlanks(compressEntities(extractYamlListItems(raw, "entities", 1))).join("\n")
  );
  warnOverBudget(useCase, "memorySchemaYaml", memorySchemaYaml.code.split("\n").length, BUDGETS.memorySchemaYaml);

  const watcherYaml = snippetFrom(
    useCase,
    schemaPath,
    "models/schema.yaml",
    "yaml",
    (raw) => collapseBlanks(compressWatcher(extractYamlListItems(raw, "watchers", 1))).join("\n")
  );
  warnOverBudget(useCase, "watcherYaml", watcherYaml.code.split("\n").length, BUDGETS.watcherYaml);

  const reactionPath = firstFile(resolve(root, "models/reactions"), ".reaction.ts");
  let reactionTs: Snippet | undefined;
  if (reactionPath) {
    const rel = `models/reactions/${reactionPath.split("/").pop()}`;
    reactionTs = snippetFrom(useCase, reactionPath, rel, "typescript");
    warnOverBudget(useCase, rel, reactionTs.code.split("\n").length, BUDGETS.reactionTs);
  }

  const connectorPath = firstFile(resolve(root, "connectors"), ".connector.ts");
  let connectorTs: Snippet | undefined;
  if (connectorPath) {
    const rel = `connectors/${connectorPath.split("/").pop()}`;
    connectorTs = snippetFrom(useCase, connectorPath, rel, "typescript");
    warnOverBudget(useCase, rel, connectorTs.code.split("\n").length, BUDGETS.connectorTs);
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
