#!/usr/bin/env bun
/**
 * Reads pinned files out of `examples/` and emits a flat JSON manifest the
 * landing page imports at build time.
 *
 * The whole declarative project now lives in a single TypeScript file per
 * example: `examples/<slug>/lobu.config.ts` (using `@lobu/cli/config`:
 * `defineConfig`, `defineAgent`, `defineEntityType`, `defineWatcher`, ...).
 * The landing page shows SOURCE CODE, so we slice the raw `.ts` text into
 * budget-sized sections; we never import/execute the config.
 *
 * Every primitive section is pinned to the single `sales` example so the
 * homepage tells one coherent story (shown config-first on the page):
 *
 *   connector    -> examples/sales/salesforce-pipeline.connector.ts
 *   memorySchema -> examples/sales/lobu.config.ts        (defineEntityType slice)
 *   watcher      -> examples/sales/lobu.config.ts         (defineWatcher slice)
 *   reaction     -> examples/sales/account-health-monitor.reaction.ts
 *   agentConfig  -> examples/sales/lobu.config.ts         (imports + defineAgent slice)
 *   skill        -> examples/sales/skills/account-brief/SKILL.md
 *
 * Plus a list of every `examples/*\/lobu.config.ts` for BrowseExamplesSection:
 *
 *   examples     -> [{ slug, label, description, githubUrl }]
 *
 * And, under `useCases`, per-use-case connector / memorySchema / watcher
 * snippets keyed by the example dir slug. The /for/<useCase> SEO pages use
 * these route-specific snippets; the homepage stays pinned to sales. Hero
 * copy is not part of this manifest.
 *
 * Output: packages/landing/src/generated/landing-snippets.json
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(__dirname, "../../../examples");
const outFile = resolve(__dirname, "../src/generated/landing-snippets.json");

const CONFIG_FILE = "lobu.config.ts";

// Every pinned snippet comes from the one `sales` example so the homepage reads
// as a single coherent app (Salesforce connector -> account/renewal entities ->
// health watcher -> reaction -> agent + skill), shown config-first. The
// per-use-case route data (useCases below) still spans many examples for the
// /for/<useCase> SEO pages.
const PINNED = {
  connector: {
    slug: "sales",
    path: "salesforce-pipeline.connector.ts",
  },
  agentConfig: { slug: "sales" },
  memorySchema: { slug: "sales" },
  watcher: { slug: "sales" },
  reaction: {
    slug: "sales",
    path: "account-health-monitor.reaction.ts",
  },
  skill: {
    slug: "sales",
    path: "skills/account-brief/SKILL.md",
  },
} as const;

type Language = "typescript" | "markdown";

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
  agentConfig: Snippet;
  reaction: Snippet | null;
  skill: Snippet | null;
};

type LandingSnippets = {
  connector: Snippet;
  memorySchema: Snippet;
  watcher: Snippet;
  reaction: Snippet;
  agentConfig: Snippet;
  skill: Snippet;
  examples: ExampleEntry[];
  useCases: Record<string, UseCaseSnippets>;
};

/** Slugs that get per-use-case connector / memory / watcher snippets. The id
 *  equals the example directory name. Each dir has exactly one
 *  *.connector.ts and a lobu.config.ts. */
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
/*  TypeScript section slicing                                                */
/* -------------------------------------------------------------------------- */

/**
 * Slice the leading import section out of a config file: every contiguous
 * `import ...` statement (including `import type X from "./*.ts"`), tolerating
 * blank lines between them. Capturing the type imports too means generic
 * references shown in the snippet (e.g. `connectorFromFile<typeof X>`) resolve
 * to a visible import rather than reading as undefined symbols. Returns an
 * empty array if no import is found.
 */
function sliceImportBlock(raw: string): string[] {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => /^\s*import\b/.test(l));
  if (start < 0) return [];
  let end = start;
  let inStatement = true;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (inStatement) {
      end = i;
      if (/;\s*$/.test(line)) inStatement = false;
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      inStatement = true;
      end = i;
      if (/;\s*$/.test(line)) inStatement = false;
    } else if (line.trim() === "") {
      // tolerate blank lines between import statements
    } else {
      break;
    }
  }
  return lines.slice(start, end + 1);
}

/**
 * Slice the first `defineX(` call out of a config file by brace-balancing from
 * the opening `(` to the matching `)` (string-literal aware). The returned
 * lines include the leading `const name = ` (or `export default `) and the
 * trailing `);`. Returns an empty array if the call is not present.
 */
function sliceDefineCall(raw: string, fnName: string): string[] {
  const idx = raw.indexOf(`${fnName}(`);
  if (idx < 0) return [];
  // Walk back to the start of the statement (the `const`/`export` line start).
  let stmtStart = raw.lastIndexOf("\n", idx);
  stmtStart = stmtStart < 0 ? 0 : stmtStart + 1;

  // Brace-balance from the opening `(` of the call.
  let i = raw.indexOf("(", idx);
  let depth = 0;
  let str: '"' | "'" | "`" | null = null;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (str) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      str = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  // Include a trailing `;` if present.
  let end = i + 1;
  if (raw[end] === ";") end++;
  return raw.slice(stmtStart, end).split("\n");
}

/* -------------------------------------------------------------------------- */
/*  Example metadata (label + description) via regex over config text         */
/* -------------------------------------------------------------------------- */

type ConfigMeta = { label: string; description: string | null };

/** Pull a `key: "..."` string value from `defineConfig({...})`, tolerating the
 *  value sitting on the line after the key (Biome wraps long strings). */
function configStringField(raw: string, key: string): string | null {
  const re = new RegExp(`\\b${key}:\\s*\\n?\\s*("(?:[^"\\\\]|\\\\.)*")`);
  const m = re.exec(raw);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return m[1].slice(1, -1);
  }
}

function readConfigMeta(raw: string, slug: string): ConfigMeta {
  const orgName = configStringField(raw, "orgName");
  const orgDescription = configStringField(raw, "orgDescription");
  const fallbackLabel = slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
  return {
    label: orgName ?? fallbackLabel,
    description: orgDescription,
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function configSnippet(
  slug: string,
  transform: (raw: string) => string
): Snippet {
  const abs = pinnedFile(slug, CONFIG_FILE);
  const raw = readFileSync(abs, "utf-8");
  return {
    code: transform(raw).replace(/\s+$/, ""),
    path: CONFIG_FILE,
    githubUrl: githubFileUrl(slug, CONFIG_FILE),
    language: "typescript",
  };
}

function fileSnippet(
  slug: string,
  relativePath: string,
  language: Language,
  transform?: (raw: string) => string
): Snippet {
  const abs = pinnedFile(slug, relativePath);
  const raw = readFileSync(abs, "utf-8");
  const code = (transform ? transform(raw) : raw).replace(/\s+$/, "");
  return {
    code,
    path: relativePath,
    githubUrl: githubFileUrl(slug, relativePath),
    language,
  };
}

/** The imports + `defineAgent` + a real `defineWatcher` + the `defineConfig`
 *  manifest that wires connectors, entities, watchers, and agents together.
 *  Only the repetitive entity/relationship definitions are elided (behind a
 *  comment), so the snippet shows the differentiated piece (a watcher's prompt
 *  + extraction schema) and stays one coherent control-plane file. The
 *  homepage shows this as the single "it's real" anchor. */
function agentConfigSlice(raw: string): string {
  const imports = sliceImportBlock(raw);
  const agent = sliceDefineCall(raw, "defineAgent");
  const watcher = sliceDefineCall(raw, "defineWatcher");
  const config = sliceDefineCall(raw, "defineConfig");
  return [
    ...imports,
    "",
    ...agent,
    "",
    "// entity types and relationships defined here…",
    "",
    ...watcher,
    "",
    ...config,
  ].join("\n");
}

function entitySlice(raw: string): string {
  return sliceDefineCall(raw, "defineEntityType").join("\n");
}

function watcherSlice(raw: string): string {
  return sliceDefineCall(raw, "defineWatcher").join("\n");
}

/* -------------------------------------------------------------------------- */
/*  SKILL.md frontmatter extraction                                           */
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

    // A judge policy (`<name>: >` block scalar under judges): keep it as a
    // folded block scalar but cap it at the first 2 non-empty lines of the
    // real policy text so the snippet stays compact. Authors keep landing
    // policies <=2 lines so nothing is cut mid-sentence.
    const blockScalar = /^(\s*)([\w-]+):\s*[>|][+-]?\s*$/.exec(line);
    if (blockScalar) {
      const baseIndent = blockScalar[1].length;
      const policyName = blockScalar[2];
      out.push(`${" ".repeat(baseIndent)}${policyName}: >`);
      let kept = 0;
      let j = i + 1;
      while (j < fm.length) {
        const child = fm[j];
        if (child.trim() === "") {
          j++;
          continue;
        }
        const childIndent = child.length - child.trimStart().length;
        if (childIndent <= baseIndent) break;
        if (kept < 2) {
          out.push(child);
          kept++;
        }
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
    const configPath = resolve(examplesDir, slug, CONFIG_FILE);
    if (!existsSync(configPath)) continue;
    const raw = readFileSync(configPath, "utf-8");
    const { label, description } = readConfigMeta(raw, slug);
    out.push({ slug, label, description, githubUrl: githubTreeUrl(slug) });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

function findConnectorFile(slug: string): { rel: string } {
  const exampleDir = resolve(examplesDir, slug);
  const file = readdirSync(exampleDir).find((f) => f.endsWith(".connector.ts"));
  if (!file) throw new Error(`No *.connector.ts in ${exampleDir}`);
  return { rel: file };
}

function findReactionFile(slug: string): string | null {
  const exampleDir = resolve(examplesDir, slug);
  const file = readdirSync(exampleDir).find((f) => f.endsWith(".reaction.ts"));
  return file ?? null;
}

// First-party skills only — under examples/<slug>/skills/<name>/SKILL.md.
// Workspace-bundled .skills/ and node_modules SKILL.md are noise.
function findSkillFile(slug: string): string | null {
  const skillsDir = resolve(examplesDir, slug, "skills");
  if (!existsSync(skillsDir)) return null;
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const name of names) {
    const rel = `skills/${name}/SKILL.md`;
    if (existsSync(resolve(examplesDir, slug, rel))) return rel;
  }
  return null;
}

function buildUseCases(): Record<string, UseCaseSnippets> {
  const out: Record<string, UseCaseSnippets> = {};
  for (const slug of USE_CASE_SLUGS) {
    // Show the full connector file (imports + class + definition + sync), like
    // the pinned homepage connector. These read as complete TypeScript.
    const connector = fileSnippet(
      slug,
      findConnectorFile(slug).rel,
      "typescript"
    );
    const memorySchema = configSnippet(slug, entitySlice);
    const watcher = configSnippet(slug, watcherSlice);
    const agentConfig = configSnippet(slug, agentConfigSlice);
    const reactionRel = findReactionFile(slug);
    const reaction = reactionRel
      ? fileSnippet(slug, reactionRel, "typescript")
      : null;
    const skillRel = findSkillFile(slug);
    const skill = skillRel
      ? fileSnippet(slug, skillRel, "markdown", trimSkillMarkdown)
      : null;
    out[slug] = {
      connector,
      memorySchema,
      watcher,
      agentConfig,
      reaction,
      skill,
    };
  }
  return out;
}

function build(): LandingSnippets {
  const connector = fileSnippet(
    PINNED.connector.slug,
    PINNED.connector.path,
    "typescript"
  );
  const memorySchema = configSnippet(PINNED.memorySchema.slug, entitySlice);
  const watcher = configSnippet(PINNED.watcher.slug, watcherSlice);
  const reaction = fileSnippet(
    PINNED.reaction.slug,
    PINNED.reaction.path,
    "typescript"
  );
  const agentConfig = configSnippet(PINNED.agentConfig.slug, agentConfigSlice);
  const skill = fileSnippet(
    PINNED.skill.slug,
    PINNED.skill.path,
    "markdown",
    trimSkillMarkdown
  );

  return {
    connector,
    memorySchema,
    watcher,
    reaction,
    agentConfig,
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
