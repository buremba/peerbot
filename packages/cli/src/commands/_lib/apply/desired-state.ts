import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ConnectorAuthSchema,
  ConnectorDefinition,
  EntityMetrics,
  FeedDefinition,
} from "@lobu/connector-sdk";
import type { AgentSettings } from "@lobu/core";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ConnectorSource, Project, Skill } from "../../../config/index.js";
import { ValidationError } from "../../memory/_lib/errors.js";
import {
  type AgentMarkdown,
  mapProjectToDesiredState,
  mergeAgentDirArtifacts,
} from "./map-config.js";
import {
  type EntityBacking,
  isRecord,
  type RelationshipRule,
  type WatcherSource,
} from "./shared.js";

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
  /** Platform config — values may still contain `$VAR` references. */
  config: Record<string, string>;
  /** Declarative channel bindings (`"<teamId>/<channelId>"`); Slack only. */
  channels?: string[];
}

export interface DesiredEntityType {
  slug: string;
  name?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /**
   * Present only for derived (SQL-view-backed) entity types; absent ⇒ stored
   * (the default). Normalized so a stored type compares equal on both sides
   * (desired + remote both omit it) and never churns the diff — see
   * {@link EntityBacking}.
   */
  backing?: EntityBacking;
  /**
   * Declared metric contract (eventSets/measures/dimensions/segments). Present
   * only when the type declares metrics; absent ⇒ not in the metric catalog.
   * Normalized so a type with no metrics compares equal on both sides and never
   * churns the diff (mirrors `backing`).
   */
  metrics?: EntityMetrics;
}

export interface DesiredRelationshipType {
  slug: string;
  name?: string;
  description?: string;
  rules?: RelationshipRule[];
  metadata?: Record<string, unknown>;
}

export interface DesiredWatcher {
  slug: string;
  /** Owning agent id. Every watcher belongs to exactly one agent. */
  agent: string;
  name?: string;
  description?: string;
  schedule?: string;
  prompt: string;
  /** Parsed JSON Schema object describing the LLM output. */
  extractionSchema: Record<string, unknown>;
  /** Optional SQL data sources; server applies a default when omitted. */
  sources?: WatcherSource[];
  /**
   * Reaction script — TypeScript source compiled + executed in an isolate at
   * watcher-firing time. Authored as a sibling `.ts` file referenced by
   * `defineWatcher({ reaction: reactionFromFile("./reactions/foo.reaction.ts") })`;
   * the CLI reads it and pushes raw source via `set_reaction_script`.
   */
  reactionScript?: { sourcePath: string; sourceCode: string };
  /** LLM guidance for the watcher's downstream reaction agent. */
  reactionsGuidance?: string;
  /** UUID of a device worker to pin this watcher's runs to (see `device_workers.id`). */
  deviceWorkerId?: string;
  /** MCP client id that should auto-run this watcher. */
  schedulerClientId?: string;
  /** Where firings surface — defaults to canvas server-side. */
  notificationChannel?: "canvas" | "notification" | "both";
  /** Priority class used by the dispatcher interrupt budget. */
  notificationPriority?: "low" | "normal" | "high";
  /** Minimum seconds between two firings of this watcher (0 = no cooldown). */
  minCooldownSeconds?: number;
  /** Free-form tags for filtering. */
  tags?: string[];
  /** Optional agent-kind override (e.g. "background", "notifier"). */
  agentKind?: string;
  /** Optional JSON template for renderer. */
  jsonTemplate?: unknown;
  /** Stable key generation across windows. */
  keyingConfig?: Record<string, unknown>;
  /** Classifier definitions for extraction (server-side feature). */
  classifiers?: unknown[];
  /** Handlebars prompt for condensing windows into a rollup. */
  condensationPrompt?: string;
  /** How many leaf windows to condense into one rollup (default 4 server-side). */
  condensationWindowCount?: number;
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
  /**
   * Optional UUID pinning the connection's syncs/actions to a specific device
   * worker (`device_workers.id`). Required for connectors that declare a
   * `required_capability`; omit it for serverless-on-Lobu runs.
   */
  deviceWorkerId?: string;
  feeds: DesiredFeed[];
  /** Source label for error messages (the config the connection came from). */
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
   * Settings payload destined for `PATCH /:agentId/config`. Built by the mapper
   * + agent-dir loader: networkConfig, skillsConfig, egressConfig,
   * preApprovedTools, guardrails, toolsConfig, nixConfig, mcpServers,
   * modelSelection, providerModelPreferences, installedProviders,
   * identityMd/soulMd/userMd.
   */
  settings: Partial<AgentSettings>;
  platforms: DesiredPlatform[];
  /**
   * Provider API keys resolved from `secret()` / `$VAR` provider keys, pushed
   * into `agent_secrets` after the settings PATCH. Empty when no provider
   * declared a `key` (or all are unset). The value lives only in process
   * memory; never serialized.
   */
  providerKeys: { providerId: string; value: string }[];
}

export interface DesiredState {
  agents: DesiredAgent[];
  /**
   * When true (`defineConfig({ prune: true })`), `lobu apply` deletes org-owned
   * definitions (entity/relationship types, watchers, connector definitions)
   * absent from this config — including ones created in the UI. Data,
   * connections, auth profiles, and agents are never pruned. Default false.
   */
  prune: boolean;
  /**
   * Org metadata from `defineConfig` — the org slug `lobu apply` defaults to,
   * the `organizationId` it matches against, and the name/description shown
   * when telling the operator to create the org.
   */
  memory?: {
    org?: string;
    organizationId?: string;
    name?: string;
    description?: string;
  };
  memorySchema: {
    entityTypes: DesiredEntityType[];
    relationshipTypes: DesiredRelationshipType[];
  };
  /** Watchers declared via `defineWatcher`. */
  watchers: DesiredWatcher[];
  /**
   * Connectors: local `*.connector.ts` definitions (declared via
   * `connectorFromFile`), `defineConnection`s, and `defineAuthProfile`s.
   */
  connectors: {
    definitions: DesiredConnectorDefinition[];
    authProfiles: DesiredAuthProfile[];
    connections: DesiredConnection[];
  };
  /**
   * Names of env vars referenced via `secret()` / `$VAR` (provider keys,
   * auth-profile + mcp credentials). The CLI surfaces these before mutating
   * remote state so missing secrets fail loud instead of expanding to empty.
   */
  requiredSecrets: string[];
}

// ── Load + transform ───────────────────────────────────────────────────────

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
  mcpServers?: SkillMcpInput;
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

type SkillConfigEntry = NonNullable<
  AgentSettings["skillsConfig"]
>["skills"][number];

type SkillMcpInput = Record<
  string,
  { url?: string; type?: string; command?: string; args?: string[] }
>;

/**
 * Map a resolved skill (inline `defineSkill` or file-loaded `skillFromFile`)
 * into a `SkillConfig` entry — the shape stored on agent settings and synced to
 * the worker's `.skills/`. The network/nix/mcp here merge into the agent's
 * worker sandbox at apply time, which is why skills resolve eagerly.
 */
function skillToConfig(args: {
  name: string;
  content: string;
  source: "inline" | "file";
  description?: string;
  nixPackages?: string[];
  allow?: string[];
  deny?: string[];
  judged?: Array<{ domain: string; judge?: string }>;
  judges?: Record<string, string>;
  mcpServers?: SkillMcpInput;
}): SkillConfigEntry {
  const skill: SkillConfigEntry = {
    repo: `${args.source}/${args.name}`,
    name: args.name,
    content: args.content,
    enabled: true,
  };
  if (args.description) skill.description = args.description;
  if (args.nixPackages?.length) skill.nixPackages = args.nixPackages;

  const judgedDomains = (args.judged ?? []).map((entry) => ({
    domain: normalizeDomainPattern(entry.domain),
    ...(entry.judge ? { judge: entry.judge } : {}),
  }));
  const allowedDomains = normalizeDomainPatterns(args.allow);
  const deniedDomains = normalizeDomainPatterns(args.deny);
  if (
    allowedDomains ||
    deniedDomains ||
    judgedDomains.length > 0 ||
    args.judges
  ) {
    skill.networkConfig = {
      allowedDomains,
      deniedDomains,
      ...(judgedDomains.length > 0 ? { judgedDomains } : {}),
      ...(args.judges ? { judges: args.judges } : {}),
    };
  }

  const mcpEntries = Object.entries(args.mcpServers ?? {});
  if (mcpEntries.length > 0) {
    skill.mcpServers = mcpEntries.map(([id, mcp]) => ({
      id,
      url: mcp.url,
      type: mcp.type as "sse" | "stdio" | undefined,
      command: mcp.command,
      args: mcp.args,
    }));
  }
  return skill;
}

/** Read a `SKILL.md` (a dir holding one, or a `.md` path) for `skillFromFile`. */
async function readSkillFile(
  cwd: string,
  relPath: string,
  nameOverride?: string
): Promise<{ name: string; content: string; fm?: SkillFrontmatter }> {
  const abs = resolve(cwd, relPath);
  const filePath = abs.endsWith(".md") ? abs : join(abs, "SKILL.md");
  let raw: string;
  try {
    raw = (await readFile(filePath, "utf-8")).trim();
  } catch {
    throw new ValidationError(
      `skillFromFile("${relPath}"): no SKILL.md found at ${filePath}`
    );
  }
  if (!raw) {
    throw new ValidationError(
      `skillFromFile("${relPath}"): ${filePath} is empty`
    );
  }
  const { frontmatter, body } = await parseSkillFrontmatter(raw);
  const name =
    nameOverride ?? frontmatter?.name ?? basename(abs.replace(/\.md$/, ""));
  return { name, content: body, ...(frontmatter ? { fm: frontmatter } : {}) };
}

/** Resolve one declared skill (inline `defineSkill` or `skillFromFile`). */
async function resolveSkill(
  skill: Skill,
  cwd: string
): Promise<SkillConfigEntry> {
  if (skill.path !== undefined) {
    const { name, content, fm } = await readSkillFile(
      cwd,
      skill.path,
      skill.name
    );
    return skillToConfig({
      name,
      content,
      source: "file",
      description: fm?.description,
      nixPackages: fm?.nixPackages,
      allow: fm?.network?.allow,
      deny: fm?.network?.deny,
      judged: (fm?.network?.judge ?? []).map((e) =>
        typeof e === "string"
          ? { domain: e }
          : { domain: e.domain, ...(e.judge ? { judge: e.judge } : {}) }
      ),
      judges: fm?.judges,
      mcpServers: fm?.mcpServers,
    });
  }
  if (!skill.name) {
    throw new ValidationError("defineSkill requires a `name`.");
  }
  const net = skill.network;
  return skillToConfig({
    name: skill.name,
    content: skill.content ?? "",
    source: "inline",
    description: skill.description,
    nixPackages: skill.nixPackages,
    allow: net?.allowed,
    deny: net?.denied,
    judged: net?.judged,
    judges: net?.judges,
    mcpServers: skill.mcpServers,
  });
}

/**
 * Resolve an agent's declared `skills` into `SkillConfig` entries, deduped by
 * name (a duplicate is an authoring error — explicit lists shouldn't collide).
 */
async function resolveAgentSkills(
  skills: Skill[],
  cwd: string
): Promise<SkillConfigEntry[]> {
  const resolved = await Promise.all(skills.map((s) => resolveSkill(s, cwd)));
  const byName = new Map<string, SkillConfigEntry>();
  for (const skill of resolved) {
    if (byName.has(skill.name)) {
      throw new ValidationError(
        `duplicate skill "${skill.name}" — skill names must be unique within an agent.`
      );
    }
    byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

async function readMarkdown(agentDir: string): Promise<AgentMarkdown> {
  const result: AgentMarkdown = {};
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
 * snake_cased shape from `manage_catalog` connector entries
 * (`options_schema`, `feeds_schema`, `auth_schema`).
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
    // `managedBy` is Lobu metadata (cloud-grant delegation), not a connector
    // option — strip it before validating against the connector's option schema
    // so a strict (additionalProperties:false) schema doesn't reject it.
    const optionConfig = { ...(connection.config ?? {}) };
    delete optionConfig.managedBy;
    validateAgainstSchema(
      schemas.optionsSchema,
      optionConfig,
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

/** Keys the connector treats as feed-scoped (declared in any feed's `configSchema`). */
export function feedScopedKeys(schemas: ResolvedConnectorSchemas): Set<string> {
  const keys = new Set<string>();
  for (const feedSchema of schemas.feedConfigSchemas.values()) {
    const props = (feedSchema as { properties?: Record<string, unknown> })
      .properties;
    if (props) for (const k of Object.keys(props)) keys.add(k);
  }
  return keys;
}

/**
 * The server stores feed-scoped settings on feeds, not the connection, and
 * REJECTS a connection whose config carries any feed-scoped key (see
 * `splitConfigByFeedScope` in packages/server). `lobu apply` mirrors that split
 * here: any feed-scoped key found in a connection's `config` is demoted to a
 * per-feed default (an explicit feed value wins) and removed from the
 * connection config. `managedBy` is Lobu metadata, never a connector option, so
 * it stays on the connection. Returns the demoted key names so the caller can
 * warn. Mutates `connection` in place so the normalized shape flows into the
 * diff + create/update payloads.
 */
export function normalizeConnectionConfigScope(
  connection: DesiredConnection,
  schemas: ResolvedConnectorSchemas | null
): string[] {
  if (!schemas || !connection.config) return [];
  const scoped = feedScopedKeys(schemas);
  if (scoped.size === 0) return [];
  const demoted: Record<string, unknown> = {};
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(connection.config)) {
    if (k !== "managedBy" && scoped.has(k)) demoted[k] = v;
    else kept[k] = v;
  }
  const demotedKeys = Object.keys(demoted);
  if (demotedKeys.length === 0) return [];
  connection.feeds = connection.feeds.map((feed) => ({
    ...feed,
    config: { ...demoted, ...(feed.config ?? {}) },
  }));
  connection.config = Object.keys(kept).length > 0 ? kept : undefined;
  return demotedKeys;
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

interface LoadDesiredStateOptions {
  /** Project root (directory containing `lobu.config.ts`). */
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

/**
 * Resolve the project's explicit `connectors: [connectorFromFile(...)]` list
 * into connector definitions to compile + ship. Replaces directory
 * auto-discovery: only listed connectors are uploaded. Paths are relative to
 * the config dir and guarded (no absolute, `..`, or backslash escapes),
 * mirroring `resolveReactionScript`.
 *
 * Each source ships with `key: null`; `apply-cmd` compiles each `sourcePath` on
 * the CLI (where the project's node_modules is available) and the server
 * resolves the real key. We intentionally do NOT compile/instantiate here to
 * resolve the key eagerly — that would force a full esbuild + module load on
 * every load (including `--dry-run`) for no benefit, since the server is the
 * source of truth for the compiled key. A connection that references a
 * connector by a bare *string* key relies on that string matching the file's
 * compiled `definition.key`; reference it by its `defineConnector` class
 * (`connector: myConnector`) to make that match exact.
 */
function resolveConnectorSources(
  sources: ConnectorSource[],
  cwd: string
): DesiredConnectorDefinition[] {
  const baseDir = resolve(cwd);
  const defs: DesiredConnectorDefinition[] = [];
  for (const src of sources) {
    const rel = src.path.trim();
    if (!rel) {
      throw new ValidationError(
        "connectorFromFile() requires a path to a `*.connector.ts` file"
      );
    }
    if (rel.startsWith("/") || rel.includes("\\")) {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) must be a relative POSIX path (./foo.connector.ts) — absolute paths and backslashes are not allowed`
      );
    }
    if (rel.split("/").some((seg) => seg === "..")) {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) must not contain \`..\` segments — keep the connector under the config directory`
      );
    }
    if (!rel.endsWith(".ts")) {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) must point at a \`.ts\` file`
      );
    }
    const abs = resolve(baseDir, rel);
    const relPath = relative(baseDir, abs);
    if (
      relPath === ".." ||
      relPath.startsWith(`..${sep}`) ||
      isAbsolute(relPath)
    ) {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) resolves outside the config directory (${abs})`
      );
    }
    let sourceCode: string;
    try {
      sourceCode = readFileSync(abs, "utf-8");
    } catch {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) does not exist (resolved to ${abs})`
      );
    }
    defs.push({
      key: null,
      sourcePath: abs,
      sourceCode,
      sourceFile: rel.replace(/^\.\//, ""),
    });
  }
  return defs.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
}

const REACTION_SCRIPT_MAX_BYTES = 256 * 1024;

/**
 * Resolve + read a watcher reaction script (`reactionFromFile(path)`): relative
 * POSIX path under the config directory, ends in `.ts`, no `..` / absolute /
 * backslash segments, ≤256KB. Ships RAW source — the server compiles it on
 * receipt via `set_reaction_script`.
 */
function resolveReactionScript(
  cwd: string,
  watcherSlug: string,
  rel: string
): { sourcePath: string; sourceCode: string } {
  const trimmed = rel.trim();
  if (!trimmed) {
    throw new ValidationError(
      `watcher "${watcherSlug}" \`reaction\` must be a path to a sibling .ts file (e.g. \`reaction: reactionFromFile("./reactions/foo.reaction.ts")\`)`
    );
  }
  if (trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new ValidationError(
      `watcher "${watcherSlug}" \`reaction\` must be a relative POSIX path (./foo.reaction.ts) — absolute paths and backslashes are not allowed`
    );
  }
  if (trimmed.split("/").some((seg) => seg === "..")) {
    throw new ValidationError(
      `watcher "${watcherSlug}" \`reaction\` must not contain \`..\` segments — keep the script under the config directory`
    );
  }
  if (!trimmed.endsWith(".ts")) {
    throw new ValidationError(
      `watcher "${watcherSlug}" \`reaction\` must end in \`.ts\` (got ${JSON.stringify(trimmed)})`
    );
  }
  const baseDir = resolve(cwd);
  const abs = resolve(baseDir, trimmed);
  // Containment check via `relative` (cross-platform): a hard-coded `${baseDir}/`
  // prefix uses POSIX `/` and wrongly rejects every path on Windows (backslash
  // separators). `rel` is "" when abs === baseDir, starts with ".." when abs
  // escapes baseDir, and is absolute when on a different drive.
  const relPath = relative(baseDir, abs);
  if (
    relPath === ".." ||
    relPath.startsWith(`..${sep}`) ||
    isAbsolute(relPath)
  ) {
    throw new ValidationError(
      `watcher "${watcherSlug}" \`reaction\` resolves outside the config directory (${abs})`
    );
  }
  let sourceCode: string;
  try {
    sourceCode = readFileSync(abs, "utf-8");
  } catch {
    throw new ValidationError(
      `watcher "${watcherSlug}" \`reaction\` ${trimmed} does not exist (resolved to ${abs})`
    );
  }
  if (Buffer.byteLength(sourceCode, "utf8") > REACTION_SCRIPT_MAX_BYTES) {
    throw new ValidationError(
      `watcher "${watcherSlug}" \`reaction\` exceeds the ${REACTION_SCRIPT_MAX_BYTES}-byte cap — reaction scripts should be a few hundred lines, not a vendored library`
    );
  }
  return { sourcePath: abs, sourceCode };
}

/**
 * Import a `lobu.config.ts` and return its `defineConfig` default export (the
 * SDK {@link Project}). Shared by {@link loadDesiredStateFromConfig} (apply) and
 * the commands that read the authored config directly (`lobu run` preview
 * registration, `lobu doctor`, `lobu chat`, `lobu validate`, `lobu memory seed`).
 *
 * Uses jiti — the same runtime TypeScript loader Next.js/Nuxt use for their
 * `*.config.ts` — which transpiles on import and resolves the config's imports
 * (`@lobu/cli/config`, `@lobu/connector-sdk`, relative reaction/connector files)
 * from the project. No bundling, no temp file. The dynamic `import("jiti")` is
 * lazy + allow-listed (AGENTS.md).
 */
export async function loadProjectConfig(
  cwd: string
): Promise<{ project: Project; configPath: string }> {
  const configPath = resolve(cwd, "lobu.config.ts");
  if (!existsSync(configPath)) {
    throw new ValidationError(`No lobu.config.ts found in ${cwd}`);
  }
  const { createJiti } = await import("jiti");
  // Resolve the SDK imports the config will reference (`@lobu/cli/config`,
  // `@lobu/connector-sdk`) against the running CLI's own copies — not the
  // project's `node_modules`. This lets a freshly-scaffolded project
  // `validate`/`run` with zero install: the user has the CLI, that's enough.
  // Falls through silently if a symbol can't be resolved from here (the
  // catch-all error below still surfaces real problems).
  const alias: Record<string, string> = {};
  for (const spec of ["@lobu/cli/config", "@lobu/connector-sdk"]) {
    try {
      alias[spec] = fileURLToPath(import.meta.resolve(spec));
    } catch {
      // CLI dist may not expose this symbol in some packaging layouts; skip.
    }
  }
  const jiti = createJiti(
    pathToFileURL(configPath).href,
    Object.keys(alias).length > 0 ? { alias } : undefined
  );
  let project: unknown;
  try {
    project = await jiti.import(configPath, { default: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Failed to load lobu.config.ts — ${message}`);
  }
  if (
    !project ||
    typeof project !== "object" ||
    (project as { kind?: unknown }).kind !== "project"
  ) {
    throw new ValidationError(
      "lobu.config.ts must `export default defineConfig({ ... })`"
    );
  }
  return { project: project as Project, configPath };
}

/**
 * Load desired state from a TypeScript entrypoint (`lobu.config.ts`): import the
 * `defineConfig()` project, map it to `DesiredState`, then attach the
 * file-based artifacts (agent-dir markdown + skills, watcher reaction scripts,
 * local connector source).
 */
export async function loadDesiredStateFromConfig(
  opts: LoadDesiredStateOptions
): Promise<{ state: DesiredState; configPath: string; warnings: string[] }> {
  const env = opts.env ?? process.env;
  const { project: typedProject, configPath } = await loadProjectConfig(
    opts.cwd
  );
  const state = mapProjectToDesiredState(typedProject, env, opts.only);

  // Agent artifacts: SOUL/IDENTITY/USER.md (convention, from the agent dir) +
  // skills (explicit `defineAgent({ skills })`, inline or `skillFromFile`). The
  // mapper stays pure (no file IO); we read the files here and merge them in.
  await Promise.all(
    typedProject.agents.map(async (agent, i) => {
      const settings = state.agents[i]?.settings;
      if (!settings) return;
      const agentDir = resolve(opts.cwd, agent.dir ?? join("agents", agent.id));
      const markdown = await readMarkdown(agentDir);
      const localSkills = await resolveAgentSkills(
        agent.skills ?? [],
        opts.cwd
      );
      mergeAgentDirArtifacts(settings, markdown, localSkills);
    })
  );

  // Watcher reaction scripts: a sibling `.ts` file referenced by path. The
  // mapper stays pure; resolve + read the source here (raw, server compiles
  // it) and attach it. state.watchers[i] aligns with typedProject.watchers[i]
  // (the mapper maps them in order).
  (typedProject.watchers ?? []).forEach((watcher, i) => {
    // Gate on absence, not truthiness — a present-but-empty
    // `reactionFromFile("")` must reach the validator (which rejects it),
    // matching parseWatcher.
    if (watcher.reaction === undefined) return;
    const dw = state.watchers[i];
    if (!dw) return;
    // `reaction` is typed ReactionSource, but jiti evaluates the config without
    // typechecking, so a stale `reaction: "./x.reaction.ts"` string slips
    // through and would read `.path` as undefined. Reject it with a clear
    // message instead of a downstream TypeError. (An empty `reactionFromFile("")`
    // keeps a string path and still reaches the validator, which rejects it.)
    const reactionPath = (watcher.reaction as { path?: unknown }).path;
    if (typeof reactionPath !== "string") {
      throw new Error(
        `Watcher "${watcher.slug}": set reaction with reactionFromFile("./x.reaction.ts"), not a bare string path.`
      );
    }
    dw.reactionScript = resolveReactionScript(
      opts.cwd,
      watcher.slug,
      reactionPath
    );
  });

  // `--only agents|memory` skips connectors (matching the mapper), so don't
  // ship local connector source for those runs either.
  if (!opts.only) {
    state.connectors.definitions = resolveConnectorSources(
      typedProject.connectors ?? [],
      opts.cwd
    );
  }
  // Surface load-time warnings to `lobu apply` (which prints them). #1010's
  // "ignored connectors because [memory] is disabled" case is obsolete here —
  // lobu.config.ts has no `[memory].enabled` gate, so connectors always load —
  // but the channel is kept so future TS-loader warnings flow to the operator.
  const warnings: string[] = [];
  return { state, configPath, warnings };
}
