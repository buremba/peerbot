/**
 * Declarative authoring API. Each `define*` returns a branded plain object that
 * doubles as a typed handle (e.g. an {@link EntityType} can be passed to
 * {@link defineRelationshipType}, an {@link Agent} to {@link defineWatcher}).
 *
 * These are pure data producers with no side effects — `lobu apply` imports the
 * entrypoint, reads the {@link Project} default export, and maps it to the
 * server's desired state. Executable handlers (connector `sync`/`execute`,
 * watcher reactions) live in their own modules; these objects only declare
 * config and references.
 */

import type {
  ConnectorClass,
  ConnectorRuntime,
  Dimension,
  EventSet,
  Measure,
  ReactionClient,
  ReactionContext,
  Segment,
} from "@lobu/connector-sdk";
import type { SecretRef } from "./secret.js";

/** A connector referenced by its key, or by the class produced by `defineConnector`. */
export type ConnectorRef = string | ConnectorClass;

// ---------------------------------------------------------------------------
// Memory schema
// ---------------------------------------------------------------------------

/**
 * Makes an entity type **derived**: its rows are a read-only SQL view over other
 * relations (events, other entities) instead of inserted/validated rows.
 *
 * Presence is the discriminant: an entity type with `backing` is derived; without
 * it, it is **stored** (the default — a curated entity like a Company or a
 * hand-named Trip). There is no separate `mode` field — "derived" just means
 * "has a view". Read a derived type's rows by running its SQL through `query_sql`.
 * NOTE: with the declared metric layer (see {@link Measure}), measures/dimensions
 * are DECLARED, not inferred on read — a derived type is in the metric catalog
 * only if it declares them.
 */
export interface EntityBacking {
  /** ANSI SELECT over other relations (events, entities, …). */
  sql: string;
  /**
   * Optional connection slug. When set, `sql` runs LIVE against that connection's
   * single external database (read-only, no copy) instead of Lobu's internal
   * store — see {@link defineConnection}. Omitted ⇒ the view runs over internal
   * events/entities (the default). Single-database only: `sql` may reference only
   * tables that exist in the bound connection's database.
   */
  connection?: string;
}

// ---------------------------------------------------------------------------
// Entity-bound metrics — the contract types live in `@lobu/connector-sdk`
// (shared by CLI authoring, connector federation, and server compile/validate;
// the config module may not import `@lobu/core` — see config-isolation.test.ts).
// Re-exported here so configs can import them alongside `defineEntityType`.
// ---------------------------------------------------------------------------
export type {
  Dimension,
  EventSet,
  FactMatchRule,
  Measure,
  MetricReadMode,
  MetricTier,
  Segment,
} from "@lobu/connector-sdk";

export interface EntityType {
  readonly kind: "entityType";
  /** Stable slug — diff key. */
  key: string;
  name?: string;
  description?: string;
  /** Required property names for the entity's metadata. */
  required?: string[];
  /** JSON Schema properties for the entity's metadata. */
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /**
   * Present only for DERIVED types — a read-only SQL view (`{ sql }`). Omitted ⇒
   * the type is stored (the default; rows are inserted/validated). Presence is
   * the only discriminant; there is no separate `mode` field.
   */
  backing?: EntityBacking;
  /**
   * How events resolve to this entity, at named grains (the join key). The
   * compiler lowers `eventSets` + `measures` into backing SQL.
   */
  eventSets?: Record<string, EventSet>;
  /**
   * Governed aggregations. DECLARED — there is no on-read inference; an entity is
   * in the metric catalog only if it declares `measures`.
   */
  measures?: Record<string, Measure>;
  /** Governed group-bys. */
  dimensions?: Record<string, Dimension>;
  /** Reusable named population filters. */
  segments?: Record<string, Segment>;
}

export function defineEntityType(config: Omit<EntityType, "kind">): EntityType {
  return { ...config, kind: "entityType" };
}

export interface RelationshipType {
  readonly kind: "relationshipType";
  key: string;
  name?: string;
  description?: string;
  /** Allowed source/target entity types (handle or slug). */
  rules?: Array<{ source: EntityType | string; target: EntityType | string }>;
  metadata?: Record<string, unknown>;
}

export function defineRelationshipType(
  config: Omit<RelationshipType, "kind">
): RelationshipType {
  return { ...config, kind: "relationshipType" };
}

// ---------------------------------------------------------------------------
// Connections & auth profiles (code declares wiring; the UI performs OAuth)
// ---------------------------------------------------------------------------

export type AuthProfileKind =
  | "env"
  | "oauth_app"
  | "oauth_account"
  | "browser_session";

export interface AuthProfile {
  readonly kind: "authProfile";
  /** Stable slug — diff key. */
  slug: string;
  connector: ConnectorRef;
  authKind: AuthProfileKind;
  name?: string;
  /**
   * Credential references. Values are `secret(...)` refs (or literal `$VAR`
   * strings). Only meaningful for `env` / `oauth_app`; the OAuth grant for
   * `oauth_account` / `browser_session` is performed at runtime in the UI.
   */
  credentials?: Record<string, string | SecretRef>;
}

export function defineAuthProfile(
  config: Omit<AuthProfile, "kind">
): AuthProfile {
  return { ...config, kind: "authProfile" };
}

export interface ConnectionFeed {
  /** Feed key from the connector definition. */
  feed: string;
  name?: string;
  schedule?: string;
  config?: Record<string, unknown>;
}

/**
 * Marks a connection as MANAGED by a cloud (public) org. The OAuth grant lives
 * in the cloud: a user joins the public `org`, connects normally (consent
 * against the managed app → a connection owned by them), and the local instance
 * fetches a fresh access token for its own user's connection at runtime via
 * `POST /oauth/connection-token`, authenticating with the instance's cloud PAT
 * (`LOBU_CLOUD_PAT`). The managed client secret + refresh token never leave the
 * cloud.
 *
 * The cloud origin is fixed by the instance's `LOBU_CLOUD_URL` — a connection
 * CANNOT supply a URL, so a malicious config can never redirect where the cloud
 * PAT is sent.
 */
export interface ManagedBy {
  /** The cloud (public) org the managed connector lives under. */
  org: string;
}

export interface Connection {
  readonly kind: "connection";
  /** Stable slug — diff key. */
  slug: string;
  connector: ConnectorRef;
  name?: string;
  /** Runtime/account auth profile (handle or slug). */
  authProfile?: AuthProfile | string;
  /** OAuth-app auth profile (handle or slug). */
  appAuthProfile?: AuthProfile | string;
  config?: Record<string, unknown>;
  /**
   * Mark this connection as managed by a cloud (public) org — the grant lives
   * in the cloud and the local instance fetches its token at runtime. See
   * {@link ManagedBy}.
   */
  managedBy?: ManagedBy;
  /** UUID pinning syncs/actions to a specific device worker. */
  deviceWorkerId?: string;
  feeds?: ConnectionFeed[];
}

export function defineConnection(config: Omit<Connection, "kind">): Connection {
  return { ...config, kind: "connection" };
}

/**
 * The shape a connector module's default export must satisfy: a class extending
 * {@link ConnectorRuntime} (`export default class Foo extends ConnectorRuntime
 * {…}`). Used to type-check the `<Connector>` generic on
 * {@link connectorFromFile} against the referenced module.
 */
// The connector's checkpoint/config type params appear in both variance
// positions (the contravariant `sync(ctx: SyncContext<C, F>)` and the covariant
// `SyncResult<C>`), so `any` is the only instantiation that accepts every
// concrete subclass; `unknown`/`never` reject real connectors typed
// `ConnectorRuntime<MyCheckpoint, MyConfig>`. Only the constructor shape is
// load-bearing here, never the type params.
export type ConnectorClassExport = new (
  ...args: never[]
) => ConnectorRuntime<any, any>;

/**
 * A local connector source file to compile and ship at `lobu apply`. Built with
 * {@link connectorFromFile} and listed in {@link Project.connectors}. This is
 * explicit — only listed connectors are compiled and uploaded; there is no
 * `./connectors` directory auto-discovery. Connections reference the connector
 * by key (or its `defineConnector` class), independent of this list.
 */
export interface ConnectorSource {
  readonly kind: "connectorSource";
  /** Path to a `*.connector.ts`, relative to the config file. */
  path: string;
}

/**
 * Reference a local connector source file to compile + ship at apply time.
 *
 * Pass the connector's module type via the generic for go-to-def / rename and a
 * `tsc` error if the module's default export drifts from
 * {@link ConnectorClassExport} (a {@link ConnectorRuntime} subclass):
 *
 * ```ts
 * import type StripeCharges from "./stripe-charges.connector.ts";
 * connectorFromFile<typeof StripeCharges>("./stripe-charges.connector.ts"),
 * ```
 *
 * The `import type` is erased at compile time (zero runtime cost; jiti drops it),
 * so the connector module is never imported during config eval.
 */
export function connectorFromFile<
  _Connector extends ConnectorClassExport = ConnectorClassExport,
>(path: string): ConnectorSource {
  return { kind: "connectorSource", path };
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

/**
 * The shape a watcher reaction module's default export must satisfy:
 * `export default async (ctx, client, params?) => …`. Used to type-check the
 * `<Handler>` generic on {@link reactionFromFile} against the referenced module.
 */
export type ReactionHandler = (
  ctx: ReactionContext,
  client: ReactionClient,
  params?: Record<string, unknown>
) => Promise<unknown>;

/**
 * A local reaction source file to compile + run in a sandboxed isolate when the
 * watcher fires. Built with {@link reactionFromFile} and set on
 * {@link Watcher.reaction}. Like {@link ConnectorSource}, this carries only the
 * path as plain data — the handler module is NOT imported at config-eval time;
 * `lobu apply` reads the raw source and the server compiles it.
 */
export interface ReactionSource {
  readonly kind: "reactionSource";
  /** Path to a `*.reaction.ts`, relative to the config file. */
  path: string;
}

/**
 * Reference a local reaction source file to compile + ship at apply time.
 *
 * Pass the handler's module type via the generic for go-to-def / rename and a
 * `tsc` error if the module's default export drifts from {@link ReactionHandler}:
 *
 * ```ts
 * import type triage from "./inbound-triage.reaction.ts";
 * reaction: reactionFromFile<typeof triage>("./inbound-triage.reaction.ts"),
 * ```
 *
 * The `import type` is erased at compile time (zero runtime cost; jiti drops it),
 * so the handler module is never imported during config eval.
 */
export function reactionFromFile<
  _Handler extends ReactionHandler = ReactionHandler,
>(path: string): ReactionSource {
  return { kind: "reactionSource", path };
}

export interface WatcherNotification {
  channel?: "canvas" | "notification" | "both";
  priority?: "low" | "normal" | "high";
}

export interface Watcher {
  readonly kind: "watcher";
  /** Stable slug — diff key. */
  slug: string;
  /** Owning agent (handle or id). Every watcher belongs to exactly one agent. */
  agent: Agent | string;
  name?: string;
  description?: string;
  schedule?: string;
  prompt: string;
  /** JSON Schema (or TypeBox schema) describing the LLM output. */
  extractionSchema: Record<string, unknown>;
  /** Named SQL data sources (`name` -> query). */
  sources?: Record<string, string>;
  notification?: WatcherNotification;
  minCooldownSeconds?: number;
  tags?: string[];
  /** LLM guidance for the watcher's downstream reaction agent. */
  reactionsGuidance?: string;
  /** Agent-kind override for firings (e.g. "background", "notifier"). */
  agentKind?: string;
  /**
   * A sibling `.ts` reaction script (`./reactions/foo.reaction.ts`) compiled +
   * run in a sandboxed isolate when the watcher fires, built with
   * {@link reactionFromFile}. The script must `export default async (ctx,
   * client, params?) => …` ({@link ReactionHandler}). Kept in its own file (not
   * inline) so your IDE type-checks it; the path must stay under the config
   * directory.
   */
  reaction?: ReactionSource;
}

export function defineWatcher(config: Omit<Watcher, "kind">): Watcher {
  return { ...config, kind: "watcher" };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  id?: string;
  model: string;
  key?: string | SecretRef;
}

/** Per-domain egress-judge rule: route `domain` through the named judge policy. */
export interface JudgedDomain {
  domain: string;
  /** Name of a policy declared in {@link NetworkConfig.judges}. */
  judge?: string;
}

export interface NetworkConfig {
  /** Domains the worker may reach (exact or `.wildcard`). */
  allowed?: string[];
  /** Domains explicitly blocked (takes precedence over `allowed`). */
  denied?: string[];
  /** Domains routed through the LLM egress judge. */
  judged?: JudgedDomain[];
  /** Named judge policies (prompt text), referenced by `judged[].judge`. */
  judges?: Record<string, string>;
}

/** Operator-level overrides for the LLM egress judge. */
export interface EgressConfig {
  /** Extra instructions appended to the egress judge prompt. */
  extraPolicy?: string;
  /** Override the model the egress judge runs on. */
  judgeModel?: string;
}

/** Worker-side tool permissions. */
export interface ToolsConfig {
  /**
   * MCP tool grant patterns pre-approved by the operator (e.g.
   * `/mcp/gmail/tools/send_email`), bypassing the in-chat approval card.
   */
  preApproved?: string[];
  allowed?: string[];
  denied?: string[];
  /** Reject tool calls that aren't in `allowed`. */
  strict?: boolean;
}

/** OAuth flow for a custom MCP server. */
export interface McpServerOAuth {
  authUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string | SecretRef;
  scopes?: string[];
  tokenEndpointAuthMethod?: string;
}

/** A custom MCP server made available to the agent's worker. */
export interface McpServer {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  type?: "sse" | "streamable-http" | "stdio";
  authScope?: "user" | "channel";
  oauth?: McpServerOAuth;
  env?: Record<string, string>;
}

/** A chat-platform binding for an agent (Telegram/Slack/Discord/…). */
export interface Platform {
  /** Platform type: `telegram`, `slack`, `discord`, `whatsapp`, `teams`, `google_chat`, `rest`, … */
  type: string;
  /**
   * Optional display name. Also disambiguates multiple platforms of the same
   * type on one agent (it feeds the stable id `apply` matches on).
   */
  name?: string;
  /**
   * Platform config (e.g. `{ botToken: secret("TELEGRAM_BOT_TOKEN") }`). Values
   * are `secret(...)` refs or literal `$VAR` strings; `lobu apply` keeps the
   * `$VAR` placeholder in the stored config and resolves it at egress. Optional —
   * the `rest` (HTTP API) platform needs no config.
   */
  config?: Record<string, string | SecretRef>;
  /** Declarative channel bindings (`"<teamId>/<channelId>"`); Slack only. */
  channels?: string[];
}

/** Hosted "Lobu Developer" preview-bot config for one chat platform. */
export interface PreviewConfig {
  enabled?: boolean;
  /** Surfaces a preview code can bind: a DM with the bot, or a channel. */
  surfaces?: Array<"dm" | "channel">;
  /** Short-lived claim-code TTL (capped by the hosted preview API). */
  codeTtlMinutes?: number;
}

export interface Agent {
  readonly kind: "agent";
  id: string;
  name?: string;
  description?: string;
  /**
   * Agent directory holding `SOUL.md` / `IDENTITY.md` / `USER.md`. Relative to
   * the config file; defaults to `./agents/<id>`. (Skills are referenced
   * explicitly via {@link Agent.skills}, not auto-discovered from this dir.)
   */
  dir?: string;
  /**
   * Skills this agent can use — built inline with {@link defineSkill} or loaded
   * from a `SKILL.md` with {@link skillFromFile}. Explicit list, no directory
   * auto-discovery; deduped by name.
   */
  skills?: Skill[];
  providers?: ProviderConfig[];
  network?: NetworkConfig;
  egress?: EgressConfig;
  tools?: ToolsConfig;
  /** Guardrails enabled for this agent, by registered name. */
  guardrails?: string[];
  /** Nix packages provisioned into the worker environment. */
  nixPackages?: string[];
  /** Custom MCP servers, keyed by id. */
  mcpServers?: Record<string, McpServer>;
  /** Chat-platform bindings (`lobu apply` upserts each by a stable id). */
  platforms?: Platform[];
  /**
   * Hosted preview-bot config, keyed by chat platform (`slack`/`telegram`).
   * Consumed by `lobu run` (dev-time only) — not part of cloud apply.
   */
  preview?: Record<string, PreviewConfig>;
  // NOTE: the memory schema (entity/relationship types) and connections are
  // declared at the PROJECT level (`defineConfig({ entities, relationships,
  // connections })`), matching the apply model. Chat platforms, however, ARE
  // agent-scoped (each agent owns its bindings) and map to DesiredAgent.platforms.
}

export function defineAgent(config: Omit<Agent, "kind">): Agent {
  return { ...config, kind: "agent" };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * MCP server a skill declares. Skills support the basic transport shape only;
 * for servers that need auth (custom headers or OAuth), declare them on the
 * agent via `defineAgent({ mcpServers })`, which has full secret support.
 */
export interface SkillMcpServer {
  url?: string;
  command?: string;
  args?: string[];
  type?: "sse" | "streamable-http" | "stdio";
}

/**
 * A skill an agent can use — an instruction block (`content`) plus the egress,
 * nix, and MCP it declares. Skills are referenced explicitly from
 * {@link Agent.skills}; there is no directory auto-discovery.
 *
 * Build one of two ways, both producing this same object:
 *   - {@link defineSkill} — inline: `content` is a string, the rest is JSON.
 *   - {@link skillFromFile} — from a `SKILL.md` file (a directory containing
 *     one, or a `.md` path). The loader reads it at `lobu apply` and fills the
 *     fields from its frontmatter + body. `path` is mutually exclusive with the
 *     inline fields.
 *
 * The frontmatter a skill declares (`network`, `nixPackages`, `mcpServers`) is
 * merged into the agent's worker sandbox at apply time — that's why skills are
 * resolved eagerly, not loaded by the worker at run time.
 */
export interface Skill {
  readonly kind: "skill";
  /**
   * Skill name — the reference and dedup key. Required for inline skills. For
   * {@link skillFromFile}, derived from the file's frontmatter `name` (or its
   * folder name) when omitted.
   */
  name?: string;
  description?: string;
  /** The skill body (markdown instructions shown to the agent). */
  content?: string;
  /** Nix packages provisioned into the worker when this skill is present. */
  nixPackages?: string[];
  /** Egress the skill needs — merged into the agent's network allowlist. */
  network?: NetworkConfig;
  /**
   * MCP servers the skill declares, keyed by id. Basic transport shape only; a
   * server that needs auth (headers/OAuth) belongs on the agent's `mcpServers`.
   */
  mcpServers?: Record<string, SkillMcpServer>;
  /**
   * Load body + frontmatter from a `SKILL.md`, relative to the config file. Set
   * by {@link skillFromFile}; resolved by the loader. Mutually exclusive with
   * the inline fields above.
   */
  path?: string;
}

/** Declare a skill inline — `content` is the body, the rest is JSON frontmatter. */
export function defineSkill(
  config: Omit<Skill, "kind" | "path"> & { name: string }
): Skill {
  return { ...config, kind: "skill" };
}

/**
 * Reference a skill stored as a `SKILL.md` file. `path` is a directory holding
 * `SKILL.md` (or a `.md` file directly), relative to the config file. The
 * loader reads it at apply time; pass `name` to override the frontmatter name.
 */
export function skillFromFile(path: string, opts?: { name?: string }): Skill {
  return { kind: "skill", path, ...(opts?.name ? { name: opts.name } : {}) };
}

// ---------------------------------------------------------------------------
// Project (default export of lobu.config.ts)
// ---------------------------------------------------------------------------

export interface Project {
  readonly kind: "project";
  /** Lobu Cloud org slug this project applies to. */
  org?: string;
  /**
   * When true, `lobu apply` deletes definitions (entity/relationship types,
   * watchers, connector definitions) that are absent from this config —
   * INCLUDING ones created via the dashboard/API. Data, connections, auth
   * profiles, and agents are never pruned. Default false.
   */
  prune?: boolean;
  /** Display name used if `lobu apply` offers to provision the org. */
  orgName?: string;
  /** Org description. */
  orgDescription?: string;
  /** Resolved Lobu Cloud org id — `lobu apply` matches against it. */
  organizationId?: string;
  agents: Agent[];
  entities?: EntityType[];
  relationships?: RelationshipType[];
  connections?: Connection[];
  authProfiles?: AuthProfile[];
  watchers?: Watcher[];
  /**
   * Local connector source files (`*.connector.ts`) to compile and ship,
   * built with {@link connectorFromFile}. Explicit list, no `./connectors`
   * auto-discovery; only listed connectors are uploaded.
   */
  connectors?: ConnectorSource[];
}

export function defineConfig(config: Omit<Project, "kind">): Project {
  return { ...config, kind: "project" };
}
