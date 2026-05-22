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

import type { ConnectorClass } from "@lobu/connector-sdk";
import type { SecretRef } from "./secret.js";

/** A connector referenced by its key, or by the class produced by `defineConnector`. */
export type ConnectorRef = string | ConnectorClass;

// ---------------------------------------------------------------------------
// Memory schema
// ---------------------------------------------------------------------------

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
  /** UUID pinning syncs/actions to a specific device worker. */
  deviceWorkerId?: string;
  feeds?: ConnectionFeed[];
}

export function defineConnection(config: Omit<Connection, "kind">): Connection {
  return { ...config, kind: "connection" };
}

// ---------------------------------------------------------------------------
// Watchers (reaction handlers are wired in a later slice)
// ---------------------------------------------------------------------------

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
   * Relative POSIX path to a sibling `.ts` reaction script
   * (`./reactions/foo.reaction.ts`), compiled + run in a sandboxed isolate when
   * the watcher fires. The script must `export default async (ctx, client) =>
   * …`. Kept in its own file (not inline) so your IDE type-checks it; the path
   * must stay under the config directory.
   */
  reaction?: string;
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
   * `$VAR` placeholder in the stored config and resolves it at egress.
   */
  config: Record<string, string | SecretRef>;
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
   * Agent directory holding `SOUL.md` / `IDENTITY.md` / `USER.md` and a
   * `skills/` folder. Relative to the config file; defaults to
   * `./agents/<id>`.
   */
  dir?: string;
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
}

export function defineConfig(config: Omit<Project, "kind">): Project {
  return { ...config, kind: "project" };
}
