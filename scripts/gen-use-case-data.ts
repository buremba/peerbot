#!/usr/bin/env bun
/**
 * Reads all examples/ directories and generates
 * packages/landing/src/generated/use-case-models.ts
 *
 * Each example ships a `lobu.config.ts` (a `defineConfig(...)` default export
 * from `@lobu/cli/config`). We load it the same way the CLI does — via jiti, the
 * runtime TypeScript loader (see
 * `packages/cli/src/commands/_lib/apply/desired-state.ts` `loadProjectConfig`)
 * — and project the SDK `Project` shape down to the minimal model the landing
 * use-case page consumes.
 *
 * Run: bun scripts/gen-use-case-data.ts
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Project, ProviderConfig, Watcher } from "@lobu/cli/config";
import { isSecretRef } from "@lobu/cli/config";
import { createJiti } from "jiti";

const ROOT = resolve(import.meta.dir, "..");
const EXAMPLES_DIR = join(ROOT, "examples");
const OUTPUT_PATH = join(
  ROOT,
  "packages/landing/src/generated/use-case-models.ts"
);

// ── Config loading ───────────────────────────────────────────────────

/**
 * Import an example's `lobu.config.ts` and return its `defineConfig` default
 * export. Mirrors `loadProjectConfig` in the CLI: jiti transpiles the config on
 * import and resolves its `@lobu/cli/config` import from the monorepo. Returns null
 * when the example has no config (skipped, not an error).
 */
async function loadExampleConfig(exampleDir: string): Promise<Project | null> {
  const configPath = join(exampleDir, "lobu.config.ts");
  if (!existsSync(configPath)) return null;

  const jiti = createJiti(pathToFileURL(configPath).href);
  const project = (await jiti.import(configPath, { default: true })) as unknown;

  if (
    !project ||
    typeof project !== "object" ||
    (project as { kind?: unknown }).kind !== "project"
  ) {
    throw new Error(
      `${configPath} must \`export default defineConfig({ ... })\``
    );
  }
  return project as Project;
}

// ── Markdown reading ─────────────────────────────────────────────────

function readLines(filePath: string, skipHeaders: string[]): string[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  return raw.split("\n").filter((l) => {
    const trimmed = l.trim();
    if (trimmed === "") return false;
    for (const h of skipHeaders) {
      if (trimmed.toLowerCase() === h.toLowerCase()) return false;
    }
    return true;
  });
}

// ── Field extraction ─────────────────────────────────────────────────

/** Resolve a provider key (`secret("X")` ref or literal `$X`/`X`) to its env name. */
function envNameFromKey(key: ProviderConfig["key"]): string {
  if (key == null) return "";
  if (isSecretRef(key)) return key.$secret;
  if (typeof key === "string") return key.replace(/^\$/, "");
  return "";
}

function buildWatcher(watcher: Watcher | undefined) {
  if (!watcher) return undefined;
  return {
    name: watcher.name ?? watcher.slug,
    schedule: watcher.schedule ?? "",
    prompt: watcher.prompt.trim(),
    extractionSchema: watcher.extractionSchema
      ? JSON.stringify(watcher.extractionSchema)
      : "",
  };
}

// ── Build one use case ───────────────────────────────────────────────

interface UseCaseModel {
  id: string;
  lobuOrg: string;
  agent: { identity: string[]; soul: string[]; user: string[] };
  model: {
    entities: string[];
  };
  skills: {
    agentId: string;
    skillId: string;
    description: string;
    skills: string[];
    nixPackages: string[];
    allowedDomains: string[];
    mcpServer: string;
    providerId: string;
    model: string;
    apiKeyEnv: string;
    skillInstructions: string[];
  };
  watcher?: {
    name: string;
    schedule: string;
    prompt: string;
    extractionSchema: string;
  };
}

async function buildModel(exampleName: string): Promise<UseCaseModel | null> {
  const exampleDir = join(EXAMPLES_DIR, exampleName);
  const project = await loadExampleConfig(exampleDir);
  if (!project) return null;

  const lobuOrg = project.org?.trim();
  if (!lobuOrg) return null;

  const entityNames = (project.entities ?? []).map((e) => e.name ?? e.key);
  const watcher = buildWatcher(project.watchers?.[0]);

  const agent = project.agents[0];
  const agentId = agent?.id ?? exampleName;
  const description = agent?.description ?? "";

  const provider = agent?.providers?.[0];
  const providerId = provider?.id ?? "";
  const model = provider?.model ?? "";
  const apiKeyEnv = envNameFromKey(provider?.key);

  const allowedDomains = agent?.network?.allowed ?? [];
  const nixPackages = agent?.nixPackages ?? [];

  // Agent directory holding SOUL/IDENTITY/USER.md — `dir` or `./agents/<id>`,
  // matching the CLI loader (desired-state.ts loadDesiredStateFromConfig).
  const agentDirRel = (agent?.dir ?? join("agents", agentId)).replace(
    /^\.\//,
    ""
  );
  const agentMdDir = join(exampleDir, agentDirRel);

  const identity = readLines(join(agentMdDir, "IDENTITY.md"), ["# Identity"]);
  const soul = readLines(join(agentMdDir, "SOUL.md"), [
    "# Instructions",
    "# Soul",
  ]);
  const user = readLines(join(agentMdDir, "USER.md"), ["# User Context"]);

  const skillInstructions = soul.filter((l) => l.trim().startsWith("- "));

  return {
    id: exampleName,
    lobuOrg,
    agent: { identity, soul, user },
    model: { entities: entityNames },
    skills: {
      agentId,
      skillId: agentId,
      description,
      // The SDK config declares MCP/local skills via the agent dir + mcpServers,
      // not a flat enabled-skills list; the landing page only renders an empty
      // skills list today, so leave these unset.
      skills: [],
      nixPackages,
      allowedDomains,
      mcpServer: "",
      providerId,
      model,
      apiKeyEnv,
      skillInstructions,
    },
    watcher,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

const exampleNames = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => existsSync(join(EXAMPLES_DIR, name, "lobu.config.ts")))
  .sort();

const models: Record<string, UseCaseModel> = {};

for (const name of exampleNames) {
  const m = await buildModel(name);
  if (m) {
    models[name] = m;
  }
}

// ── Emit TypeScript ──────────────────────────────────────────────────

function toTs(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);

  if (value === null || value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value.includes("\n")) {
      return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => typeof v === "string" && !v.includes("\n"))) {
      const items = value.map((v) => JSON.stringify(v)).join(", ");
      if (items.length < 80) return `[${items}]`;
    }
    const lines = value.map((v) => `${padInner}${toTs(v, indent + 1)},`);
    return `[\n${lines.join("\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => {
      const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      return `${padInner}${key}: ${toTs(v, indent + 1)},`;
    });
    return `{\n${lines.join("\n")}\n${pad}}`;
  }
  return String(value);
}

const output = `// Auto-generated by scripts/gen-use-case-data.ts — do not edit
// Regenerate: bun scripts/gen-use-case-data.ts

interface GeneratedUseCaseModel {
  id: string;
  lobuOrg: string;
  agent: {
    identity: string[];
    soul: string[];
    user: string[];
  };
  model: {
    entities: string[];
  };
  skills: {
    agentId: string;
    skillId: string;
    description: string;
    skills: string[];
    nixPackages: string[];
    allowedDomains: string[];
    mcpServer: string;
    providerId: string;
    model: string;
    apiKeyEnv: string;
    skillInstructions: string[];
  };
  watcher?: {
    name: string;
    schedule: string;
    prompt: string;
    extractionSchema: string;
  };
}

export const generatedUseCaseModels: Record<string, GeneratedUseCaseModel> = ${toTs(models, 0)};
`;

const outDir = resolve(OUTPUT_PATH, "..");
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

writeFileSync(OUTPUT_PATH, output);

const format = spawnSync(
  "bunx",
  [
    "biome",
    "format",
    "--config-path",
    "config/biome.config.json",
    "--write",
    OUTPUT_PATH,
  ],
  { cwd: ROOT, stdio: "inherit" }
);
if (format.status !== 0) {
  process.exit(format.status ?? 1);
}

console.log(
  `Generated ${Object.keys(models).length} use case models → ${OUTPUT_PATH}`
);
