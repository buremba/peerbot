/**
 * Map an authoring project (the default export of `lobu.config.ts`, built by
 * `defineConfig` from `@lobu/cli/config`) to the apply `DesiredState`.
 *
 * `DesiredState` is an apply-internal IR and stays CLI-private; this is the one
 * place that translates the public authoring objects into it. The mapping is
 * pure (modulo `installedAt` timestamps, matching the TOML loader) so it can be
 * unit-tested without importing `lobu.config.ts`.
 */

import { validateEntityMetrics } from "@lobu/connector-sdk/metrics";
import { type AgentSettings, isHostedChatEntry } from "@lobu/core";
import { CronExpressionParser } from "cron-parser";
import type {
  Agent,
  AuthProfile,
  Connection,
  ConnectorRef,
  EntityType,
  InferenceCapabilityBlock,
  OrgProvider,
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
  DesiredOrgProvider,
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

/**
 * Org-provider slug rules — MUST match the DB CHECK in the inference_providers
 * migration exactly (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`): lowercase
 * alphanumeric + hyphen, 1-63 chars, no leading/trailing hyphen. Kept in lockstep
 * so `lobu apply` rejects a bad slug up front instead of the server 500ing on the
 * CHECK. Single-char slugs are allowed; a trailing hyphen (`myvllm-`) is not.
 */
const ORG_PROVIDER_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Modalities the server accepts for an inference-provider capability block. */
const INFERENCE_MODALITIES = new Set([
  "text",
  "image",
  "stt",
  "tts",
  "embedding",
]);

/**
 * Map an org-owned inference provider (`defineConfig({ providers })`) to its
 * `DesiredOrgProvider`. Resolves the API key from its `secret()` / `$VAR` ref
 * to the REAL value at apply time (mirroring {@link resolveCredentialValue} and
 * the agent-provider key path — apply pushes the resolved value to the server,
 * never the `$VAR` placeholder) and collects the ref into `required` so the
 * secrets gate fails loud when unset. Validates the slug + declared modalities
 * so a malformed config fails in the CLI, not with a confusing server 4xx.
 */
function mapOrgProvider(
  provider: OrgProvider,
  required: Set<string>,
  env: NodeJS.ProcessEnv
): DesiredOrgProvider {
  if (!ORG_PROVIDER_SLUG_PATTERN.test(provider.slug)) {
    throw new ValidationError(
      `provider slug "${provider.slug}" must match /^[a-z0-9][a-z0-9-]{0,62}$/ (lowercase letters/digits/hyphens, no leading hyphen, ≤63 chars)`
    );
  }
  if (!provider.kind) {
    throw new ValidationError(
      `provider "${provider.slug}" must declare a non-empty \`kind\``
    );
  }

  const capabilities: Record<string, InferenceCapabilityBlock> = {};
  for (const [modality, block] of Object.entries(provider.capabilities ?? {})) {
    if (!INFERENCE_MODALITIES.has(modality)) {
      throw new ValidationError(
        `provider "${provider.slug}" declares unknown modality "${modality}" (expected text|image|stt|tts|embedding)`
      );
    }
    if (block) capabilities[modality] = block;
  }

  return {
    slug: provider.slug,
    kind: provider.kind,
    ...(provider.displayName ? { displayName: provider.displayName } : {}),
    apiKey: resolveCredentialValue(provider.key, required, env),
    capabilities,
  };
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
 * platform matches (noop) instead of being recreated by
 * `manage_connections(action='apply_chat_connection')`.
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
 * nix is laid down first (already in `settings`), then skill nix packages are
 * unioned on top (deduped). Skills are prompt/behavior only — they no longer
 * contribute network or MCP config.
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
}

function mapAgent(
  agent: Agent,
  env: NodeJS.ProcessEnv,
  required: Set<string>
): DesiredAgent {
  const settings: Partial<AgentSettings> = {};

  if (agent.providers?.length) {
    // installedProviders stays the provider-install/catalog list; the model
    // collapses to a single defaultModel — the primary provider's declared
    // model, or "<providerId>/auto" for its newest live model.
    settings.installedProviders = agent.providers.map((p) => ({
      providerId: providerId(p),
      installedAt: Date.now(),
    }));
    const primary = agent.providers[0];
    if (primary) {
      const primaryModel = primary.model?.trim();
      settings.defaultModel = primaryModel || `${providerId(primary)}/auto`;
    }
  }

  const allowed = agent.network?.allowed ?? [];
  const denied = agent.network?.denied ?? [];
  if (allowed.length > 0 || denied.length > 0) {
    settings.networkConfig = {
      ...(allowed.length > 0 ? { allowedDomains: [...new Set(allowed)] } : {}),
      ...(denied.length > 0 ? { deniedDomains: [...new Set(denied)] } : {}),
    };
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

  const platforms: DesiredPlatform[] = (agent.platforms ?? [])
    // A hosted-bot entry (slack/telegram with no `config`) is reached via the
    // hosted Lobu bot + a `/lobu link` claim, NOT a self-hosted connection. It
    // must never become a credential-less `connections` chat row — `lobu run`
    // reads it straight from the authored config to mint the link code.
    .filter((p) => !isHostedChatEntry(p))
    .map((p) => ({
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
        Object.entries(p.config ?? {}).map(([k, v]) => [
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
  // Fail loud in the CLI before any remote mutation: the server's
  // assertValidBacking would otherwise reject an empty backing mid-apply with a
  // confusing 4xx, possibly after other mutations have already landed.
  if (entity.backing && entity.backing.sql.trim() === "") {
    throw new ValidationError(
      `entity type "${entity.key}" has an empty backing.sql`
    );
  }
  // Declared metrics, included only when present so a non-metric type never
  // churns the diff (mirrors `backing`). The four fields round-trip verbatim.
  const metrics =
    entity.eventSets || entity.measures || entity.dimensions || entity.segments
      ? {
          ...(entity.eventSets ? { eventSets: entity.eventSets } : {}),
          ...(entity.measures ? { measures: entity.measures } : {}),
          ...(entity.dimensions ? { dimensions: entity.dimensions } : {}),
          ...(entity.segments ? { segments: entity.segments } : {}),
        }
      : undefined;
  // Fail loud in the CLI (before any remote mutation) on referential/shape
  // errors the types can't catch — a measure naming a missing eventSet/segment,
  // or a non-`count` measure without `expr`. The server re-validates.
  if (metrics) {
    const errors = validateEntityMetrics(metrics);
    if (errors.length > 0) {
      throw new ValidationError(
        `entity type "${entity.key}" has invalid metrics: ${errors.join("; ")}`
      );
    }
  }
  return {
    slug: entity.key,
    ...(entity.name ? { name: entity.name } : {}),
    ...(entity.description ? { description: entity.description } : {}),
    ...(entity.required ? { required: entity.required } : {}),
    ...(entity.properties ? { properties: entity.properties } : {}),
    // Event kinds included only when declared so a type with none compares equal
    // on both sides and never churns the diff (mirrors `backing`/`metrics`).
    ...(entity.eventKinds && Object.keys(entity.eventKinds).length > 0
      ? { eventKinds: entity.eventKinds }
      : {}),
    // View template included only when declared so absence never churns the diff
    // (a no-prune apply leaves any UI-authored template untouched).
    ...(entity.viewTemplate ? { viewTemplate: entity.viewTemplate } : {}),
    // metadata is carried for config-API compat (defineEntityType consumers may
    // attach it) but is neither diffed nor sent to the server.
    ...(entity.metadata ? { metadata: entity.metadata } : {}),
    // `backing` is present only for derived types; a stored entity (the default)
    // carries no backing so it never churns the diff. `connection` (a slug) is
    // included only when set, so an internal-backed view never churns either.
    ...(entity.backing
      ? {
          backing: {
            sql: entity.backing.sql,
            ...(entity.backing.connection
              ? { connection: entity.backing.connection }
              : {}),
          },
        }
      : {}),
    ...(metrics ? { metrics } : {}),
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
    // metadata is carried for config-API compat (defineRelationshipType
    // consumers may attach it) but is neither diffed nor sent to the server.
    ...(rel.metadata ? { metadata: rel.metadata } : {}),
  };
}

/**
 * The config API authors `keyingConfig` in camelCase (`entityType`, `entityPath`,
 * `keyFields`, `keyOutputField`), but the server stores it verbatim into
 * `keying_config` and reads snake_case keys (`watcher-extraction-schema.ts`,
 * `promote-keyed-entities.ts`). Without this translation an entity-typed watcher
 * authored via config silently lands as untyped (schema derivation + promotion
 * both miss `entity_type`). Translate the known keys; pass any extra keys through.
 */
const KEYING_KEY_MAP: Record<string, string> = {
  entityType: "entity_type",
  entityPath: "entity_path",
  keyFields: "key_fields",
  keyOutputField: "key_output_field",
};
function normalizeKeyingConfig(
  kc: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kc)) out[KEYING_KEY_MAP[k] ?? k] = v;
  return out;
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
    ...(watcher.keyingConfig
      ? { keyingConfig: normalizeKeyingConfig(watcher.keyingConfig) }
      : {}),
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
  // Org providers are skipped under `--only` (they're neither agents nor
  // memory), matching the connector-skip posture — so their secrets aren't
  // demanded on a targeted apply.
  const providers = only
    ? []
    : (project.providers ?? []).map((provider) =>
        mapOrgProvider(provider, required, env)
      );

  // Reject duplicate identifiers per collection (the TOML/YAML loader did this;
  // the TS path must keep parity). Duplicates otherwise generate duplicate plan
  // rows that fail mid-apply or make the desired state ambiguous.
  assertUniqueBy(agents, (a) => a.metadata.agentId, "agent id");
  assertUniqueBy(entityTypes, (e) => e.slug, "entity type key");
  assertUniqueBy(relationshipTypes, (r) => r.slug, "relationship type key");
  assertUniqueBy(watchers, (w) => w.slug, "watcher slug");
  assertUniqueBy(authProfiles, (p) => p.slug, "auth profile slug");
  assertUniqueBy(connections, (c) => c.slug, "connection slug");
  assertUniqueBy(providers, (p) => p.slug, "provider slug");

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
    providers,
    requiredSecrets: [...required].sort(),
  };
}
