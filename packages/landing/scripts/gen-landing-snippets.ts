#!/usr/bin/env bun
/**
 * Reads pinned files out of `examples/` and emits a flat JSON manifest the
 * landing page imports at build time.
 *
 * Each primitive section shows ONE canonical pinned example, used as the
 * generic fallback when no use case is selected:
 *
 *   connector    -> examples/ecommerce/connectors/stripe-charges.connector.ts
 *   memorySchema -> examples/sales/models/schema.yaml         (entities slice)
 *   watcher      -> examples/sales/models/schema.yaml         (watchers slice)
 *   reaction     -> examples/sales/models/reactions/account-health-monitor.reaction.ts
 *   agentToml    -> examples/sales/lobu.toml
 *
 * Plus a list of every `examples/*\/lobu.toml` for BrowseExamplesSection:
 *
 *   examples     -> [{ slug, label, description, githubUrl }]
 *
 * And, under `useCases`, per-use-case connector / memorySchema / watcher
 * snippets keyed by the example dir slug. The interactive use-case tab strip
 * on the landing page swaps these three sections; everything else stays
 * generic. Hero copy is not part of this manifest.
 *
 * The skill snippet stays inline in LandingPage.tsx (set in round 9).
 *
 * Output: packages/landing/src/generated/landing-snippets.json
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(__dirname, "../../../examples");
const outFile = resolve(__dirname, "../src/generated/landing-snippets.json");

const PINNED = {
  connector: {
    slug: "ecommerce",
    path: "connectors/stripe-charges.connector.ts",
  },
  memorySchema: { slug: "sales", path: "models/schema.yaml" },
  watcher: { slug: "leadership", path: "models/schema.yaml" },
  reaction: {
    slug: "finance",
    path: "models/reactions/reconciliation-monitor.reaction.ts",
  },
  agentToml: { slug: "lobu-crm", path: "lobu.toml" },
  skill: {
    slug: "office-bot",
    path: "agents/food-ordering/skills/deliveroo-order/SKILL.md",
  },
} as const;

const BUDGETS = {
  agentToml: 12,
  memorySchema: 22,
  watcher: 16,
  reaction: 50,
  connector: 40,
  skill: 26,
};

type Language = "toml" | "yaml" | "typescript" | "markdown";

type Snippet = {
  code: string;
  path: string;
  githubUrl: string;
  language: Language;
};

type ExampleEntry = {
  slug: string;
  label: string;
  description: string | null;
  githubUrl: string;
};

type UseCaseSnippets = {
  connector: Snippet;
  memorySchema: Snippet;
  watcher: Snippet;
};

type LandingSnippets = {
  connector: Snippet;
  memorySchema: Snippet;
  watcher: Snippet;
  reaction: Snippet;
  agentToml: Snippet;
  skill: Snippet;
  examples: ExampleEntry[];
  useCases: Record<string, UseCaseSnippets>;
};

/** Slugs that get per-use-case connector / memory / watcher snippets. The id
 *  equals the example directory name. Each dir has exactly one
 *  connectors/*.connector.ts and a models/schema.yaml. */
const USE_CASE_SLUGS = [
  "legal",
  "finance",
  "sales",
  "delivery",
  "market",
  "agent-community",
  "ecommerce",
  "leadership",
] as const;

const GITHUB_FILE_BASE = "https://github.com/lobu-ai/lobu/blob/main/examples";
const GITHUB_TREE_BASE = "https://github.com/lobu-ai/lobu/tree/main/examples";

function githubFileUrl(slug: string, relativePath: string): string {
  return `${GITHUB_FILE_BASE}/${slug}/${relativePath}`;
}

function githubTreeUrl(slug: string): string {
  return `${GITHUB_TREE_BASE}/${slug}`;
}

/* -------------------------------------------------------------------------- */
/*  TOML extraction                                                           */
/* -------------------------------------------------------------------------- */

const TOML_AGENT_KEEP_KEYS = new Set(["name"]);
const TOML_PROVIDER_KEEP_KEYS = new Set(["id", "model", "key"]);
const TOML_MEMORY_KEEP_KEYS = new Set(["enabled", "org", "models", "data"]);

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
      if (mode !== "skip") out.push(line.trimEnd());
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

/** Parse a full lobu.toml and pull the first agent name + description fields. */
type TomlExampleMeta = { label: string | null; description: string | null };

function readExampleMeta(rawToml: string, slug: string): TomlExampleMeta {
  const lines = rawToml.split("\n");
  type Mode = "none" | "agent" | "memory";
  let mode: Mode = "none";
  let agentName: string | null = null;
  let agentDescription: string | null = null;
  let memoryDescription: string | null = null;
  for (const line of lines) {
    const sectionMatch = /^\s*\[\[?([\w.-]+)\]\]?\s*$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1];
      if (/^agents\.[\w-]+$/.test(name) && mode === "none") mode = "agent";
      else if (name === "memory") mode = "memory";
      else if (mode !== "none") mode = "none";
      continue;
    }
    const kv = /^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (mode === "agent" && key === "name" && !agentName) agentName = value;
    if (mode === "agent" && key === "description" && !agentDescription)
      agentDescription = value;
    if (mode === "memory" && key === "description" && !memoryDescription)
      memoryDescription = value;
  }
  const label = agentName ?? slug.charAt(0).toUpperCase() + slug.slice(1);
  const description = memoryDescription ?? agentDescription ?? null;
  return { label, description };
}

/* -------------------------------------------------------------------------- */
/*  YAML helpers                                                              */
/* -------------------------------------------------------------------------- */

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
      if (line.trim() === "" || indent > baseIndent) current.push(line);
      else break;
    }
  }
  if (current) items.push(current);
  if (!header) return [];
  return [header, ...items.slice(0, itemCount).flat()];
}

/* -------------------------------------------------------------------------- */
/*  Connector definition extraction                                           */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Memory (entity) compression                                               */
/* -------------------------------------------------------------------------- */

function compressEntities(yamlLines: string[]): string[] {
  if (yamlLines.length === 0) return [];
  const out: string[] = [];
  let i = 0;
  if (/^entities:/.test(yamlLines[0])) {
    out.push("entities:");
    i++;
  }
  while (i < yamlLines.length && yamlLines[i].trim() === "") i++;
  if (i >= yamlLines.length) return out;

  const firstLine = yamlLines[i];
  const dashMatch = /^(\s*)-\s/.exec(firstLine);
  if (!dashMatch) return out;
  const baseIndent = dashMatch[1].length;
  const childIndent = baseIndent + 2;
  const pad = " ".repeat(baseIndent);
  const padChild = " ".repeat(childIndent);

  let slug = "";
  let name = "";
  const props: Array<{ key: string; type: string }> = [];

  let cursor = i;
  const slugInline = /^\s*-\s*slug:\s*(.+)$/.exec(firstLine);
  if (slugInline) slug = slugInline[1].trim();
  cursor++;

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
      if (trimmed.startsWith("slug:")) slug = trimmed.slice(5).trim();
      else if (trimmed.startsWith("name:")) name = trimmed.slice(5).trim();
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
        if (currentPropName && currentPropType)
          props.push({ key: currentPropName, type: currentPropType });
        currentPropName = m[1];
        currentPropType = "string";
      }
    } else if (inProperties && currentPropName && trimmed.startsWith("type:")) {
      currentPropType = trimmed.slice(5).trim();
    }
    cursor++;
  }
  if (currentPropName && currentPropType)
    props.push({ key: currentPropName, type: currentPropType });

  out.push(`${pad}- slug: ${slug || "entity"}`);
  if (name) out.push(`${padChild}name: ${name}`);
  out.push(`${padChild}metadata_schema:`);
  out.push(`${padChild}  type: object`);
  out.push(`${padChild}  properties:`);
  const shown = props.slice(0, 3);
  for (const p of shown)
    out.push(`${padChild}    ${p.key}: { type: ${p.type} }`);
  if (props.length > shown.length)
    out.push(`${padChild}    # ${props.length - shown.length} more…`);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Watcher compression                                                       */
/* -------------------------------------------------------------------------- */

const WATCHER_KEEP_TOP_KEYS = new Set(["slug", "agent", "on", "schedule"]);

function compressWatcher(yamlLines: string[]): string[] {
  if (yamlLines.length === 0) return [];
  const out: string[] = [];
  if (/^watchers:/.test(yamlLines[0])) out.push("watchers:");
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

    if (ind === childIndent) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed);
      if (!kv) {
        cursor++;
        continue;
      }
      const [, key, value] = kv;
      if (key === "prompt") {
        if (
          value === "|" ||
          value === ">" ||
          value === "" ||
          value === "|-" ||
          value === ">-"
        ) {
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
          if (
            !captured &&
            subInd === schemaInd &&
            sub.trimStart().startsWith("required:")
          ) {
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
      if (WATCHER_KEEP_TOP_KEYS.has(key)) fields[key] = value;
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
/*  SKILL.md frontmatter extraction                                           */
/* -------------------------------------------------------------------------- */

/**
 * Pull just the YAML frontmatter out of a SKILL.md (everything between the
 * leading `---` and the next `---`). Then slim it so the landing snippet
 * fits the right column without scrolling:
 *
 *   - show the first 2 entries of `network.allow` / `network.judge` (the
 *     lists are illustrative, so no truncation marker)
 *   - shorten each judge policy to a concise folded block scalar (`>`)
 *   - leave name + description + nixPackages untouched
 */
function trimSkillMarkdown(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return raw;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return raw;
  const fm = lines.slice(0, end + 1);

  const out: string[] = [];
  let i = 0;
  while (i < fm.length) {
    const line = fm[i];

    // network.allow / network.judge, keep the first 2 entries. Entries may
    // span multiple lines (the `{ domain, judge }` per-domain form), so we keep
    // every line of a kept entry. Lists are illustrative: no truncation marker.
    const listKey = /^(\s*)(allow|judge):\s*$/.exec(line);
    if (listKey) {
      const baseIndent = listKey[1].length;
      out.push(line);
      let entries = 0;
      let keepingCurrent = false;
      let j = i + 1;
      while (j < fm.length) {
        const child = fm[j];
        const childTrim = child.trimStart();
        const childIndent = child.length - childTrim.length;
        if (childTrim !== "" && childIndent <= baseIndent) break;
        if (childTrim.startsWith("- ")) {
          entries++;
          keepingCurrent = entries <= 2;
        }
        if (keepingCurrent) out.push(child);
        j++;
      }
      i = j;
      continue;
    }

    // A judge policy (`<name>: >` block scalar under judges), keep a short
    // folded block scalar (valid YAML that reads naturally) in place of the
    // full multi-line policy text.
    const blockScalar = /^(\s*)([\w-]+):\s*[>|][+-]?\s*$/.exec(line);
    if (blockScalar) {
      const baseIndent = blockScalar[1].length;
      const policyName = blockScalar[2];
      const childPad = " ".repeat(baseIndent + 2);
      out.push(`${" ".repeat(baseIndent)}${policyName}: >`);
      out.push(
        `${childPad}Allow reads and basket changes. Deny checkout, payment,`
      );
      out.push(
        `${childPad}saved cards, address, or profile changes. Fail closed if unclear.`
      );
      let j = i + 1;
      while (j < fm.length) {
        const child = fm[j];
        if (child.trim() === "") {
          j++;
          continue;
        }
        const childIndent = child.length - child.trimStart().length;
        if (childIndent <= baseIndent) break;
        j++;
      }
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }
  return collapseBlanks(out).join("\n");
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

function snippetFrom(
  slug: string,
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
    githubUrl: githubFileUrl(slug, relativePath),
    language,
  };
}

function warnOverBudget(label: string, lines: number, budget: number): void {
  if (lines > budget) {
    console.warn(
      `gen-landing-snippets: ${label} is ${lines} lines, landing budget is <= ${budget}.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

function pinnedFile(slug: string, rel: string): string {
  const p = resolve(examplesDir, slug, rel);
  if (!existsSync(p)) throw new Error(`Missing pinned source ${p}`);
  return p;
}

function listExamples(): ExampleEntry[] {
  const entries = readdirSync(examplesDir, { withFileTypes: true });
  const out: ExampleEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const tomlPath = resolve(examplesDir, slug, "lobu.toml");
    if (!existsSync(tomlPath)) continue;
    const raw = readFileSync(tomlPath, "utf-8");
    const { label, description } = readExampleMeta(raw, slug);
    out.push({
      slug,
      label: label ?? slug,
      description,
      githubUrl: githubTreeUrl(slug),
    });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

function findConnectorFile(slug: string): { abs: string; rel: string } {
  const connectorsDir = resolve(examplesDir, slug, "connectors");
  const file = readdirSync(connectorsDir).find((f) =>
    f.endsWith(".connector.ts")
  );
  if (!file) throw new Error(`No *.connector.ts in ${connectorsDir}`);
  return {
    abs: resolve(connectorsDir, file),
    rel: `connectors/${file}`,
  };
}

function buildUseCases(): Record<string, UseCaseSnippets> {
  const out: Record<string, UseCaseSnippets> = {};
  for (const slug of USE_CASE_SLUGS) {
    const { abs, rel } = findConnectorFile(slug);
    // Show the full connector file (imports + class + definition + sync), like
    // the pinned homepage connector. These files are ~32-39 lines, within the
    // connector budget, and read as complete TypeScript rather than a fragment.
    const connector = snippetFrom(slug, abs, rel, "typescript");

    const schemaRel = "models/schema.yaml";
    const memorySchema = snippetFrom(
      slug,
      pinnedFile(slug, schemaRel),
      schemaRel,
      "yaml",
      (raw) =>
        collapseBlanks(
          compressEntities(extractYamlListItems(raw, "entities", 1))
        ).join("\n")
    );

    const watcher = snippetFrom(
      slug,
      pinnedFile(slug, schemaRel),
      schemaRel,
      "yaml",
      (raw) =>
        collapseBlanks(
          compressWatcher(extractYamlListItems(raw, "watchers", 1))
        ).join("\n")
    );

    out[slug] = { connector, memorySchema, watcher };
  }
  return out;
}

function build(): LandingSnippets {
  const connector = snippetFrom(
    PINNED.connector.slug,
    pinnedFile(PINNED.connector.slug, PINNED.connector.path),
    PINNED.connector.path,
    "typescript"
  );
  warnOverBudget(
    `${PINNED.connector.slug}/${PINNED.connector.path}`,
    connector.code.split("\n").length,
    BUDGETS.connector
  );

  const memorySchema = snippetFrom(
    PINNED.memorySchema.slug,
    pinnedFile(PINNED.memorySchema.slug, PINNED.memorySchema.path),
    PINNED.memorySchema.path,
    "yaml",
    (raw) =>
      collapseBlanks(
        compressEntities(extractYamlListItems(raw, "entities", 1))
      ).join("\n")
  );
  warnOverBudget(
    `${PINNED.memorySchema.slug}/${PINNED.memorySchema.path} (entities)`,
    memorySchema.code.split("\n").length,
    BUDGETS.memorySchema
  );

  const watcher = snippetFrom(
    PINNED.watcher.slug,
    pinnedFile(PINNED.watcher.slug, PINNED.watcher.path),
    PINNED.watcher.path,
    "yaml",
    (raw) =>
      collapseBlanks(
        compressWatcher(extractYamlListItems(raw, "watchers", 1))
      ).join("\n")
  );
  warnOverBudget(
    `${PINNED.watcher.slug}/${PINNED.watcher.path} (watchers)`,
    watcher.code.split("\n").length,
    BUDGETS.watcher
  );

  const reaction = snippetFrom(
    PINNED.reaction.slug,
    pinnedFile(PINNED.reaction.slug, PINNED.reaction.path),
    PINNED.reaction.path,
    "typescript"
  );
  warnOverBudget(
    `${PINNED.reaction.slug}/${PINNED.reaction.path}`,
    reaction.code.split("\n").length,
    BUDGETS.reaction
  );

  const agentToml = snippetFrom(
    PINNED.agentToml.slug,
    pinnedFile(PINNED.agentToml.slug, PINNED.agentToml.path),
    PINNED.agentToml.path,
    "toml",
    trimAgentToml
  );
  warnOverBudget(
    `${PINNED.agentToml.slug}/${PINNED.agentToml.path}`,
    agentToml.code.split("\n").length,
    BUDGETS.agentToml
  );

  const skill = snippetFrom(
    PINNED.skill.slug,
    pinnedFile(PINNED.skill.slug, PINNED.skill.path),
    PINNED.skill.path,
    "markdown",
    trimSkillMarkdown
  );
  warnOverBudget(
    `${PINNED.skill.slug}/${PINNED.skill.path}`,
    skill.code.split("\n").length,
    BUDGETS.skill
  );

  return {
    connector,
    memorySchema,
    watcher,
    reaction,
    agentToml,
    skill,
    examples: listExamples(),
    useCases: buildUseCases(),
  };
}

function main() {
  const out = build();
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
  console.log(
    `gen-landing-snippets: wrote 6 pinned snippets + ${
      out.examples.length
    } example entries + ${
      Object.keys(out.useCases).length
    } per-use-case snippet sets to ${outFile}`
  );
}

main();
