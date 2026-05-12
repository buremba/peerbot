import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ConnectorAuthSchema,
  ConnectorDefinition,
  FeedDefinition,
} from "@lobu/connector-sdk";
import type { AgentSettings, LobuTomlConfig, TomlAgentEntry } from "@lobu/core";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parse as parseToml } from "smol-toml";
import { ValidationError } from "../../memory/_lib/errors.js";
import {
  CONFIG_FILENAME,
  isLoadError,
  loadConfig,
} from "../../../config/loader.js";
import { CronExpressionParser } from "cron-parser";

// ── Connector slug / schedule validators (round-2) ─────────────────────────
// Mirror packages/server/src/utils/connections.ts CONNECTION_SLUG_PATTERN and
// the server's validateSchedule (packages/server/src/utils/cron.ts) so the CLI
// fails loud *before* any mutation instead of getting a server 4xx.
const CONNECTION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// auth_profiles slugs are sanitized server-side; require canonical form so the
// diff key matches what is stored (server cap is 80 chars).
const AUTH_PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MIN_CRON_INTERVAL_MS = 60_000;

function cronError(schedule: string): string | null {
  try {
    const it = CronExpressionParser.parse(schedule);
    const first = it.next().toDate();
    const second = it.next().toDate();
    if (second.getTime() - first.getTime() < MIN_CRON_INTERVAL_MS) {
      return `schedule "${schedule}" is too frequent (minimum interval is 1 minute)`;
    }
    return null;
  } catch (err) {
    return `invalid cron expression "${schedule}" — ${err instanceof Error ? err.message : String(err)}`;
  }
}

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

export interface DesiredWatcher {
  slug: string;
  name?: string;
  description?: string;
  schedule?: string;
  prompt: string;
  /** Parsed JSON Schema object describing the LLM output. */
  extractionSchema: Record<string, unknown>;
  /** Optional SQL data sources; server applies a default when omitted. */
  sources?: Array<{ name: string; query: string }>;
}

export interface DesiredFeed {
  /** Feed key from the connector definition (`FeedDefinition.key`). */
  feedKey: string;
  name?: string;
  schedule?: string;
  config?: Record<string, unknown>;
}

export interface DesiredConnection {
  /** Stable public identifier — diff key. */
  slug: string;
  /** Connector key (e.g. `github`, `hackernews`). */
  connector: string;
  name?: string;
  /** Slug of the runtime/account auth profile (`auth:` in the manifest). */
  authProfileSlug?: string;
  /** Slug of the OAuth-app auth profile (`app_auth:` in the manifest). */
  appAuthProfileSlug?: string;
  config?: Record<string, unknown>;
  feeds: DesiredFeed[];
  /** Relative path of the YAML file the doc came from (for error messages). */
  sourceFile: string;
}

export type DesiredAuthProfileKind =
  | "env"
  | "oauth_app"
  | "oauth_account"
  | "browser_session";

export interface DesiredAuthProfile {
  /** Stable slug — diff key. */
  slug: string;
  connector: string;
  kind: DesiredAuthProfileKind;
  name?: string;
  /**
   * key→value credentials. Values may be `$ENV` references (collected into
   * `requiredSecrets`). Only meaningful for `kind: env | oauth_app`; must be
   * absent/empty for `oauth_account | browser_session`.
   */
  credentials?: Record<string, string>;
  sourceFile: string;
}

export interface DesiredConnectorDefinition {
  /** Connector key — diff key (`null` until the server compiles a `.ts`). */
  key: string | null;
  /** Local `.ts` path (absolute) — mutually exclusive with `sourceUrl`. */
  sourcePath?: string;
  /** Remote URL — mutually exclusive with `sourcePath`. */
  sourceUrl?: string;
  /**
   * Raw TypeScript source read from `sourcePath`, pushed verbatim to the
   * server (which compiles, extracts metadata, and returns the real `key`).
   * Absent when `sourceUrl` is used.
   */
  sourceCode?: string;
  /** For error messages — the `.connector.ts` file or `type: connector` doc. */
  sourceFile: string;
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
  /** Watchers declared as `type: watcher` in `models/*.yaml`. */
  watchers: DesiredWatcher[];
  /**
   * Data-source connectors declared in `[memory].connectors` dir:
   * `*.connector.ts` files (+ `type: connector` manifests), `type: connection`
   * docs, and `type: auth_profile` docs.
   */
  connectors: {
    definitions: DesiredConnectorDefinition[];
    authProfiles: DesiredAuthProfile[];
    connections: DesiredConnection[];
  };
  /**
   * Names of env vars referenced as `$NAME` anywhere in lobu.toml or in
   * connector auth-profile credentials. The CLI surfaces these to the user
   * before mutating remote state so missing secrets fail loud instead of
   * expanding to empty strings.
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

function parseWatcher(raw: unknown): DesiredWatcher {
  if (!isRecord(raw) || typeof raw.slug !== "string") {
    throw new ValidationError(
      `watcher model files must be objects with a "slug" string field; got ${JSON.stringify(raw)}`
    );
  }
  if (typeof raw.prompt !== "string" || !raw.prompt.trim()) {
    throw new ValidationError(
      `watcher "${raw.slug}" is missing a "prompt" string`
    );
  }
  const extractionSchema = isRecord(raw.extraction_schema)
    ? raw.extraction_schema
    : {};
  const out: DesiredWatcher = {
    slug: raw.slug,
    prompt: raw.prompt,
    extractionSchema,
  };
  if (typeof raw.name === "string") out.name = raw.name;
  if (typeof raw.description === "string") out.description = raw.description;
  if (typeof raw.schedule === "string") out.schedule = raw.schedule;
  if (Array.isArray(raw.sources)) {
    out.sources = raw.sources
      .filter(isRecord)
      .filter(
        (s): s is { name: string; query: string } & Record<string, unknown> =>
          typeof s.name === "string" && typeof s.query === "string"
      )
      .map((s) => ({ name: s.name, query: s.query }));
  }
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

interface LoadedMemoryModels {
  entityTypes: DesiredEntityType[];
  relationshipTypes: DesiredRelationshipType[];
  watchers: DesiredWatcher[];
}

/**
 * Read memory schema files referenced by `[memory].models`. Each YAML
 * file in that directory should declare `type: entity_type`,
 * `type: relationship_type`, or `type: watcher` (matches the seed-cmd
 * schema). `lobu apply` syncs entity types, relationship types, and
 * watchers from these files; watcher sync is create-only (drift ignored).
 */
async function loadMemoryModels(
  config: LobuTomlConfig,
  projectRoot: string
): Promise<LoadedMemoryModels> {
  const empty: LoadedMemoryModels = {
    entityTypes: [],
    relationshipTypes: [],
    watchers: [],
  };
  const mem = config.memory;
  if (!mem || mem.enabled === false) return empty;

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
      watchers: [],
    };
  }

  // Models directory (matches seed-cmd's resolution rules).
  const modelsRel = mem.models?.trim() || "./models";
  const modelsPath = resolve(projectRoot, modelsRel);

  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { parse: parseYaml } = await import("yaml");

  if (!existsSync(modelsPath)) return empty;

  const entityTypes: DesiredEntityType[] = [];
  const relationshipTypes: DesiredRelationshipType[] = [];
  const watchers: DesiredWatcher[] = [];

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
    } else if (parsed.type === "watcher") {
      watchers.push(parseWatcher(parsed));
    }
  }

  return { entityTypes, relationshipTypes, watchers };
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
        `agent "${agentId}" declares [[agents.${agentId}.watchers]] — \`lobu apply\` syncs watchers from \`models/*.yaml\` (\`type: watcher\`), not from lobu.toml. Move the watcher to a model file or use \`lobu memory seed\`.`
      );
    }
  }
}

// ── Connectors (data-source connectors) ───────────────────────────────────

const AUTH_PROFILE_KINDS: ReadonlySet<string> = new Set([
  "env",
  "oauth_app",
  "oauth_account",
  "browser_session",
]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseConnectionDoc(
  raw: Record<string, unknown>,
  file: string
): DesiredConnection {
  const slug = asString(raw.slug);
  if (!slug) {
    throw new ValidationError(
      `${file}: \`type: connection\` doc is missing a "slug" string`
    );
  }
  if (!CONNECTION_SLUG_PATTERN.test(slug)) {
    throw new ValidationError(
      `${file}: connection slug "${slug}" must match /^[a-z0-9][a-z0-9-]{0,62}$/ (lowercase letters/digits/hyphens, no leading hyphen, ≤63 chars)`
    );
  }
  const connector = asString(raw.connector);
  if (!connector) {
    throw new ValidationError(
      `${file}: connection "${slug}" is missing a "connector" key`
    );
  }
  const out: DesiredConnection = {
    slug,
    connector,
    feeds: [],
    sourceFile: file,
  };
  const name = asString(raw.name);
  if (name) out.name = name;
  const auth = asString(raw.auth);
  if (auth) out.authProfileSlug = auth;
  const appAuth = asString(raw.app_auth);
  if (appAuth) out.appAuthProfileSlug = appAuth;
  if (raw.config !== undefined) {
    if (!isRecord(raw.config)) {
      throw new ValidationError(
        `${file}: connection "${slug}" \`config\` must be an object`
      );
    }
    out.config = raw.config;
  }
  if (raw.feeds !== undefined) {
    if (!Array.isArray(raw.feeds)) {
      throw new ValidationError(
        `${file}: connection "${slug}" \`feeds\` must be an array`
      );
    }
    const seen = new Set<string>();
    for (const entry of raw.feeds) {
      if (!isRecord(entry)) {
        throw new ValidationError(
          `${file}: connection "${slug}" feed entries must be objects`
        );
      }
      const feedKey = asString(entry.feed);
      if (!feedKey) {
        throw new ValidationError(
          `${file}: connection "${slug}" feed entry is missing a "feed" key`
        );
      }
      if (seen.has(feedKey)) {
        throw new ValidationError(
          `${file}: connection "${slug}" declares feed "${feedKey}" twice`
        );
      }
      seen.add(feedKey);
      const feed: DesiredFeed = { feedKey };
      const feedName = asString(entry.name);
      if (feedName) feed.name = feedName;
      const schedule = asString(entry.schedule);
      if (schedule) {
        const err = cronError(schedule);
        if (err) {
          throw new ValidationError(
            `${file}: connection "${slug}" feed "${feedKey}" ${err}`
          );
        }
        feed.schedule = schedule;
      }
      if (entry.config !== undefined) {
        if (!isRecord(entry.config)) {
          throw new ValidationError(
            `${file}: connection "${slug}" feed "${feedKey}" \`config\` must be an object`
          );
        }
        feed.config = entry.config;
      }
      out.feeds.push(feed);
    }
  }
  return out;
}

function parseAuthProfileDoc(
  raw: Record<string, unknown>,
  file: string
): DesiredAuthProfile {
  const slug = asString(raw.slug);
  if (!slug) {
    throw new ValidationError(
      `${file}: \`type: auth_profile\` doc is missing a "slug" string`
    );
  }
  if (!AUTH_PROFILE_SLUG_PATTERN.test(slug)) {
    throw new ValidationError(
      `${file}: auth_profile slug "${slug}" must match /^[a-z0-9][a-z0-9-]{0,79}$/ (lowercase letters/digits/hyphens, no leading hyphen, ≤80 chars)`
    );
  }
  const connector = asString(raw.connector);
  if (!connector) {
    throw new ValidationError(
      `${file}: auth_profile "${slug}" is missing a "connector" key`
    );
  }
  const kind = asString(raw.kind);
  if (!kind || !AUTH_PROFILE_KINDS.has(kind)) {
    throw new ValidationError(
      `${file}: auth_profile "${slug}" \`kind\` must be one of env|oauth_app|oauth_account|browser_session (got ${JSON.stringify(raw.kind)})`
    );
  }
  const out: DesiredAuthProfile = {
    slug,
    connector,
    kind: kind as DesiredAuthProfileKind,
    sourceFile: file,
  };
  const name = asString(raw.name);
  if (name) out.name = name;
  if (raw.credentials !== undefined) {
    if (!isRecord(raw.credentials)) {
      throw new ValidationError(
        `${file}: auth_profile "${slug}" \`credentials\` must be an object`
      );
    }
    const creds: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.credentials)) {
      if (typeof v !== "string") {
        throw new ValidationError(
          `${file}: auth_profile "${slug}" credential "${k}" must be a string (use $ENV for secrets)`
        );
      }
      creds[k] = v;
    }
    if (kind === "oauth_account" || kind === "browser_session") {
      if (Object.keys(creds).length > 0) {
        throw new ValidationError(
          `${file}: auth_profile "${slug}" has \`kind: ${kind}\` — credentials must not be set; \`lobu apply\` never writes interactive-auth tokens (complete auth via the connect URL).`
        );
      }
    } else {
      out.credentials = creds;
    }
  }
  return out;
}

function parseConnectorDoc(
  raw: Record<string, unknown>,
  file: string
): { key: string; sourcePath?: string; sourceUrl?: string } {
  const key = asString(raw.key);
  if (!key) {
    throw new ValidationError(
      `${file}: \`type: connector\` doc is missing a "key" string`
    );
  }
  const sourcePath = asString(raw.source_path);
  const sourceUrl = asString(raw.source_url);
  if (!!sourcePath === !!sourceUrl) {
    throw new ValidationError(
      `${file}: connector "${key}" must declare exactly one of \`source_path\` or \`source_url\``
    );
  }
  if (sourceUrl) {
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new ValidationError(
        `${file}: connector "${key}" source_url is not a valid URL: ${sourceUrl}`
      );
    }
    if (parsed.protocol !== "https:") {
      throw new ValidationError(
        `${file}: connector "${key}" source_url must use https (got ${parsed.protocol}//)`
      );
    }
  }
  return {
    key,
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

interface LoadedConnectors {
  definitions: DesiredConnectorDefinition[];
  authProfiles: DesiredAuthProfile[];
  connections: DesiredConnection[];
}

const EMPTY_CONNECTORS: LoadedConnectors = {
  definitions: [],
  authProfiles: [],
  connections: [],
};

/**
 * Load the `[memory].connectors` directory:
 *  - every `*.connector.ts` is auto-discovered as a connector definition
 *    (raw source pushed to the server, which compiles + extracts the key)
 *  - `*.yaml` files are multi-doc (`---`-separated); each doc carries
 *    `version: 1` and a `type:` of `connection`, `auth_profile`, or `connector`
 *
 * `connector:` config validation against the connector's `optionsSchema` /
 * feed `configSchema` / `authSchema` happens later (in `apply-cmd`) once the
 * remote connector-definition catalog is available — the CLI never compiles
 * connectors locally.
 */
async function loadConnectors(
  config: LobuTomlConfig,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  envRefs: Set<string>
): Promise<LoadedConnectors> {
  const mem = config.memory;
  if (!mem || mem.enabled === false) return EMPTY_CONNECTORS;
  const dirRel = mem.connectors?.trim() || "./connectors";
  const dirPath = resolve(projectRoot, dirRel);

  let entries: string[];
  try {
    entries = (await readdir(dirPath)).sort();
  } catch {
    return EMPTY_CONNECTORS;
  }

  const { parseAllDocuments } = await import("yaml");

  const definitionsByKey = new Map<string, DesiredConnectorDefinition>();
  // Keys explicitly declared by a `type: connector` doc (vs auto-discovered
  // from a `*.connector.ts` filename). A given connector key may be declared by
  // at most one such doc — even two docs pointing at the same `source_path`.
  const connectorDocKeyDeclaredBy = new Map<string, string>();
  // `.connector.ts` files keyed by their *absolute path* — we don't know the
  // connector key until the server compiles them. `type: connector` docs with
  // `source_path:` that point at one of these files just dedupe to the file.
  const tsFileDefinitions = new Map<string, DesiredConnectorDefinition>();
  const authProfiles = new Map<string, DesiredAuthProfile>();
  const connections = new Map<string, DesiredConnection>();

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    let entryStat;
    try {
      entryStat = await stat(entryPath);
    } catch {
      continue;
    }
    if (!entryStat.isFile()) continue;

    // Auto-discovered local connector definition.
    if (entry.endsWith(".connector.ts")) {
      const sourceCode = await readFile(entryPath, "utf-8");
      tsFileDefinitions.set(entryPath, {
        key: null,
        sourcePath: entryPath,
        sourceCode,
        sourceFile: `${dirRel}/${entry}`,
      });
      continue;
    }

    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;

    const rel = `${dirRel}/${entry}`;
    const raw = await readFile(entryPath, "utf-8");
    let docs: unknown[];
    try {
      docs = parseAllDocuments(raw)
        .map((doc) => doc.toJSON() as unknown)
        .filter((doc) => doc !== null && doc !== undefined);
    } catch (err) {
      throw new ValidationError(
        `${rel}: failed to parse YAML — ${err instanceof Error ? err.message : String(err)}`
      );
    }

    for (const doc of docs) {
      if (!isRecord(doc)) {
        throw new ValidationError(
          `${rel}: each connectors doc must be a mapping with \`version\` and \`type\``
        );
      }
      const type = asString(doc.type);
      if (!type) {
        throw new ValidationError(
          `${rel}: connectors doc is missing a "type" (connection|auth_profile|connector)`
        );
      }
      if (doc.version !== undefined && doc.version !== 1) {
        throw new ValidationError(
          `${rel}: unsupported connectors doc version ${JSON.stringify(doc.version)} (expected 1)`
        );
      }
      if (type === "connection") {
        const conn = parseConnectionDoc(doc, rel);
        if (connections.has(conn.slug)) {
          throw new ValidationError(
            `${rel}: duplicate connection slug "${conn.slug}"`
          );
        }
        connections.set(conn.slug, conn);
      } else if (type === "auth_profile") {
        const profile = parseAuthProfileDoc(doc, rel);
        if (authProfiles.has(profile.slug)) {
          throw new ValidationError(
            `${rel}: duplicate auth_profile slug "${profile.slug}"`
          );
        }
        if (profile.credentials) {
          // Expand `$ENV` refs in-place (collect them too, so the apply
          // secrets gate fails loud) — never push literal `$NAME` strings.
          const resolved: Record<string, string> = {};
          for (const [k, v] of Object.entries(profile.credentials)) {
            const ref = asEnvRef(v);
            if (!ref) {
              resolved[k] = v;
              continue;
            }
            envRefs.add(ref);
            const value = env[ref];
            if (value === undefined || value === "") {
              throw new ValidationError(
                `${rel}: auth_profile "${profile.slug}" credential "${k}" references $${ref}, but it is unset or empty in the apply environment`
              );
            }
            resolved[k] = value;
          }
          profile.credentials = resolved;
        }
        authProfiles.set(profile.slug, profile);
      } else if (type === "connector") {
        const parsed = parseConnectorDoc(doc, rel);
        const priorDoc = connectorDocKeyDeclaredBy.get(parsed.key);
        if (priorDoc) {
          throw new ValidationError(
            `connector key "${parsed.key}" is declared by two \`type: connector\` docs — ${priorDoc} and ${rel}; keys must be unique`
          );
        }
        connectorDocKeyDeclaredBy.set(parsed.key, rel);
        if (parsed.sourceUrl) {
          const prior = definitionsByKey.get(parsed.key);
          if (prior) {
            throw new ValidationError(
              `connector key "${parsed.key}" is declared twice — in ${prior.sourceFile} and ${rel}; keys must be unique`
            );
          }
          const priorTs = [...tsFileDefinitions.values()].find(
            (d) => d.key === parsed.key
          );
          if (priorTs) {
            throw new ValidationError(
              `connector key "${parsed.key}" is declared twice — in ${priorTs.sourceFile} and ${rel}; keys must be unique`
            );
          }
          definitionsByKey.set(parsed.key, {
            key: parsed.key,
            sourceUrl: parsed.sourceUrl,
            sourceFile: rel,
          });
        } else if (parsed.sourcePath) {
          // `source_path` is resolved relative to the manifest YAML file's
          // directory (the connectors/ dir), matching the watcher-classifier
          // `source_path` convention.
          const abs = resolve(dirPath, parsed.sourcePath);
          // The declared key must not collide with another connector definition.
          const keyClash =
            definitionsByKey.get(parsed.key) ??
            [...tsFileDefinitions.entries()].find(
              ([p, d]) => d.key === parsed.key && p !== abs
            )?.[1];
          if (keyClash) {
            throw new ValidationError(
              `connector key "${parsed.key}" is declared twice — in ${keyClash.sourceFile} and ${rel}; keys must be unique`
            );
          }
          if (tsFileDefinitions.has(abs)) {
            // Already auto-discovered as a `*.connector.ts` file; the
            // `type: connector` doc just declares its key for clearer output.
            const existing = tsFileDefinitions.get(abs);
            if (existing) {
              if (existing.key !== null && existing.key !== parsed.key) {
                throw new ValidationError(
                  `${existing.sourceFile} declares connector key "${existing.key}" but ${rel} declares "${parsed.key}" for the same file — they must agree`
                );
              }
              existing.key = parsed.key;
            }
          } else {
            let sourceCode: string;
            try {
              sourceCode = await readFile(abs, "utf-8");
            } catch {
              throw new ValidationError(
                `${rel}: connector "${parsed.key}" \`source_path\` ${parsed.sourcePath} does not exist`
              );
            }
            tsFileDefinitions.set(abs, {
              key: parsed.key,
              sourcePath: abs,
              sourceCode,
              sourceFile: rel,
            });
          }
        }
      } else {
        throw new ValidationError(
          `${rel}: unknown connectors doc type "${type}" (expected connection|auth_profile|connector)`
        );
      }
    }
  }

  const allDefs = [...definitionsByKey.values(), ...tsFileDefinitions.values()];
  const seenKeys = new Map<string, string>();
  for (const def of allDefs) {
    if (def.key === null) continue;
    const prior = seenKeys.get(def.key);
    if (prior) {
      throw new ValidationError(
        `connector key "${def.key}" is declared twice — in ${prior} and ${def.sourceFile}; keys must be unique`
      );
    }
    seenKeys.set(def.key, def.sourceFile);
  }

  return {
    definitions: allDefs.sort((a, b) =>
      (a.key ?? a.sourceFile).localeCompare(b.key ?? b.sourceFile)
    ),
    authProfiles: [...authProfiles.values()].sort((a, b) =>
      a.slug.localeCompare(b.slug)
    ),
    connections: [...connections.values()].sort((a, b) =>
      a.slug.localeCompare(b.slug)
    ),
  };
}

// ── Connector-config validation (used by apply-cmd with remote catalog) ────

export interface ResolvedConnectorSchemas {
  /** Connector key → `optionsSchema` (JSON Schema), if declared. */
  optionsSchema?: Record<string, unknown>;
  /** Every feed key declared by the connector (`connector.feeds` keys). */
  feedKeys: Set<string>;
  /** Feed key → `configSchema` (JSON Schema), for keys that declare one. */
  feedConfigSchemas: Map<string, Record<string, unknown>>;
  /** Allowed auth-profile kinds for the connector (from `authSchema.methods`). */
  authKinds: Set<string>;
}

function schemaFromAuthMethods(
  authSchema: ConnectorAuthSchema | Record<string, unknown> | null | undefined
): Set<string> {
  const kinds = new Set<string>();
  if (!authSchema || typeof authSchema !== "object") return kinds;
  const methods = (authSchema as { methods?: unknown }).methods;
  if (!Array.isArray(methods)) return kinds;
  for (const method of methods) {
    if (!isRecord(method)) continue;
    const t = asString(method.type);
    // ConnectorAuthMethod `type` ∈ env_keys | oauth | browser | interactive | none
    if (t === "env_keys") kinds.add("env");
    else if (t === "oauth") {
      kinds.add("oauth_app");
      kinds.add("oauth_account");
    } else if (t === "browser" || t === "interactive") {
      kinds.add("browser_session");
    }
  }
  return kinds;
}

/**
 * Build per-connector validation schemas from a connector definition. Accepts
 * either a typed `ConnectorDefinition` (from `@lobu/connector-sdk`) or the
 * snake_cased shape the server's `manage_connections list_connector_definitions`
 * returns (`options_schema`, `feeds_schema`, `auth_schema`).
 */
export function resolveConnectorSchemas(
  def:
    | ConnectorDefinition
    | {
        options_schema?: Record<string, unknown> | null;
        feeds_schema?: Record<string, unknown> | null;
        auth_schema?: Record<string, unknown> | null;
      }
): ResolvedConnectorSchemas {
  const optionsSchema =
    ("optionsSchema" in def ? def.optionsSchema : undefined) ??
    ("options_schema" in def ? (def.options_schema ?? undefined) : undefined) ??
    undefined;
  const feedsRaw =
    ("feeds" in def ? def.feeds : undefined) ??
    ("feeds_schema" in def ? (def.feeds_schema ?? undefined) : undefined) ??
    undefined;
  const authSchema =
    ("authSchema" in def ? def.authSchema : undefined) ??
    ("auth_schema" in def ? (def.auth_schema ?? undefined) : undefined) ??
    undefined;

  const feedKeys = new Set<string>();
  const feedConfigSchemas = new Map<string, Record<string, unknown>>();
  if (feedsRaw && typeof feedsRaw === "object") {
    for (const [feedKey, feedDef] of Object.entries(
      feedsRaw as Record<string, FeedDefinition | Record<string, unknown>>
    )) {
      if (!feedDef || typeof feedDef !== "object") continue;
      feedKeys.add(feedKey);
      const cfg = (feedDef as { configSchema?: unknown }).configSchema;
      if (cfg && typeof cfg === "object") {
        feedConfigSchemas.set(feedKey, cfg as Record<string, unknown>);
      }
    }
  }

  return {
    ...(optionsSchema ? { optionsSchema } : {}),
    feedKeys,
    feedConfigSchemas,
    authKinds: schemaFromAuthMethods(authSchema),
  };
}

let sharedAjv: Ajv | null = null;
function getAjv(): Ajv {
  if (!sharedAjv) {
    sharedAjv = new Ajv({ allErrors: true, strict: false });
    addFormats(sharedAjv);
  }
  return sharedAjv;
}

function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  context: string
): void {
  const ajv = getAjv();
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    // A malformed connector schema is the connector author's problem, not the
    // operator's — surface it but don't block the whole apply on it.
    throw new ValidationError(
      `${context}: connector declares an invalid JSON schema — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!validate(value ?? {})) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim())
      .join("; ");
    throw new ValidationError(
      `${context}: ${detail || "does not match the connector schema"}`
    );
  }
}

/**
 * Validate a single connection (+ its feeds) and its referenced auth-profile
 * kinds against a resolved connector schema. Pass `null` to skip schema
 * checks (e.g. a connector that only exists as a local `.ts` not yet
 * compiled by the server) — structural checks have already run at load time.
 */
export function validateConnectionAgainstConnector(
  connection: DesiredConnection,
  authProfiles: ReadonlyMap<string, DesiredAuthProfile>,
  schemas: ResolvedConnectorSchemas | null
): void {
  // Validate against `{}` when config is omitted too — that surfaces missing
  // required keys instead of letting an empty config slip through.
  if (schemas?.optionsSchema) {
    validateAgainstSchema(
      schemas.optionsSchema,
      connection.config ?? {},
      `${connection.sourceFile}: connection "${connection.slug}" config`
    );
  }
  for (const feed of connection.feeds) {
    if (!schemas) continue;
    if (schemas.feedKeys.size > 0 && !schemas.feedKeys.has(feed.feedKey)) {
      throw new ValidationError(
        `${connection.sourceFile}: connection "${connection.slug}" references unknown feed "${feed.feedKey}" for connector "${connection.connector}" (known feeds: ${[...schemas.feedKeys].sort().join(", ") || "(none)"})`
      );
    }
    const feedSchema = schemas.feedConfigSchemas.get(feed.feedKey);
    if (feedSchema) {
      validateAgainstSchema(
        feedSchema,
        feed.config ?? {},
        `${connection.sourceFile}: connection "${connection.slug}" feed "${feed.feedKey}" config`
      );
    }
  }
  // `auth:` must reference a runtime/account profile (never `oauth_app`);
  // `app_auth:` must reference an `oauth_app` profile.
  if (connection.authProfileSlug) {
    const profile = requireAuthProfile(
      connection,
      authProfiles,
      connection.authProfileSlug
    );
    if (profile.kind === "oauth_app") {
      throw new ValidationError(
        `${connection.sourceFile}: connection "${connection.slug}" \`auth\` references auth profile "${connection.authProfileSlug}" of kind \`oauth_app\` — use \`app_auth\` for OAuth-app credentials and \`auth\` for the account/runtime profile`
      );
    }
  }
  if (connection.appAuthProfileSlug) {
    const profile = requireAuthProfile(
      connection,
      authProfiles,
      connection.appAuthProfileSlug
    );
    if (profile.kind !== "oauth_app") {
      throw new ValidationError(
        `${connection.sourceFile}: connection "${connection.slug}" \`app_auth\` must reference an \`oauth_app\` auth profile (got \`${profile.kind}\`)`
      );
    }
  }
}

function requireAuthProfile(
  connection: DesiredConnection,
  authProfiles: ReadonlyMap<string, DesiredAuthProfile>,
  slugRef: string
): DesiredAuthProfile {
  const profile = authProfiles.get(slugRef);
  if (!profile) {
    throw new ValidationError(
      `${connection.sourceFile}: connection "${connection.slug}" references auth profile "${slugRef}" which is not declared in any \`type: auth_profile\` doc`
    );
  }
  if (profile.connector !== connection.connector) {
    throw new ValidationError(
      `${connection.sourceFile}: connection "${connection.slug}" references auth profile "${slugRef}" for connector "${profile.connector}", but the connection uses connector "${connection.connector}"`
    );
  }
  return profile;
}

export function validateAuthProfileAgainstConnector(
  profile: DesiredAuthProfile,
  schemas: ResolvedConnectorSchemas | null
): void {
  if (!schemas) return;
  if (schemas.authKinds.size > 0 && !schemas.authKinds.has(profile.kind)) {
    throw new ValidationError(
      `${profile.sourceFile}: auth_profile "${profile.slug}" uses \`kind: ${profile.kind}\`, but connector "${profile.connector}" supports: ${[...schemas.authKinds].sort().join(", ") || "(none)"}`
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface LoadDesiredStateOptions {
  /** Project root (directory containing `lobu.toml`). */
  cwd: string;
  /** Env to resolve `$VAR` refs against; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * When set, only the named resource family is loaded — `"agents"` and
   * `"memory"` both skip the `connectors/` dir (and its `$VAR` credential
   * expansion), so `--only agents` doesn't require connector secrets.
   */
  only?: "agents" | "memory";
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

  const { entityTypes, relationshipTypes, watchers } = await loadMemoryModels(
    config,
    opts.cwd
  );

  const connectors = opts.only
    ? { definitions: [], authProfiles: [], connections: [] }
    : await loadConnectors(config, opts.cwd, env, requiredSecrets);

  return {
    state: {
      agents,
      memorySchema: { entityTypes, relationshipTypes },
      watchers,
      connectors,
      requiredSecrets: [...requiredSecrets].sort(),
    },
    configPath,
  };
}
