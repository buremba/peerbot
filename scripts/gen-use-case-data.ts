#!/usr/bin/env bun
/**
 * Reads all examples/ directories and generates
 * packages/landing/src/generated/use-case-models.ts
 *
 * Run: bun scripts/gen-use-case-data.ts
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dir, "..");
const EXAMPLES_DIR = join(ROOT, "examples");
const OUTPUT_PATH = join(
  ROOT,
  "packages/landing/src/generated/use-case-models.ts"
);

// ── Helpers ──────────────────────────────────────────────────────────

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

function readYamlFile<T = Record<string, unknown>>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  return parseYaml(readFileSync(filePath, "utf-8")) as T;
}

function readYamlDir<T = Record<string, unknown>>(dirPath: string): T[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => readYamlFile<T>(join(dirPath, f))!)
    .filter(Boolean);
}

interface ExampleOwlettoLayout {
  org: string;
  modelsPath: string;
}

function resolveOwlettoLayout(exampleDir: string): ExampleOwlettoLayout | null {
  const tomlPath = join(exampleDir, "lobu.toml");
  if (!existsSync(tomlPath)) return null;

  const toml = parseToml(readFileSync(tomlPath, "utf-8")) as {
    memory?: { owletto?: { enabled?: boolean; org?: string; models?: string } };
  };
  const memory = toml.memory?.owletto;
  if (!memory || memory.enabled === false) return null;
  const org = memory.org?.trim();
  if (!org) return null;

  const modelsRel = memory.models?.trim() || "./models";
  const modelsPath = resolve(exampleDir, modelsRel);
  return { org, modelsPath };
}

// ── Types — imported from Owletto schema ────────────────────────────

// Re-use the canonical types from the sibling owletto repo.
// If the owletto package is not available (e.g. CI), these minimal
// aliases cover the fields we actually read.
type EntityYaml =
  import("../../owletto/packages/cli/src/lib/schema.ts").EntitySchema;
type WatcherYaml =
  import("../../owletto/packages/cli/src/lib/schema.ts").WatcherSchema;

// ── TOML types ───────────────────────────────────────────────────────

interface TomlAgent {
  name: string;
  description?: string;
  dir?: string;
  providers?: Array<{ id: string; model: string; key: string }>;
  skills?: { enabled?: string[] };
  network?: { allowed?: string[] };
  worker?: { nix_packages?: string[] };
}

// ── Build one use case ───────────────────────────────────────────────

interface UseCaseModel {
  id: string;
  owlettoOrg: string;
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

function buildModel(exampleName: string): UseCaseModel | null {
  const exampleDir = join(EXAMPLES_DIR, exampleName);
  const layout = resolveOwlettoLayout(exampleDir);
  if (!layout) return null;

  const owlettoOrg = layout.org;

  type AnyModel = EntityYaml | WatcherYaml;
  const allModels = readYamlDir<AnyModel>(layout.modelsPath);
  const entities = allModels.filter(
    (m): m is EntityYaml => (m as Record<string, unknown>).type === "entity"
  );
  const entityNames = entities.map((e) => e.name);
  const watchers = allModels.filter(
    (m): m is WatcherYaml => (m as Record<string, unknown>).type === "watcher"
  );
  const firstWatcher = watchers[0];
  const watcher = firstWatcher
    ? {
        name: firstWatcher.name,
        schedule: firstWatcher.schedule,
        prompt: firstWatcher.prompt.trim(),
        extractionSchema: firstWatcher.extraction_schema
          ? JSON.stringify(firstWatcher.extraction_schema)
          : "",
      }
    : undefined;

  const tomlPath = join(exampleDir, "lobu.toml");
  let agentId = exampleName;
  let description = "";
  let enabledSkills: string[] = [];
  let allowedDomains: string[] = [];
  let nixPackages: string[] = [];
  let providerId = "";
  let model = "";
  let apiKeyEnv = "";
  let agentDirRel = "";

  if (existsSync(tomlPath)) {
    const tomlRaw = readFileSync(tomlPath, "utf-8");
    const toml = parseToml(tomlRaw) as { agents?: Record<string, TomlAgent> };

    if (toml.agents) {
      const firstKey = Object.keys(toml.agents)[0];
      const agent = toml.agents[firstKey];
      agentId = firstKey;
      description = agent.description || "";

      if (agent.dir) {
        agentDirRel = agent.dir.replace(/^\.\//, "");
      }

      if (agent.providers && agent.providers.length > 0) {
        const prov = agent.providers[0];
        providerId = prov.id;
        model = prov.model;
        apiKeyEnv = prov.key.replace(/^\$/, "");
      }

      enabledSkills = agent.skills?.enabled || [];
      allowedDomains = agent.network?.allowed || [];
      nixPackages = agent.worker?.nix_packages || [];
    }
  }

  const agentMdDir = agentDirRel
    ? join(exampleDir, agentDirRel)
    : join(exampleDir, "agents", exampleName);

  const identity = readLines(join(agentMdDir, "IDENTITY.md"), ["# Identity"]);
  const soul = readLines(join(agentMdDir, "SOUL.md"), [
    "# Instructions",
    "# Soul",
  ]);
  const user = readLines(join(agentMdDir, "USER.md"), ["# User Context"]);

  const skillInstructions = soul.filter((l) => l.trim().startsWith("- "));
  const mcpServer = enabledSkills.length > 0 ? enabledSkills[0] : "";

  return {
    id: exampleName,
    owlettoOrg,
    agent: { identity, soul, user },
    model: { entities: entityNames },
    skills: {
      agentId,
      skillId: agentId,
      description,
      skills: enabledSkills,
      nixPackages,
      allowedDomains,
      mcpServer,
      providerId,
      model,
      apiKeyEnv,
      skillInstructions,
    },
    watcher,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

const exampleDirs = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => resolveOwlettoLayout(join(EXAMPLES_DIR, name)) !== null)
  .sort();

const models: Record<string, UseCaseModel> = {};

for (const name of exampleDirs) {
  const m = buildModel(name);
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

export interface GeneratedUseCaseModel {
  id: string;
  owlettoOrg: string;
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
console.log(
  `Generated ${Object.keys(models).length} use case models → ${OUTPUT_PATH}`
);
