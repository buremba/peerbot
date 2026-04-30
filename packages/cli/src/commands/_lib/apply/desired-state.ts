import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSettings, LobuTomlConfig, TomlAgentEntry } from "@lobu/core";
import { parse as parseToml } from "smol-toml";
import { ValidationError } from "../../memory/_lib/errors.js";
import {
  CONFIG_FILENAME,
  isLoadError,
  loadConfig,
} from "../../../config/loader.js";

// ── Stable connection IDs (mirror of file-loader.ts:56) ────────────────────
//
// keep in sync with packages/owletto-backend/src/gateway/config/file-loader.ts:56
function slugifyForConnectionId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// keep in sync with packages/owletto-backend/src/gateway/config/file-loader.ts:56
export function buildStableConnectionId(
  agentId: string,
  type: string,
  name?: string
): string {
  const parts = [slugifyForConnectionId(agentId), slugifyForConnectionId(type)];
  if (name) parts.push(slugifyForConnectionId(name));
  return parts.join("-");
}

// ── Desired state types ────────────────────────────────────────────────────

export interface DesiredAgentMetadata {
  agentId: string;
  name: string;
  description?: string;
}

export interface DesiredConnection {
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
  connections: DesiredConnection[];
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
    for (const conn of agentConfig.connections) {
      for (const value of Object.values(conn.config)) {
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

function buildAgentSettings(
  agentConfig: TomlAgentEntry,
  markdown: { identityMd?: string; soulMd?: string; userMd?: string }
): Partial<AgentSettings> {
  const settings: Partial<AgentSettings> = { ...markdown };

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

  // Network — agent-level only (skill merging happens server-side once
  // skills_config is patched. Pre-merging here would race the server's own
  // merge step.)
  const network = agentConfig.network;
  if (network) {
    const cfg: AgentSettings["networkConfig"] = {};
    if (network.allowed?.length) cfg.allowedDomains = [...network.allowed];
    if (network.denied?.length) cfg.deniedDomains = [...network.denied];
    if (network.judge?.length) cfg.judgedDomains = [...network.judge];
    if (network.judges && Object.keys(network.judges).length > 0) {
      cfg.judges = { ...network.judges };
    }
    if (Object.keys(cfg).length > 0) settings.networkConfig = cfg;
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

  // Nix
  if (agentConfig.worker?.nix_packages?.length) {
    settings.nixConfig = {
      packages: [...new Set(agentConfig.worker.nix_packages)],
    };
  }

  // MCP servers — agent-level only. Skill-derived MCP entries land server-side
  // once skills_config is patched. The on-wire shape extends McpServerConfig
  // with `oauth` + `authScope`, both of which the gateway store accepts as
  // pass-through JSON. Built as a typed-but-loose record because the core
  // McpServerConfig interface omits oauth/authScope.
  if (agentConfig.skills.mcp) {
    const mcpServers: Record<string, Record<string, unknown>> = {};
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
    if (Object.keys(mcpServers).length > 0) {
      settings.mcpServers = mcpServers as AgentSettings["mcpServers"];
    }
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
  connType: string,
  key: string,
  value: string,
  env: NodeJS.ProcessEnv
): string {
  const ref = asEnvRef(value);
  if (!ref) return value;
  const resolved = env[ref];
  if (resolved === undefined || resolved === "") {
    throw new ValidationError(
      `agent "${agentId}" connection "${connType}" config key "${key}" references $${ref}, but it is unset or empty in the apply environment`
    );
  }
  return resolved;
}

function buildConnections(
  agentId: string,
  agentConfig: TomlAgentEntry,
  env: NodeJS.ProcessEnv
): DesiredConnection[] {
  // Reject duplicate (type, name) pairs — same rule the file-loader enforces
  // so stable IDs stay collision-free.
  const seen = new Set<string>();
  const out: DesiredConnection[] = [];
  for (const conn of agentConfig.connections) {
    const key = `${conn.type}:${conn.name ?? ""}`;
    if (seen.has(key)) {
      throw new ValidationError(
        conn.name
          ? `agent "${agentId}" has duplicate connection (type=${conn.type}, name=${conn.name})`
          : `agent "${agentId}" has multiple "${conn.type}" connections — add a unique \`name = "..."\` to each to disambiguate`
      );
    }
    seen.add(key);
    const resolvedConfig: Record<string, string> = {};
    for (const [k, v] of Object.entries(conn.config)) {
      resolvedConfig[k] = resolveConfigValue(agentId, conn.type, k, v, env);
    }
    const desired: DesiredConnection = {
      stableId: buildStableConnectionId(agentId, conn.type, conn.name),
      type: conn.type,
      config: resolvedConfig,
    };
    if (conn.name) desired.name = conn.name;
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
    const settings = buildAgentSettings(agentConfig, markdown);
    const connections = buildConnections(agentId, agentConfig, env);
    const metadata: DesiredAgentMetadata = {
      agentId,
      name: agentConfig.name,
    };
    if (agentConfig.description) metadata.description = agentConfig.description;
    agents.push({ metadata, settings, connections });
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
