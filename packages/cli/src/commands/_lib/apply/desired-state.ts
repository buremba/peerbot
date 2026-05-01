import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSettings, LobuTomlConfig, TomlAgentEntry } from "@lobu/core";
import { parse as parseToml } from "smol-toml";
import { ValidationError } from "../../memory/_lib/errors.js";
import {
  CONFIG_FILENAME,
  isLoadError,
  loadConfig,
} from "../../../config/loader.js";

// ── Stable platform IDs (mirror of file-loader.ts) ─────────────────────────
//
// keep in sync with packages/server/src/gateway/config/file-loader.ts
function slugifyForPlatformId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// keep in sync with packages/server/src/gateway/config/file-loader.ts
export function buildStablePlatformId(
  agentId: string,
  type: string,
  name?: string
): string {
  const parts = [slugifyForPlatformId(agentId), slugifyForPlatformId(type)];
  if (name) parts.push(slugifyForPlatformId(name));
  return parts.join("-");
}

// ── Desired state types ────────────────────────────────────────────────────

export interface DesiredAgentMetadata {
  agentId: string;
  name: string;
  description?: string;
}

export interface DesiredPlatform {
  /** Stable, content-addressed ID derived from `(agentId, type, name?)`. */
  stableId: string;
  type: string;
  name?: string;
  /** Raw config from lobu.toml — values may still contain `$VAR` references. */
  config: Record<string, string>;
}

export interface DesiredEntityType {
  slug: string;
  name?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface DesiredRelationshipType {
  slug: string;
  name?: string;
  description?: string;
  rules?: Array<{ source: string; target: string }>;
  metadata?: Record<string, unknown>;
}

export interface DesiredAgent {
  metadata: DesiredAgentMetadata;
  /**
   * Settings payload destined for `PATCH /:agentId/config`. Built from the
   * lobu.toml fields the file-loader currently lifts: networkConfig,
   * skillsConfig, egressConfig, preApprovedTools, guardrails, toolsConfig,
   * nixConfig, mcpServers, modelSelection, providerModelPreferences,
   * installedProviders, identityMd/soulMd/userMd.
   *
   * Persistence of egressConfig/preApprovedTools/guardrails depends on PR-1.
   */
  settings: Partial<AgentSettings>;
  platforms: DesiredPlatform[];
}

export interface DesiredState {
  agents: DesiredAgent[];
  memorySchema: {
    entityTypes: DesiredEntityType[];
    relationshipTypes: DesiredRelationshipType[];
  };
  /**
   * Names of env vars referenced as `$NAME` anywhere in lobu.toml. The CLI
   * surfaces these to the user before mutating remote state so missing
   * secrets fail loud instead of expanding to empty strings.
   */
  requiredSecrets: string[];
}

// ── Load + transform ───────────────────────────────────────────────────────

const ENV_REF = /^\$([A-Z][A-Z0-9_]*)$/;

function asEnvRef(value: string): string | null {
  const match = ENV_REF.exec(value.trim());
  return match?.[1] ?? null;
}

function collectEnvRefs(config: LobuTomlConfig, out: Set<string>): void {
  for (const agentConfig of Object.values(config.agents)) {
    for (const provider of agentConfig.providers) {
      if (provider.key) {
        const ref = asEnvRef(provider.key);
        if (ref) out.add(ref);
      }
      if (provider.secret_ref) {
        const ref = asEnvRef(provider.secret_ref);
        if (ref) out.add(ref);
      }
    }
    for (const platform of agentConfig.platforms) {
      for (const value of Object.values(platform.config)) {
        const ref = asEnvRef(value);
        if (ref) out.add(ref);
      }
    }
    if (agentConfig.skills.mcp) {
      for (const mcp of Object.values(agentConfig.skills.mcp)) {
        if (mcp.headers) {
          for (const v of Object.values(mcp.headers)) {
            const ref = asEnvRef(v);
            if (ref) out.add(ref);
          }
        }
        if (mcp.env) {
          for (const v of Object.values(mcp.env)) {
            const ref = asEnvRef(v);
            if (ref) out.add(ref);
          }
        }
        if (mcp.oauth) {
          if (mcp.oauth.client_id) {
            const ref = asEnvRef(mcp.oauth.client_id);
            if (ref) out.add(ref);
          }
          if (mcp.oauth.client_secret) {
            const ref = asEnvRef(mcp.oauth.client_secret);
            if (ref) out.add(ref);
          }
        }
      }
    }
  }
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  nixPackages?: string[];
  network?: {
    allow?: string[];
    deny?: string[];
    judge?: Array<string | { domain: string; judge?: string }>;
  };
  judges?: Record<string, string>;
  mcpServers?: Record<
    string,
    {
      url?: string;
      type?: string;
      command?: string;
      args?: string[];
    }
  >;
}

interface LoadedSkillFile {
  name: string;
  content: string;
  frontmatter?: SkillFrontmatter;
}

function normalizeDomainPattern(pattern: string): string {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  if (trimmed.startsWith("*.")) return `.${trimmed.slice(2)}`;
  return trimmed;
}

function normalizeDomainPatterns(patterns?: string[]): string[] | undefined {
  if (!patterns?.length) return undefined;
  const normalized = [
    ...new Set(patterns.map(normalizeDomainPattern).filter(Boolean)),
  ];
  return normalized.length > 0 ? normalized : undefined;
}

async function parseSkillFrontmatter(raw: string): Promise<{
  frontmatter: SkillFrontmatter | null;
  body: string;
}> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match?.[1]) return { frontmatter: null, body: raw.trim() };
  const { parse: parseYaml } = await import("yaml");
  const parsed = parseYaml(match[1]) as SkillFrontmatter | null;
  return {
    frontmatter: parsed && typeof parsed === "object" ? parsed : null,
    body: (match[2] || "").trim(),
  };
}

async function loadSkillFiles(dirs: string[]): Promise<LoadedSkillFile[]> {
  const skillMap = new Map<string, LoadedSkillFile>();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await readdir(resolve(dir))).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry);
      let entryStat;
      try {
        entryStat = await stat(entryPath);
      } catch {
        continue;
      }

      if (entryStat.isDirectory()) {
        try {
          const raw = await readFile(join(entryPath, "SKILL.md"), "utf-8");
          if (!raw.trim()) continue;
          const { frontmatter, body } = await parseSkillFrontmatter(raw.trim());
          const name = frontmatter?.name || entry;
          skillMap.set(name, {
            name,
            content: body,
            ...(frontmatter ? { frontmatter } : {}),
          });
        } catch {
          // Directory without a SKILL.md is not a local skill.
        }
        continue;
      }

      if (!entry.endsWith(".md")) continue;
      try {
        const content = await readFile(entryPath, "utf-8");
        if (content.trim()) {
          skillMap.set(entry.slice(0, -3), {
            name: entry.slice(0, -3),
            content: content.trim(),
          });
        }
      } catch {
        // Skip unreadable files.
      }
    }
  }

  return Array.from(skillMap.values());
}

function buildLocalSkills(
  skillFiles: LoadedSkillFile[]
): NonNullable<AgentSettings["skillsConfig"]>["skills"] {
  return skillFiles.map((skillFile) => {
    const skill: NonNullable<AgentSettings["skillsConfig"]>["skills"][number] =
      {
        repo: `local/${skillFile.name}`,
        name: skillFile.name,
        content: skillFile.content,
        enabled: true,
      };
    const fm = skillFile.frontmatter;
    if (!fm) return skill;
    if (fm.description) skill.description = fm.description;
    if (fm.nixPackages?.length) skill.nixPackages = fm.nixPackages;
    if (fm.network || fm.judges) {
      const judgedDomains = (fm.network?.judge ?? []).map((entry) =>
        typeof entry === "string"
          ? { domain: normalizeDomainPattern(entry) }
          : {
              domain: normalizeDomainPattern(entry.domain),
              ...(entry.judge ? { judge: entry.judge } : {}),
            }
      );
      skill.networkConfig = {
        allowedDomains: normalizeDomainPatterns(fm.network?.allow),
        deniedDomains: normalizeDomainPatterns(fm.network?.deny),
        ...(judgedDomains.length > 0 ? { judgedDomains } : {}),
        ...(fm.judges ? { judges: fm.judges } : {}),
      };
    }
    if (fm.mcpServers && Object.keys(fm.mcpServers).length > 0) {
      skill.mcpServers = Object.entries(fm.mcpServers).map(([id, mcp]) => ({
        id,
        url: mcp.url,
        type: mcp.type as "sse" | "stdio" | undefined,
        command: mcp.command,
        args: mcp.args,
      }));
    }
    return skill;
  });
}

function buildAgentSettings(
  agentConfig: TomlAgentEntry,
  markdown: { identityMd?: string; soulMd?: string; userMd?: string },
  skillFiles: LoadedSkillFile[] = []
): Partial<AgentSettings> {
  const settings: Partial<AgentSettings> = { ...markdown };
  const localSkills = buildLocalSkills(skillFiles);
  if (localSkills.length > 0) {
    settings.skillsConfig = { skills: localSkills };
  }

  // Providers (ordered, index 0 = primary)
  if (agentConfig.providers.length > 0) {
    settings.installedProviders = agentConfig.providers.map((p) => ({
      providerId: p.id,
      installedAt: Date.now(),
    }));
    settings.modelSelection = { mode: "auto" };
    const providerModelPreferences = Object.fromEntries(
      agentConfig.providers
        .filter((p) => !!p.model?.trim())
        .map((p) => [p.id, p.model!.trim()])
    );
    if (Object.keys(providerModelPreferences).length > 0) {
      settings.providerModelPreferences = providerModelPreferences;
    }
  }

  // Network — merge agent-level config with local-skill declarations. Operator
  // policy in lobu.toml wins on named judges / judged-domain rules.
  const mergedAllowedDomains = [...(agentConfig.network?.allowed ?? [])];
  const mergedDeniedDomains = [...(agentConfig.network?.denied ?? [])];
  const mergedJudgedDomains = new Map<
    string,
    { domain: string; judge?: string }
  >();
  const mergedJudges: Record<string, string> = {};

  for (const skill of localSkills) {
    if (skill.networkConfig?.allowedDomains?.length) {
      mergedAllowedDomains.push(
        ...skill.networkConfig.allowedDomains.filter((domain) => domain !== "*")
      );
    }
    if (skill.networkConfig?.deniedDomains?.length) {
      mergedDeniedDomains.push(...skill.networkConfig.deniedDomains);
    }
    if (skill.networkConfig?.judgedDomains?.length) {
      for (const rule of skill.networkConfig.judgedDomains) {
        mergedJudgedDomains.set(rule.domain, rule);
      }
    }
    if (skill.networkConfig?.judges) {
      Object.assign(mergedJudges, skill.networkConfig.judges);
    }
  }

  if (agentConfig.network?.judge) {
    for (const rule of agentConfig.network.judge) {
      mergedJudgedDomains.set(rule.domain, rule);
    }
  }
  if (agentConfig.network?.judges) {
    Object.assign(mergedJudges, agentConfig.network.judges);
  }

  const hasJudgedDomains = mergedJudgedDomains.size > 0;
  const hasJudges = Object.keys(mergedJudges).length > 0;
  if (
    mergedAllowedDomains.length > 0 ||
    mergedDeniedDomains.length > 0 ||
    hasJudgedDomains ||
    hasJudges
  ) {
    settings.networkConfig = {
      ...(mergedAllowedDomains.length > 0
        ? { allowedDomains: [...new Set(mergedAllowedDomains)] }
        : {}),
      ...(mergedDeniedDomains.length > 0
        ? { deniedDomains: [...new Set(mergedDeniedDomains)] }
        : {}),
      ...(hasJudgedDomains
        ? { judgedDomains: Array.from(mergedJudgedDomains.values()) }
        : {}),
      ...(hasJudges ? { judges: mergedJudges } : {}),
    };
  }

  // Egress (PR-1 persists this column)
  if (agentConfig.egress) {
    const egressConfig: AgentSettings["egressConfig"] = {};
    if (agentConfig.egress.extra_policy) {
      egressConfig.extraPolicy = agentConfig.egress.extra_policy;
    }
    if (agentConfig.egress.judge_model) {
      egressConfig.judgeModel = agentConfig.egress.judge_model;
    }
    if (Object.keys(egressConfig).length > 0) {
      settings.egressConfig = egressConfig;
    }
  }

  // Tools — pre_approved + worker-side allow/deny/strict (PR-1 persists
  // preApprovedTools).
  if (agentConfig.tools) {
    if (agentConfig.tools.pre_approved?.length) {
      settings.preApprovedTools = [...new Set(agentConfig.tools.pre_approved)];
    }
    const toolsConfig: AgentSettings["toolsConfig"] = {};
    if (agentConfig.tools.allowed?.length) {
      toolsConfig.allowedTools = [...new Set(agentConfig.tools.allowed)];
    }
    if (agentConfig.tools.denied?.length) {
      toolsConfig.deniedTools = [...new Set(agentConfig.tools.denied)];
    }
    if (agentConfig.tools.strict !== undefined) {
      toolsConfig.strictMode = agentConfig.tools.strict;
    }
    if (Object.keys(toolsConfig).length > 0) {
      settings.toolsConfig = toolsConfig;
    }
  }

  // Guardrails (PR-1 persists this column)
  if (agentConfig.guardrails?.length) {
    settings.guardrails = [...new Set(agentConfig.guardrails)];
  }

  // Nix — merge agent-level packages with local-skill declarations.
  const mergedNixPackages = [
    ...(agentConfig.worker?.nix_packages ?? []),
    ...localSkills.flatMap((skill) => skill.nixPackages ?? []),
  ];
  if (mergedNixPackages.length > 0) {
    settings.nixConfig = {
      packages: [...new Set(mergedNixPackages)],
    };
  }

  // MCP servers — start with agent-level toml config, then merge local-skill
  // entries without overriding operator-defined IDs.
  const mcpServers: Record<string, Record<string, unknown>> = {};
  if (agentConfig.skills.mcp) {
    for (const [id, mcp] of Object.entries(agentConfig.skills.mcp)) {
      const mapped: Record<string, unknown> = {};
      if (mcp.url) mapped.url = mcp.url;
      if (mcp.command) mapped.command = mcp.command;
      if (mcp.args) mapped.args = mcp.args;
      if (mcp.headers) mapped.headers = mcp.headers;
      if (mcp.auth_scope) mapped.authScope = mcp.auth_scope;
      if (mcp.oauth) {
        mapped.oauth = {
          authUrl: mcp.oauth.auth_url,
          tokenUrl: mcp.oauth.token_url,
          ...(mcp.oauth.client_id ? { clientId: mcp.oauth.client_id } : {}),
          ...(mcp.oauth.client_secret
            ? { clientSecret: mcp.oauth.client_secret }
            : {}),
          ...(mcp.oauth.scopes ? { scopes: mcp.oauth.scopes } : {}),
          ...(mcp.oauth.token_endpoint_auth_method
            ? {
                tokenEndpointAuthMethod: mcp.oauth.token_endpoint_auth_method,
              }
            : {}),
        };
      }
      if (mcp.env) mapped.env = { ...mcp.env };
      mcpServers[id] = mapped;
    }
  }
  for (const skill of localSkills) {
    for (const mcp of skill.mcpServers ?? []) {
      if (mcpServers[mcp.id]) continue;
      mcpServers[mcp.id] = {
        ...(mcp.url ? { url: mcp.url } : {}),
        ...(mcp.type ? { type: mcp.type } : {}),
        ...(mcp.command ? { command: mcp.command } : {}),
        ...(mcp.args ? { args: mcp.args } : {}),
      };
    }
  }
  if (Object.keys(mcpServers).length > 0) {
    settings.mcpServers = mcpServers as AgentSettings["mcpServers"];
  }

  return settings;
}

async function readMarkdown(
  agentDir: string
): Promise<{ identityMd?: string; soulMd?: string; userMd?: string }> {
  const result: { identityMd?: string; soulMd?: string; userMd?: string } = {};
  const files: Array<["identityMd" | "soulMd" | "userMd", string]> = [
    ["identityMd", "IDENTITY.md"],
    ["soulMd", "SOUL.md"],
    ["userMd", "USER.md"],
  ];
  for (const [key, filename] of files) {
    try {
      const content = await readFile(join(agentDir, filename), "utf-8");
      if (content.trim()) result[key] = content.trim();
    } catch {
      // missing file is fine
    }
  }
  return result;
}

function resolveConfigValue(
  agentId: string,
  platformType: string,
  key: string,
  value: string,
  env: NodeJS.ProcessEnv
): string {
  const ref = asEnvRef(value);
  if (!ref) return value;
  const resolved = env[ref];
  if (resolved === undefined || resolved === "") {
    throw new ValidationError(
      `agent "${agentId}" platform "${platformType}" config key "${key}" references $${ref}, but it is unset or empty in the apply environment`
    );
  }
  return resolved;
}

function buildPlatforms(
  agentId: string,
  agentConfig: TomlAgentEntry,
  env: NodeJS.ProcessEnv
): DesiredPlatform[] {
  // Reject duplicate (type, name) pairs — same rule the file-loader enforces
  // so stable IDs stay collision-free.
  const seen = new Set<string>();
  const out: DesiredPlatform[] = [];
  for (const platform of agentConfig.platforms) {
    const key = `${platform.type}:${platform.name ?? ""}`;
    if (seen.has(key)) {
      throw new ValidationError(
        platform.name
          ? `agent "${agentId}" has duplicate platform (type=${platform.type}, name=${platform.name})`
          : `agent "${agentId}" has multiple "${platform.type}" platforms — add a unique \`name = "..."\` to each to disambiguate`
      );
    }
    seen.add(key);
    const resolvedConfig: Record<string, string> = {};
    for (const [k, v] of Object.entries(platform.config)) {
      resolvedConfig[k] = resolveConfigValue(agentId, platform.type, k, v, env);
    }
    const desired: DesiredPlatform = {
      stableId: buildStablePlatformId(agentId, platform.type, platform.name),
      type: platform.type,
      config: resolvedConfig,
    };
    if (platform.name) desired.name = platform.name;
    out.push(desired);
  }
  return out;
}

interface RawMemorySchema {
  entity_types?: unknown;
  relationship_types?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntityType(raw: unknown): DesiredEntityType {
  if (!isRecord(raw) || typeof raw.slug !== "string") {
    throw new ValidationError(
      `memory.entity_types entries must be objects with a "slug" string field; got ${JSON.stringify(raw)}`
    );
  }
  const out: DesiredEntityType = { slug: raw.slug };
  if (typeof raw.name === "string") out.name = raw.name;
  if (typeof raw.description === "string") out.description = raw.description;
  if (Array.isArray(raw.required)) {
    out.required = raw.required.filter(
      (v): v is string => typeof v === "string"
    );
  }
  if (isRecord(raw.properties)) out.properties = raw.properties;
  if (isRecord(raw.metadata)) out.metadata = raw.metadata;
  return out;
}

function parseRelationshipType(raw: unknown): DesiredRelationshipType {
  if (!isRecord(raw) || typeof raw.slug !== "string") {
    throw new ValidationError(
      `memory.relationship_types entries must be objects with a "slug" string field; got ${JSON.stringify(raw)}`
    );
  }
  const out: DesiredRelationshipType = { slug: raw.slug };
  if (typeof raw.name === "string") out.name = raw.name;
  if (typeof raw.description === "string") out.description = raw.description;
  if (Array.isArray(raw.rules)) {
    out.rules = raw.rules
      .filter(isRecord)
      .filter(
        (
          rule
        ): rule is { source: string; target: string } & Record<
          string,
          unknown
        > => typeof rule.source === "string" && typeof rule.target === "string"
      )
      .map((rule) => ({ source: rule.source, target: rule.target }));
  }
  if (isRecord(raw.metadata)) out.metadata = raw.metadata;
  return out;
}

/**
 * Read memory schema files referenced by `[memory.owletto].models`. Each YAML
 * file in that directory should declare `type: entity_type` or
 * `type: relationship_type` (matches the seed-cmd schema).
 *
 * v1: parse only entity_type and relationship_type. Watchers are deferred.
 */
async function loadMemorySchema(
  config: LobuTomlConfig,
  projectRoot: string
): Promise<DesiredState["memorySchema"]> {
  const empty = { entityTypes: [], relationshipTypes: [] };
  const owletto = config.memory?.owletto;
  if (!owletto || owletto.enabled === false) return empty;

  const inline = config.memory as unknown as
    | { schema?: RawMemorySchema }
    | undefined;
  if (inline?.schema) {
    const entityTypesRaw = Array.isArray(inline.schema.entity_types)
      ? inline.schema.entity_types
      : [];
    const relTypesRaw = Array.isArray(inline.schema.relationship_types)
      ? inline.schema.relationship_types
      : [];
    return {
      entityTypes: entityTypesRaw.map(parseEntityType),
      relationshipTypes: relTypesRaw.map(parseRelationshipType),
    };
  }

  // Models directory (matches seed-cmd's resolution rules).
  const modelsRel = owletto.models?.trim() || "./models";
  const modelsPath = resolve(projectRoot, modelsRel);

  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { parse: parseYaml } = await import("yaml");

  if (!existsSync(modelsPath)) return empty;

  const entityTypes: DesiredEntityType[] = [];
  const relationshipTypes: DesiredRelationshipType[] = [];

  const files = readdirSync(modelsPath)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  for (const file of files) {
    const raw = readFileSync(join(modelsPath, file), "utf-8");
    const parsed = parseYaml(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
    if (parsed.type === "entity_type" || parsed.type === "entity") {
      entityTypes.push(parseEntityType(parsed));
    } else if (
      parsed.type === "relationship_type" ||
      parsed.type === "relationship"
    ) {
      relationshipTypes.push(parseRelationshipType(parsed));
    }
    // watcher files are out of scope for v1 apply
  }

  return { entityTypes, relationshipTypes };
}

/**
 * The Zod schema strips unknown keys, so we re-parse the raw TOML to surface
 * shapes the validated config can't see. Detecting `[[agents.<id>.watchers]]`
 * here keeps users from silently shipping a config block that v1 ignores.
 */
async function rejectUnsupportedAgentShapes(cwd: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, CONFIG_FILENAME), "utf-8");
  } catch {
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    // loadConfig already surfaces parse errors — bail without throwing here.
    return;
  }
  const agents = parsed.agents;
  if (!agents || typeof agents !== "object") return;
  for (const [agentId, agentConfig] of Object.entries(
    agents as Record<string, unknown>
  )) {
    if (!agentConfig || typeof agentConfig !== "object") continue;
    const watchers = (agentConfig as Record<string, unknown>).watchers;
    if (Array.isArray(watchers) && watchers.length > 0) {
      throw new ValidationError(
        `agent "${agentId}" declares [[agents.${agentId}.watchers]] — \`lobu apply\` does not sync watchers in v1. Remove the block or use \`lobu memory seed\`.`
      );
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface LoadDesiredStateOptions {
  /** Project root (directory containing `lobu.toml`). */
  cwd: string;
  /** Env to resolve `$VAR` refs against; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export async function loadDesiredState(
  opts: LoadDesiredStateOptions
): Promise<{ state: DesiredState; configPath: string }> {
  const result = await loadConfig(opts.cwd);
  if (isLoadError(result)) {
    const detail = result.details?.length
      ? `${result.error}\n  ${result.details.join("\n  ")}`
      : result.error;
    throw new ValidationError(detail);
  }

  const { config, path: configPath } = result;
  await rejectUnsupportedAgentShapes(opts.cwd);

  const env = opts.env ?? process.env;
  const requiredSecrets = new Set<string>();
  collectEnvRefs(config, requiredSecrets);

  const agents: DesiredAgent[] = [];
  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    const agentDir = resolve(opts.cwd, agentConfig.dir);
    const markdown = await readMarkdown(agentDir);
    const skillFiles = await loadSkillFiles([
      join(opts.cwd, "skills"),
      join(agentDir, "skills"),
    ]);
    const settings = buildAgentSettings(agentConfig, markdown, skillFiles);
    const platforms = buildPlatforms(agentId, agentConfig, env);
    const metadata: DesiredAgentMetadata = {
      agentId,
      name: agentConfig.name,
    };
    if (agentConfig.description) metadata.description = agentConfig.description;
    agents.push({ metadata, settings, platforms });
  }

  const memorySchema = await loadMemorySchema(config, opts.cwd);

  return {
    state: {
      agents,
      memorySchema,
      requiredSecrets: [...requiredSecrets].sort(),
    },
    configPath,
  };
}
