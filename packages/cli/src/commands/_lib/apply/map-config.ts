/**
 * Map an authoring project (the default export of `lobu.config.ts`, built by
 * `defineConfig` from `@lobu/cli/config`) to the apply `DesiredState`.
 *
 * `DesiredState` is an apply-internal IR and stays CLI-private; this is the one
 * place that translates the public authoring objects into it. The mapping is
 * pure (modulo `installedAt` timestamps, matching the TOML loader) so it can be
 * unit-tested without importing `lobu.config.ts`.
 */

import type { AgentSettings } from "@lobu/core";
import { CronExpressionParser } from "cron-parser";
import type {
  Agent,
  AuthProfile,
  Connection,
  ConnectorRef,
  EntityType,
  McpServer,
  Project,
  ProviderConfig,
  RelationshipType,
  Watcher,
} from "../../../config/index.js";
import { isSecretRef } from "../../../config/index.js";
import { ValidationError } from "../../memory/_lib/errors.js";
import type {
  DesiredAgent,
  DesiredAgentMetadata,
  DesiredAuthProfile,
  DesiredConnection,
  DesiredEntityType,
  DesiredFeed,
  DesiredPlatform,
  DesiredRelationshipType,
  DesiredState,
  DesiredWatcher,
} from "./desired-state.js";

/** Source label recorded on connector docs (mirrors the YAML manifest path). */
const CONFIG_SOURCE = "lobu.config.ts";

// Mirror the TOML loader's structural validators so a malformed TS config fails
// loud in the CLI before any remote mutation, not with a confusing server 4xx.
const CONNECTION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AUTH_PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MIN_CRON_INTERVAL_MS = 60_000;

/** Throw on the first duplicate identifier in a collection (config parity). */
function assertUniqueBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) {
      throw new ValidationError(
        `duplicate ${label} "${k}" in lobu.config.ts — each must be unique`
      );
    }
    seen.add(k);
  }
}

/** Error message if the cron is invalid or fires more than once a minute, else null. */
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

/** `"$NAME"` → `"NAME"`, else null. Mirrors the TOML loader's env-ref detection. */
function envRefName(value: string): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  return match ? (match[1] ?? null) : null;
}

/** Provider id used as the storage key; falls back to the model when omitted. */
function providerId(provider: ProviderConfig): string {
  return provider.id ?? provider.model;
}

/** Resolve a connector reference (key string, or the class from `defineConnector`) to its key. */
function connectorKey(ref: ConnectorRef): string {
  if (typeof ref === "string") return ref;
  return new ref().definition.key;
}

function entitySlug(ref: EntityType | string): string {
  return typeof ref === "string" ? ref : ref.key;
}

function agentId(ref: Agent | string): string {
  return typeof ref === "string" ? ref : ref.id;
}

function authProfileSlug(
  ref: AuthProfile | string | undefined
): string | undefined {
  if (ref === undefined) return undefined;
  return typeof ref === "string" ? ref : ref.slug;
}

/**
 * Deterministic, human-readable stable id for a platform binding, derived from
 * `(agentId, type, name?)`. Must stay stable across applies so the same
 * platform matches (noop) instead of being recreated — `apply` PUTs it to
 * `/platforms/by-stable-id/:stableId`.
 */
function platformStableId(
  agentId: string,
  type: string,
  name?: string
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return [agentId, type, name]
    .filter((p): p is string => !!p)
    .map(slug)
    .filter(Boolean)
    .join("-");
}

/** Credential value → `$VAR` string; collects the referenced secret name. */
function credentialString(
  value: string | { readonly $secret: string },
  required: Set<string>
): string {
  if (isSecretRef(value)) {
    required.add(value.$secret);
    return `$${value.$secret}`;
  }
  const ref = envRefName(value);
  if (ref) required.add(ref);
  return value;
}

/**
 * Resolve a credential to its actual secret value, mirroring the TOML loader's
 * connector-credential handling (`loadConnectors` in desired-state.ts): a
 * `secret()` / `$VAR` ref resolves to its env value — apply pushes the REAL
 * value to the DB, never the `$VAR` placeholder — and a literal passes through.
 * The ref is collected so the apply secrets gate fails loud when it is unset
 * (the placeholder is only returned as a safe fallback the gate then rejects).
 */
function resolveCredentialValue(
  value: string | { readonly $secret: string },
  required: Set<string>,
  env: NodeJS.ProcessEnv
): string {
  if (isSecretRef(value)) {
    required.add(value.$secret);
    return env[value.$secret] ?? `$${value.$secret}`;
  }
  const ref = envRefName(value);
  if (ref) {
    required.add(ref);
    return env[ref] ?? value;
  }
  return value;
}

/** Skill entries resolved from `defineAgent({ skills })` (inline + file). */
type LocalSkills = NonNullable<AgentSettings["skillsConfig"]>["skills"];

/** Agent-dir prompt markdown (read by the loader from SOUL/IDENTITY/USER.md). */
export interface AgentMarkdown {
  soulMd?: string;
  identityMd?: string;
  userMd?: string;
}

/**
 * Merge an agent's file-resolved artifacts (prompt markdown from its dir +
 * skills declared via `defineAgent({ skills })`) into the already-mapped agent
 * settings. Pure (no file IO — the loader reads the files and passes the
 * results in) so it can be unit-tested directly.
 *
 * Mirrors `buildAgentSettings`'s skill-merge semantics exactly: agent-level
 * network/nix/mcp is laid down first (already in `settings`), then skills are
 * merged on top — allowed/denied/nix are unioned (deduped), judged-domains and
 * judges are skill-first with the AGENT WINNING on conflicts, and skill MCP
 * servers add only ids the agent didn't already define.
 */
export function mergeAgentDirArtifacts(
  settings: Partial<AgentSettings>,
  markdown: AgentMarkdown,
  localSkills: LocalSkills
): void {
  if (markdown.soulMd) settings.soulMd = markdown.soulMd;
  if (markdown.identityMd) settings.identityMd = markdown.identityMd;
  if (markdown.userMd) settings.userMd = markdown.userMd;

  if (localSkills.length > 0) {
    settings.skillsConfig = { skills: localSkills };
  }

  // Network merge — agent values are already in settings.networkConfig.
  const allowed = [...(settings.networkConfig?.allowedDomains ?? [])];
  const denied = [...(settings.networkConfig?.deniedDomains ?? [])];
  const judgedByDomain = new Map<string, { domain: string; judge?: string }>();
  const judges: Record<string, string> = {};
  // Skills first.
  for (const skill of localSkills) {
    const net = skill.networkConfig;
    if (!net) continue;
    if (net.allowedDomains?.length) {
      allowed.push(...net.allowedDomains.filter((d) => d !== "*"));
    }
    if (net.deniedDomains?.length) denied.push(...net.deniedDomains);
    for (const rule of net.judgedDomains ?? []) {
      judgedByDomain.set(rule.domain, rule);
    }
    if (net.judges) Object.assign(judges, net.judges);
  }
  // Agent overrides skills on judged/judges.
  for (const rule of settings.networkConfig?.judgedDomains ?? []) {
    judgedByDomain.set(rule.domain, rule);
  }
  Object.assign(judges, settings.networkConfig?.judges ?? {});

  const judgedDomains = [...judgedByDomain.values()];
  const hasJudges = Object.keys(judges).length > 0;
  if (
    allowed.length > 0 ||
    denied.length > 0 ||
    judgedDomains.length > 0 ||
    hasJudges
  ) {
    settings.networkConfig = {
      ...(allowed.length > 0 ? { allowedDomains: [...new Set(allowed)] } : {}),
      ...(denied.length > 0 ? { deniedDomains: [...new Set(denied)] } : {}),
      ...(judgedDomains.length > 0 ? { judgedDomains } : {}),
      ...(hasJudges ? { judges } : {}),
    };
  }

  // Nix merge — agent packages first, then skill packages, deduped.
  const nixPackages = [
    ...(settings.nixConfig?.packages ?? []),
    ...localSkills.flatMap((s) => s.nixPackages ?? []),
  ];
  if (nixPackages.length > 0) {
    settings.nixConfig = {
      ...settings.nixConfig,
      packages: [...new Set(nixPackages)],
    };
  }

  // MCP merge — agent servers win; skills add only ids the agent didn't define.
  const mcpServers: Record<string, unknown> = { ...settings.mcpServers };
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
}

/**
 * Map SDK MCP server config to the agent-settings shape. Mirrors the TOML
 * loader, including the loose cast: `authScope`/`oauth` aren't on the typed
 * `McpServerConfig`, but the server accepts them. `$VAR` refs in headers/env and
 * a `secret()` (or `$VAR`) `clientSecret` are collected into `required` so the
 * apply secrets gate fails loud, and passed through verbatim (the server/secret
 * proxy resolves them) — matching `buildAgentSettings`.
 */
function mapMcpServers(
  servers: Record<string, McpServer>,
  required: Set<string>
): NonNullable<AgentSettings["mcpServers"]> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, mcp] of Object.entries(servers)) {
    const mapped: Record<string, unknown> = {};
    if (mcp.url) mapped.url = mcp.url;
    // We DO map `type` (an intentional, more-correct improvement over the
    // legacy agent-level TOML loader, which dropped it even though its
    // skill-merge path kept it — and `McpServerConfig.type` is a real field).
    if (mcp.type) mapped.type = mcp.type;
    if (mcp.command) mapped.command = mcp.command;
    if (mcp.args) mapped.args = mcp.args;
    if (mcp.headers) {
      for (const v of Object.values(mcp.headers)) {
        const ref = envRefName(v);
        if (ref) required.add(ref);
      }
      mapped.headers = { ...mcp.headers };
    }
    if (mcp.env) {
      for (const v of Object.values(mcp.env)) {
        const ref = envRefName(v);
        if (ref) required.add(ref);
      }
      mapped.env = { ...mcp.env };
    }
    if (mcp.authScope) mapped.authScope = mcp.authScope;
    if (mcp.oauth) {
      // `client_id` may itself be a `$VAR` ref — collect it like the TOML
      // loader's collectEnvRefs does (it's passed through verbatim).
      if (mcp.oauth.clientId) {
        const ref = envRefName(mcp.oauth.clientId);
        if (ref) required.add(ref);
      }
      mapped.oauth = {
        authUrl: mcp.oauth.authUrl,
        tokenUrl: mcp.oauth.tokenUrl,
        ...(mcp.oauth.clientId ? { clientId: mcp.oauth.clientId } : {}),
        ...(mcp.oauth.clientSecret
          ? { clientSecret: credentialString(mcp.oauth.clientSecret, required) }
          : {}),
        ...(mcp.oauth.scopes ? { scopes: mcp.oauth.scopes } : {}),
        ...(mcp.oauth.tokenEndpointAuthMethod
          ? { tokenEndpointAuthMethod: mcp.oauth.tokenEndpointAuthMethod }
          : {}),
      };
    }
    out[id] = mapped;
  }
  return out as NonNullable<AgentSettings["mcpServers"]>;
}

function mapAgent(
  agent: Agent,
  env: NodeJS.ProcessEnv,
  required: Set<string>
): DesiredAgent {
  const settings: Partial<AgentSettings> = {};

  if (agent.providers?.length) {
    settings.installedProviders = agent.providers.map((p) => ({
      providerId: providerId(p),
      installedAt: Date.now(),
    }));
    settings.modelSelection = { mode: "auto" };
    const preferences = Object.fromEntries(
      agent.providers
        .filter((p) => !!p.model?.trim())
        .map((p) => [providerId(p), p.model.trim()])
    );
    if (Object.keys(preferences).length > 0) {
      settings.providerModelPreferences = preferences;
    }
  }

  const allowed = agent.network?.allowed ?? [];
  const denied = agent.network?.denied ?? [];
  const judges = agent.network?.judges ?? {};
  const hasJudges = Object.keys(judges).length > 0;
  // Dedup judged rules by domain (last wins), matching buildAgentSettings.
  const judgedByDomain = new Map<string, { domain: string; judge?: string }>();
  for (const rule of agent.network?.judged ?? []) {
    judgedByDomain.set(rule.domain, {
      domain: rule.domain,
      ...(rule.judge ? { judge: rule.judge } : {}),
    });
  }
  const judgedDomains = [...judgedByDomain.values()];
  if (
    allowed.length > 0 ||
    denied.length > 0 ||
    judgedDomains.length > 0 ||
    hasJudges
  ) {
    settings.networkConfig = {
      ...(allowed.length > 0 ? { allowedDomains: [...new Set(allowed)] } : {}),
      ...(denied.length > 0 ? { deniedDomains: [...new Set(denied)] } : {}),
      ...(judgedDomains.length > 0 ? { judgedDomains } : {}),
      ...(hasJudges ? { judges } : {}),
    };
  }

  if (agent.egress) {
    const egressConfig: NonNullable<AgentSettings["egressConfig"]> = {};
    if (agent.egress.extraPolicy) {
      egressConfig.extraPolicy = agent.egress.extraPolicy;
    }
    if (agent.egress.judgeModel)
      egressConfig.judgeModel = agent.egress.judgeModel;
    if (Object.keys(egressConfig).length > 0)
      settings.egressConfig = egressConfig;
  }

  if (agent.tools) {
    if (agent.tools.preApproved?.length) {
      settings.preApprovedTools = [...new Set(agent.tools.preApproved)];
    }
    const toolsConfig: NonNullable<AgentSettings["toolsConfig"]> = {};
    if (agent.tools.allowed?.length) {
      toolsConfig.allowedTools = [...new Set(agent.tools.allowed)];
    }
    if (agent.tools.denied?.length) {
      toolsConfig.deniedTools = [...new Set(agent.tools.denied)];
    }
    if (agent.tools.strict !== undefined)
      toolsConfig.strictMode = agent.tools.strict;
    if (Object.keys(toolsConfig).length > 0) settings.toolsConfig = toolsConfig;
  }

  if (agent.guardrails?.length) {
    settings.guardrails = [...new Set(agent.guardrails)];
  }

  if (agent.nixPackages?.length) {
    settings.nixConfig = { packages: [...new Set(agent.nixPackages)] };
  }

  if (agent.mcpServers && Object.keys(agent.mcpServers).length > 0) {
    settings.mcpServers = mapMcpServers(agent.mcpServers, required);
  }

  const providerKeys: { providerId: string; value: string }[] = [];
  for (const provider of agent.providers ?? []) {
    if (provider.key === undefined) continue;
    if (isSecretRef(provider.key)) {
      required.add(provider.key.$secret);
      const value = env[provider.key.$secret];
      if (value) providerKeys.push({ providerId: providerId(provider), value });
      continue;
    }
    const ref = envRefName(provider.key);
    if (ref) {
      required.add(ref);
      const value = env[ref];
      if (value) providerKeys.push({ providerId: providerId(provider), value });
      continue;
    }
    providerKeys.push({
      providerId: providerId(provider),
      value: provider.key,
    });
  }

  const platforms: DesiredPlatform[] = (agent.platforms ?? []).map((p) => ({
    stableId: platformStableId(agent.id, p.type, p.name),
    type: p.type,
    ...(p.name ? { name: p.name } : {}),
    // Resolve `secret()`/`$VAR` to the REAL value — the platform-write path
    // stores the incoming plaintext as the secret (server-side
    // `normalizeConfigForStorage` swaps it for a `secret://` ref + encrypts it),
    // so sending the `$VAR` placeholder would persist a broken token. Mirrors
    // provider keys + auth-profile credentials. The config row never holds
    // cleartext at rest; the secret name is collected for the secrets gate.
    config: Object.fromEntries(
      Object.entries(p.config).map(([k, v]) => [
        k,
        resolveCredentialValue(v, required, env),
      ])
    ),
    ...(p.channels?.length ? { channels: p.channels } : {}),
  }));
  // Distinct platforms must not collapse to the same stable id (e.g. names that
  // slugify equal), or apply would clobber one with the other.
  const seenStableIds = new Set<string>();
  for (const p of platforms) {
    if (seenStableIds.has(p.stableId)) {
      throw new ValidationError(
        `agent "${agent.id}" has two platforms that resolve to the same id "${p.stableId}" — give them distinct names`
      );
    }
    seenStableIds.add(p.stableId);
    // Channel bindings are Slack-only and must be "<teamId>/<channelId>".
    // Validate up front (the TOML loader did) so a bad binding fails the plan
    // instead of erroring at syncPlatformChannels after platforms are mutated.
    if (p.channels?.length) {
      if (p.type !== "slack") {
        throw new ValidationError(
          `agent "${agent.id}" platform "${p.type}" declares channels, but channel bindings are only supported on slack`
        );
      }
      for (const channel of p.channels) {
        if (!/^[^/\s]+\/[^/\s]+$/.test(channel)) {
          throw new ValidationError(
            `agent "${agent.id}" slack platform has an invalid channel "${channel}" — expected "<teamId>/<channelId>"`
          );
        }
      }
    }
  }

  const metadata: DesiredAgentMetadata = {
    agentId: agent.id,
    name: agent.name ?? agent.id,
  };
  if (agent.description) metadata.description = agent.description;

  return { metadata, settings, platforms, providerKeys };
}

function mapEntityType(entity: EntityType): DesiredEntityType {
  return {
    slug: entity.key,
    ...(entity.name ? { name: entity.name } : {}),
    ...(entity.description ? { description: entity.description } : {}),
    ...(entity.required ? { required: entity.required } : {}),
    ...(entity.properties ? { properties: entity.properties } : {}),
    ...(entity.metadata ? { metadata: entity.metadata } : {}),
  };
}

function mapRelationshipType(rel: RelationshipType): DesiredRelationshipType {
  return {
    slug: rel.key,
    ...(rel.name ? { name: rel.name } : {}),
    ...(rel.description ? { description: rel.description } : {}),
    ...(rel.rules
      ? {
          rules: rel.rules.map((rule) => ({
            source: entitySlug(rule.source),
            target: entitySlug(rule.target),
          })),
        }
      : {}),
    ...(rel.metadata ? { metadata: rel.metadata } : {}),
  };
}

function mapWatcher(watcher: Watcher): DesiredWatcher {
  if (watcher.schedule) {
    const err = cronError(watcher.schedule);
    if (err) {
      throw new ValidationError(
        `watcher "${watcher.slug}" has an invalid schedule "${watcher.schedule}": ${err}`
      );
    }
  }
  const sources = watcher.sources
    ? Object.entries(watcher.sources).map(([name, query]) => ({ name, query }))
    : undefined;
  return {
    slug: watcher.slug,
    agent: agentId(watcher.agent),
    prompt: watcher.prompt,
    extractionSchema: watcher.extractionSchema,
    ...(watcher.name ? { name: watcher.name } : {}),
    ...(watcher.description ? { description: watcher.description } : {}),
    ...(watcher.schedule ? { schedule: watcher.schedule } : {}),
    ...(sources ? { sources } : {}),
    ...(watcher.notification?.channel
      ? { notificationChannel: watcher.notification.channel }
      : {}),
    ...(watcher.notification?.priority
      ? { notificationPriority: watcher.notification.priority }
      : {}),
    ...(watcher.minCooldownSeconds !== undefined
      ? { minCooldownSeconds: watcher.minCooldownSeconds }
      : {}),
    ...(watcher.tags ? { tags: watcher.tags } : {}),
    ...(watcher.reactionsGuidance
      ? { reactionsGuidance: watcher.reactionsGuidance }
      : {}),
    ...(watcher.agentKind ? { agentKind: watcher.agentKind } : {}),
  };
}

function mapAuthProfile(
  profile: AuthProfile,
  required: Set<string>,
  env: NodeJS.ProcessEnv
): DesiredAuthProfile {
  if (!AUTH_PROFILE_SLUG_PATTERN.test(profile.slug)) {
    throw new ValidationError(
      `auth profile slug "${profile.slug}" must match /^[a-z0-9][a-z0-9-]{0,79}$/ (lowercase letters/digits/hyphens, no leading hyphen, ≤80 chars)`
    );
  }
  const interactive =
    profile.authKind === "oauth_account" ||
    profile.authKind === "browser_session";
  if (
    interactive &&
    profile.credentials &&
    Object.keys(profile.credentials).length > 0
  ) {
    throw new ValidationError(
      `auth profile "${profile.slug}" has kind "${profile.authKind}" — credentials must not be set; lobu apply never writes interactive-auth tokens (complete auth via the connect URL)`
    );
  }
  const credentials =
    profile.credentials && !interactive
      ? Object.fromEntries(
          Object.entries(profile.credentials).map(([key, value]) => [
            key,
            resolveCredentialValue(value, required, env),
          ])
        )
      : undefined;
  return {
    slug: profile.slug,
    connector: connectorKey(profile.connector),
    kind: profile.authKind,
    sourceFile: CONFIG_SOURCE,
    ...(profile.name ? { name: profile.name } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

function mapConnection(connection: Connection): DesiredConnection {
  if (!CONNECTION_SLUG_PATTERN.test(connection.slug)) {
    throw new ValidationError(
      `connection slug "${connection.slug}" must match /^[a-z0-9][a-z0-9-]{0,62}$/ (lowercase letters/digits/hyphens, no leading hyphen, ≤63 chars)`
    );
  }
  const seenFeeds = new Set<string>();
  const feeds: DesiredFeed[] = (connection.feeds ?? []).map((feed) => {
    if (seenFeeds.has(feed.feed)) {
      throw new ValidationError(
        `connection "${connection.slug}" declares feed "${feed.feed}" more than once`
      );
    }
    seenFeeds.add(feed.feed);
    if (feed.schedule) {
      const err = cronError(feed.schedule);
      if (err) {
        throw new ValidationError(
          `connection "${connection.slug}" feed "${feed.feed}" has an invalid schedule "${feed.schedule}": ${err}`
        );
      }
    }
    return {
      feedKey: feed.feed,
      ...(feed.name ? { name: feed.name } : {}),
      ...(feed.schedule ? { schedule: feed.schedule } : {}),
      ...(feed.config ? { config: feed.config } : {}),
    };
  });
  const authSlug = authProfileSlug(connection.authProfile);
  const appAuthSlug = authProfileSlug(connection.appAuthProfile);
  // A managed connection's grant lives in a cloud (public) org. Fold the
  // `managedBy` descriptor into the persisted connection `config` so the server
  // resolver (execution-context.ts) can detect it and fetch the user's token
  // from the cloud at runtime — no new column or CRUD field needed. It lives in
  // the trusted connection `config` (never in `auth_data`).
  const config = connection.managedBy
    ? { ...(connection.config ?? {}), managedBy: { ...connection.managedBy } }
    : connection.config;
  return {
    slug: connection.slug,
    connector: connectorKey(connection.connector),
    feeds,
    sourceFile: CONFIG_SOURCE,
    ...(connection.name ? { name: connection.name } : {}),
    ...(authSlug ? { authProfileSlug: authSlug } : {}),
    ...(appAuthSlug ? { appAuthProfileSlug: appAuthSlug } : {}),
    ...(config ? { config } : {}),
    ...(connection.deviceWorkerId
      ? { deviceWorkerId: connection.deviceWorkerId }
      : {}),
  };
}

/**
 * Translate an authoring project into the apply `DesiredState`. When `only` is
 * set, connector definitions/connections/auth-profiles are skipped (and their
 * secrets not collected), matching the TOML loader's `--only` behavior so
 * `lobu apply --only agents` doesn't demand connector secrets.
 */
export function mapProjectToDesiredState(
  project: Project,
  env: NodeJS.ProcessEnv = process.env,
  only?: "agents" | "memory"
): DesiredState {
  const required = new Set<string>();

  const agents = project.agents.map((agent) => mapAgent(agent, env, required));
  const entityTypes = (project.entities ?? []).map(mapEntityType);
  const relationshipTypes = (project.relationships ?? []).map(
    mapRelationshipType
  );
  const watchers = (project.watchers ?? []).map(mapWatcher);
  const authProfiles = only
    ? []
    : (project.authProfiles ?? []).map((profile) =>
        mapAuthProfile(profile, required, env)
      );
  const connections = only
    ? []
    : (project.connections ?? []).map(mapConnection);

  // Reject duplicate identifiers per collection (the TOML/YAML loader did this;
  // the TS path must keep parity). Duplicates otherwise generate duplicate plan
  // rows that fail mid-apply or make the desired state ambiguous.
  assertUniqueBy(agents, (a) => a.metadata.agentId, "agent id");
  assertUniqueBy(entityTypes, (e) => e.slug, "entity type key");
  assertUniqueBy(relationshipTypes, (r) => r.slug, "relationship type key");
  assertUniqueBy(watchers, (w) => w.slug, "watcher slug");
  assertUniqueBy(authProfiles, (p) => p.slug, "auth profile slug");
  assertUniqueBy(connections, (c) => c.slug, "connection slug");

  const agentIds = new Set(project.agents.map((agent) => agent.id));
  for (const watcher of watchers) {
    if (!agentIds.has(watcher.agent)) {
      throw new ValidationError(
        `watcher "${watcher.slug}" names agent "${watcher.agent}", but no agent with that id is declared in lobu.config.ts`
      );
    }
  }

  const memory: NonNullable<DesiredState["memory"]> = {};
  if (project.org) memory.org = project.org;
  if (project.orgName) memory.name = project.orgName;
  if (project.orgDescription) memory.description = project.orgDescription;
  if (project.organizationId) memory.organizationId = project.organizationId;

  return {
    agents,
    prune: project.prune ?? false,
    ...(Object.keys(memory).length > 0 ? { memory } : {}),
    memorySchema: { entityTypes, relationshipTypes },
    watchers,
    connectors: { definitions: [], authProfiles, connections },
    requiredSecrets: [...required].sort(),
  };
}
