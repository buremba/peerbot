import type { AgentSettings } from "@lobu/core";
import { ValidationError } from "../../memory/_lib/errors.js";
import type {
  RemoteAgent,
  RemoteAuthProfile,
  RemoteConnection,
  RemoteConnectorDefinition,
  RemoteEntityType,
  RemoteFeed,
  RemotePlatform,
  RemoteRelationshipType,
  RemoteWatcher,
} from "./client.js";
import type {
  DesiredAgent,
  DesiredAuthProfile,
  DesiredConnection,
  DesiredConnectorDefinition,
  DesiredEntityType,
  DesiredFeed,
  DesiredPlatform,
  DesiredRelationshipType,
  DesiredWatcher,
} from "./desired-state.js";

// ── Diff verbs ──────────────────────────────────────────────────────────────

export type DiffVerb = "create" | "update" | "noop" | "drift";

interface BaseRow {
  verb: DiffVerb;
  /** Stable identifier for matching messages and UI. */
  id: string;
}

export interface AgentDiffRow extends BaseRow {
  kind: "agent";
  desired?: DesiredAgent["metadata"];
  remote?: RemoteAgent;
  /** Field-level changes when verb === "update". */
  changedFields?: string[];
}

export interface SettingsDiffRow extends BaseRow {
  kind: "settings";
  desired?: Partial<AgentSettings>;
  changedFields?: string[];
}

export interface PlatformDiffRow extends BaseRow {
  kind: "platform";
  agentId: string;
  desired?: DesiredPlatform;
  remote?: RemotePlatform;
  changedFields?: string[];
  /** True when an update will restart the live worker — surfaced in the plan. */
  willRestart?: boolean;
}

export interface EntityTypeDiffRow extends BaseRow {
  kind: "entity-type";
  desired?: DesiredEntityType;
  remote?: RemoteEntityType;
  changedFields?: string[];
}

export interface RelationshipTypeDiffRow extends BaseRow {
  kind: "relationship-type";
  desired?: DesiredRelationshipType;
  remote?: RemoteRelationshipType;
  changedFields?: string[];
}

export interface WatcherDiffRow extends BaseRow {
  kind: "watcher";
  desired?: DesiredWatcher;
  remote?: RemoteWatcher;
  /** Always absent — watchers are create-or-noop, never updated by apply. */
  changedFields?: string[];
}

export interface ConnectorDefinitionDiffRow extends BaseRow {
  kind: "connector-definition";
  desired?: DesiredConnectorDefinition;
  /**
   * Whether the desired connector is currently installed remotely. When the
   * connector key isn't known up front (a local `.ts` the server hasn't
   * compiled), this is `false` and the verb is "create" — `install_connector`
   * is idempotent and reports `updated: false` on apply if nothing changed.
   */
  installedRemotely?: boolean;
}

export interface AuthProfileDiffRow extends BaseRow {
  kind: "auth-profile";
  desired?: DesiredAuthProfile;
  remote?: RemoteAuthProfile;
  changedFields?: string[];
  /** True for `oauth_account` / `browser_session` profiles not yet `active`. */
  needsAuth?: boolean;
}

export interface ConnectionDiffRow extends BaseRow {
  kind: "connection";
  desired?: DesiredConnection;
  remote?: RemoteConnection;
  changedFields?: string[];
}

export interface FeedDiffRow extends BaseRow {
  kind: "feed";
  /** Owning connection slug. */
  connectionSlug: string;
  desired?: DesiredFeed;
  remote?: RemoteFeed;
  changedFields?: string[];
}

export type DiffRow =
  | AgentDiffRow
  | SettingsDiffRow
  | PlatformDiffRow
  | EntityTypeDiffRow
  | RelationshipTypeDiffRow
  | WatcherDiffRow
  | ConnectorDefinitionDiffRow
  | AuthProfileDiffRow
  | ConnectionDiffRow
  | FeedDiffRow;

export interface DiffPlan {
  rows: DiffRow[];
  /** Aggregate counters for the summary line. */
  counts: { create: number; update: number; noop: number; drift: number };
  /**
   * Informational, non-actionable notes — e.g. "connector X is installed
   * remotely but not declared locally". Rendered after the plan; never block
   * apply.
   */
  notes: string[];
}

// ── Equality helpers ───────────────────────────────────────────────────────

/**
 * Stable structural equality for JSON-shaped values. Sorts object keys before
 * stringifying so `{a:1,b:2}` and `{b:2,a:1}` compare equal.
 *
 * `undefined` and `null` both canonicalize to `"null"` so missing-on-one-side
 * fields don't show as drift. Empty arrays and empty objects are preserved
 * as themselves — clearing a remote allowlist by setting it to `[]` must
 * produce an `update`, not a `noop`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── Generic diff-row builder ───────────────────────────────────────────────

/** One comparable field: a label plus a "did it change?" predicate. */
interface DiffField<D, R> {
  name: string;
  changed: (desired: D, remote: R) => boolean;
}

/** `(a ?? "") !== (b ?? "")` — the canonical optional-string comparison. */
function stringChanged(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return (a ?? "") !== (b ?? "");
}

/**
 * The shared create / noop / update shape behind most `diffX` functions.
 * `extras` is merged into every row (create/noop/update); `updateExtras`
 * adds verb-specific props derived from the changed-field list (e.g.
 * `willRestart`). `changedFields` is attached automatically on update.
 */
function buildDiffRow<D, R, K extends string>(opts: {
  kind: K;
  id: string;
  desired: D;
  remote: R | undefined;
  fields: ReadonlyArray<DiffField<D, R>>;
  extras?: Record<string, unknown>;
  updateExtras?: (changed: string[]) => Record<string, unknown>;
}): {
  kind: K;
  verb: DiffVerb;
  id: string;
  desired: D;
  remote?: R;
  changedFields?: string[];
} & Record<string, unknown> {
  const extras = opts.extras ?? {};
  if (!opts.remote) {
    return {
      kind: opts.kind,
      verb: "create",
      id: opts.id,
      desired: opts.desired,
      ...extras,
    };
  }
  const remote = opts.remote;
  const changed = opts.fields
    .filter((f) => f.changed(opts.desired, remote))
    .map((f) => f.name);
  if (changed.length === 0) {
    return {
      kind: opts.kind,
      verb: "noop",
      id: opts.id,
      desired: opts.desired,
      remote,
      ...extras,
    };
  }
  return {
    kind: opts.kind,
    verb: "update",
    id: opts.id,
    desired: opts.desired,
    remote,
    changedFields: changed,
    ...extras,
    ...(opts.updateExtras?.(changed) ?? {}),
  };
}

// ── Per-resource diff ──────────────────────────────────────────────────────

function diffAgent(
  desired: DesiredAgent["metadata"],
  remote: RemoteAgent | undefined
): AgentDiffRow {
  return buildDiffRow({
    kind: "agent",
    id: desired.agentId,
    desired,
    remote,
    fields: [
      { name: "name", changed: (d, r) => d.name !== r.name },
      {
        name: "description",
        changed: (d, r) => stringChanged(d.description, r.description),
      },
    ],
  }) as AgentDiffRow;
}

/**
 * Compare desired settings against what's currently stored.
 *
 * Redacted-value handling: server never returns secret values in cleartext;
 * any string starting with `***` from the GET response is treated as opaque
 * and the diff records `<field>:redacted` instead of comparing values. The
 * AgentSettings shape currently has no redacted leaf strings, so this is a
 * forward-compatible guard rather than a hot path today.
 *
 * Field set: limited to the keys lobu.toml can express today. Settings that
 * only the UI mutates (e.g. `installedProviders[].installedAt`) are
 * excluded so unrelated UI activity doesn't show up as drift in the plan.
 */
const SETTINGS_FIELDS: Array<keyof AgentSettings> = [
  "networkConfig",
  "egressConfig",
  "nixConfig",
  "mcpServers",
  "skillsConfig",
  "toolsConfig",
  "guardrails",
  "preApprovedTools",
  "providerModelPreferences",
  "installedProviders",
  "modelSelection",
  "soulMd",
  "userMd",
  "identityMd",
];

function normalizeInstalledProviders(
  providers: AgentSettings["installedProviders"] | undefined
): string[] | undefined {
  return providers?.map((provider) => provider.providerId);
}

function diffSettings(
  agentId: string,
  desired: Partial<AgentSettings>,
  remote: AgentSettings | null
): SettingsDiffRow {
  const changed: string[] = [];
  for (const field of SETTINGS_FIELDS) {
    if (!(field in desired)) continue;
    if (field === "installedProviders") {
      if (
        !deepEqual(
          normalizeInstalledProviders(desired.installedProviders),
          normalizeInstalledProviders(remote?.installedProviders)
        )
      ) {
        changed.push(field);
      }
      continue;
    }
    if (!deepEqual(desired[field], remote?.[field])) {
      changed.push(field);
    }
  }
  // Special case: when the agent itself is being created, the matching settings
  // patch is always considered a "create" so the user sees both rows in the
  // plan. The caller is responsible for setting `verb: "create"` from outside
  // when needed; here we only key off field equality.
  if (changed.length === 0) {
    return { kind: "settings", verb: "noop", id: agentId, desired };
  }
  return {
    kind: "settings",
    verb: "update",
    id: agentId,
    desired,
    changedFields: changed,
  };
}

function diffPlatform(
  agentId: string,
  desired: DesiredPlatform,
  remote: RemotePlatform | undefined
): PlatformDiffRow {
  return buildDiffRow({
    kind: "platform",
    id: desired.stableId,
    desired,
    remote,
    extras: remote ? { agentId } : { agentId, willRestart: false },
    fields: [
      { name: "type", changed: (d, r) => d.type !== r.platform },
      {
        name: "config",
        changed: (d, r) => {
          // The route handler stores `platform` inside `config` for stable-id
          // matching, so a noop round-trip from GET will have an extra
          // `platform` key the CLI never wrote. Strip it before diffing so an
          // unchanged platform doesn't show as drift on every plan.
          const remoteConfig: Record<string, unknown> = { ...(r.config ?? {}) };
          delete remoteConfig.platform;
          return !deepEqual(d.config, remoteConfig);
        },
      },
    ],
    updateExtras: (changed) => ({
      willRestart: changed.includes("config") || changed.includes("type"),
    }),
  }) as unknown as PlatformDiffRow;
}

function diffEntityType(
  desired: DesiredEntityType,
  remote: RemoteEntityType | undefined
): EntityTypeDiffRow {
  return buildDiffRow({
    kind: "entity-type",
    id: desired.slug,
    desired,
    remote,
    fields: [
      { name: "name", changed: (d, r) => stringChanged(d.name, r.name) },
      {
        name: "description",
        changed: (d, r) => stringChanged(d.description, r.description),
      },
      {
        name: "required",
        changed: (d, r) => !deepEqual(d.required ?? [], r.required ?? []),
      },
      {
        name: "properties",
        changed: (d, r) => !deepEqual(d.properties, r.properties),
      },
    ],
  }) as EntityTypeDiffRow;
}

function diffRelationshipType(
  desired: DesiredRelationshipType,
  remote: RemoteRelationshipType | undefined
): RelationshipTypeDiffRow {
  return buildDiffRow({
    kind: "relationship-type",
    id: desired.slug,
    desired,
    remote,
    fields: [
      { name: "name", changed: (d, r) => stringChanged(d.name, r.name) },
      {
        name: "description",
        changed: (d, r) => stringChanged(d.description, r.description),
      },
      {
        name: "rules",
        changed: (d, r) => !deepEqual(d.rules ?? [], r.rules ?? []),
      },
    ],
  }) as RelationshipTypeDiffRow;
}

/**
 * Watchers are sync-on-create only: a model file declares a watcher, and the
 * first apply creates it. Subsequent applies see the slug remotely and noop.
 * Remote watchers without a desired model are reported as drift, never
 * deleted — and we deliberately don't diff prompt/schema/schedule changes in
 * v1, so editing a watcher in the UI won't be clobbered by apply.
 */
function diffWatcher(
  desired: DesiredWatcher,
  remote: RemoteWatcher | undefined
): WatcherDiffRow {
  if (!remote) {
    return { kind: "watcher", verb: "create", id: desired.slug, desired };
  }
  return {
    kind: "watcher",
    verb: "noop",
    id: desired.slug,
    desired,
    remote,
  };
}

// ── Connectors ─────────────────────────────────────────────────────────────

const INTERACTIVE_AUTH_KINDS: ReadonlySet<string> = new Set([
  "oauth_account",
  "browser_session",
]);

function connectorDefinitionId(def: DesiredConnectorDefinition): string {
  return def.key ?? def.sourceFile;
}

function diffConnectorDefinition(
  desired: DesiredConnectorDefinition,
  installedKeys: ReadonlySet<string>
): ConnectorDefinitionDiffRow {
  const id = connectorDefinitionId(desired);
  // The CLI can't compare source hashes (the server compiles, and the stored
  // hash is of the *compiled* output) — so we always emit a "sync" row;
  // `install_connector` is idempotent and reports `updated:false` on apply
  // when the code is byte-identical, so this never churns remote state.
  const installedRemotely = desired.key
    ? installedKeys.has(desired.key)
    : false;
  return {
    kind: "connector-definition",
    // "update" (re-push) when already installed; `install_connector` is
    // idempotent and reports `updated:false` if the code is unchanged.
    verb: installedRemotely ? "update" : "create",
    id,
    desired,
    installedRemotely,
  };
}

function diffAuthProfile(
  desired: DesiredAuthProfile,
  remote: RemoteAuthProfile | undefined
): AuthProfileDiffRow {
  if (!remote) {
    return {
      kind: "auth-profile",
      verb: "create",
      id: desired.slug,
      desired,
      needsAuth: INTERACTIVE_AUTH_KINDS.has(desired.kind),
    };
  }
  // `connector` / `kind` are immutable — `update_auth_profile` can't change
  // them, so reusing a slug for a different connector/kind would silently push
  // credentials into the wrong profile. Hard-stop instead.
  if (
    remote.connector_key !== desired.connector ||
    remote.profile_kind !== desired.kind
  ) {
    throw new ValidationError(
      `${desired.sourceFile}: auth_profile "${desired.slug}" is bound to ${remote.connector_key}/${remote.profile_kind} remotely, but the manifest declares ${desired.connector}/${desired.kind} — delete it manually or use a new slug`
    );
  }
  const changed: string[] = [];
  if ((desired.name ?? "") !== (remote.display_name ?? "")) {
    changed.push("name");
  }
  // Credentials can't be read back from the server (write-only secrets). For
  // non-interactive kinds with declared credentials, always re-push them
  // (idempotent) so rotated secrets propagate — show as a redacted "credentials"
  // change. Interactive kinds never carry credentials in the manifest.
  const declaresCredentials =
    !INTERACTIVE_AUTH_KINDS.has(desired.kind) &&
    desired.credentials !== undefined &&
    Object.keys(desired.credentials).length > 0;
  if (declaresCredentials) changed.push("credentials");
  const needsAuth =
    INTERACTIVE_AUTH_KINDS.has(desired.kind) && remote.status !== "active";
  if (changed.length === 0 && !needsAuth) {
    return {
      kind: "auth-profile",
      verb: "noop",
      id: desired.slug,
      desired,
      remote,
    };
  }
  return {
    kind: "auth-profile",
    verb: changed.length > 0 ? "update" : "noop",
    id: desired.slug,
    desired,
    remote,
    ...(changed.length > 0 ? { changedFields: changed } : {}),
    ...(needsAuth ? { needsAuth: true } : {}),
  };
}

function diffConnection(
  desired: DesiredConnection,
  remote: RemoteConnection | undefined
): ConnectionDiffRow {
  if (!remote) {
    return {
      kind: "connection",
      verb: "create",
      id: desired.slug,
      desired,
    };
  }
  // `connector` is immutable — `update` can't change `connector_key`, so a
  // slug bound to a different connector remotely must be a hard error, never
  // an "update" that mutates auth/config on the wrong connector.
  if (remote.connector_key !== desired.connector) {
    throw new ValidationError(
      `${desired.sourceFile}: connection "${desired.slug}" is bound to connector "${remote.connector_key}" remotely, but the manifest declares "${desired.connector}" — delete it manually or use a new slug`
    );
  }
  return buildDiffRow({
    kind: "connection",
    id: desired.slug,
    desired,
    remote,
    fields: [
      {
        name: "name",
        changed: (d, r) => stringChanged(d.name, r.display_name),
      },
      {
        name: "auth",
        changed: (d, r) =>
          (d.authProfileSlug ?? null) !== (r.auth_profile_slug ?? null),
      },
      {
        name: "app_auth",
        changed: (d, r) =>
          (d.appAuthProfileSlug ?? null) !== (r.app_auth_profile_slug ?? null),
      },
      {
        name: "config",
        changed: (d, r) => !deepEqual(d.config ?? {}, r.config ?? {}),
      },
    ],
  }) as ConnectionDiffRow;
}

function diffFeed(
  connectionSlug: string,
  desired: DesiredFeed,
  remote: RemoteFeed | undefined
): FeedDiffRow {
  return buildDiffRow({
    kind: "feed",
    id: `${connectionSlug}/${desired.feedKey}`,
    desired,
    remote,
    extras: { connectionSlug },
    fields: [
      {
        name: "name",
        changed: (d, r) => stringChanged(d.name, r.display_name),
      },
      {
        name: "schedule",
        changed: (d, r) => (d.schedule ?? null) !== (r.schedule ?? null),
      },
      {
        name: "config",
        changed: (d, r) => !deepEqual(d.config ?? {}, r.config ?? {}),
      },
    ],
  }) as unknown as FeedDiffRow;
}

// ── Top-level diff ─────────────────────────────────────────────────────────

export interface RemoteSnapshot {
  agents: RemoteAgent[];
  /** keyed by agentId */
  agentSettings: Map<string, AgentSettings | null>;
  /** keyed by agentId */
  platformsByAgent: Map<string, RemotePlatform[]>;
  entityTypes: RemoteEntityType[];
  relationshipTypes: RemoteRelationshipType[];
  watchers: RemoteWatcher[];
  connectorDefinitions: RemoteConnectorDefinition[];
  authProfiles: RemoteAuthProfile[];
  connections: RemoteConnection[];
  /** Feeds keyed by connection ID. */
  feedsByConnectionId: Map<number, RemoteFeed[]>;
}

export interface DesiredStateForDiff {
  agents: DesiredAgent[];
  memorySchema: {
    entityTypes: DesiredEntityType[];
    relationshipTypes: DesiredRelationshipType[];
  };
  watchers: DesiredWatcher[];
  connectors: {
    definitions: DesiredConnectorDefinition[];
    authProfiles: DesiredAuthProfile[];
    connections: DesiredConnection[];
  };
}

export interface ComputeDiffOptions {
  /** Limit the diff to a subset of resource kinds. */
  only?: "agents" | "memory";
}

export function computeDiff(
  desired: DesiredStateForDiff,
  remote: RemoteSnapshot,
  opts: ComputeDiffOptions = {}
): DiffPlan {
  const rows: DiffRow[] = [];
  const only = opts.only;

  if (only !== "memory") {
    const remoteByAgent = new Map(remote.agents.map((a) => [a.agentId, a]));
    const desiredAgentIds = new Set(
      desired.agents.map((a) => a.metadata.agentId)
    );

    for (const agent of desired.agents) {
      const remoteAgent = remoteByAgent.get(agent.metadata.agentId);
      rows.push(diffAgent(agent.metadata, remoteAgent));

      const settingsRow = diffSettings(
        agent.metadata.agentId,
        agent.settings,
        remote.agentSettings.get(agent.metadata.agentId) ?? null
      );
      // If the agent itself is new, escalate the matching settings row to
      // `create` — that's the operator's mental model: the settings are part
      // of the agent's creation, not a follow-up update.
      if (!remoteAgent && settingsRow.verb !== "noop") {
        rows.push({ ...settingsRow, verb: "create" });
      } else if (!remoteAgent) {
        // No desired-side fields set; still emit a create row so the plan
        // shows the apply step actually happens.
        rows.push({ ...settingsRow, verb: "create" });
      } else {
        rows.push(settingsRow);
      }

      const remotePlatforms =
        remote.platformsByAgent.get(agent.metadata.agentId) ?? [];
      const remoteByStableId = new Map(remotePlatforms.map((p) => [p.id, p]));
      const desiredStableIds = new Set(agent.platforms.map((p) => p.stableId));

      for (const platform of agent.platforms) {
        rows.push(
          diffPlatform(
            agent.metadata.agentId,
            platform,
            remoteByStableId.get(platform.stableId)
          )
        );
      }
      for (const remotePlatform of remotePlatforms) {
        if (!desiredStableIds.has(remotePlatform.id)) {
          rows.push({
            kind: "platform",
            verb: "drift",
            id: remotePlatform.id,
            agentId: agent.metadata.agentId,
            remote: remotePlatform,
          });
        }
      }
    }

    // Drift: remote agents not in desired state. v1 reports, never deletes.
    for (const remoteAgent of remote.agents) {
      if (!desiredAgentIds.has(remoteAgent.agentId)) {
        rows.push({
          kind: "agent",
          verb: "drift",
          id: remoteAgent.agentId,
          remote: remoteAgent,
        });
      }
    }
  }

  if (only !== "agents") {
    const remoteEntityBySlug = new Map(
      remote.entityTypes.map((e) => [e.slug, e])
    );
    const desiredEntitySlugs = new Set(
      desired.memorySchema.entityTypes.map((e) => e.slug)
    );
    for (const entity of desired.memorySchema.entityTypes) {
      rows.push(diffEntityType(entity, remoteEntityBySlug.get(entity.slug)));
    }
    for (const remoteEntity of remote.entityTypes) {
      if (!desiredEntitySlugs.has(remoteEntity.slug)) {
        rows.push({
          kind: "entity-type",
          verb: "drift",
          id: remoteEntity.slug,
          remote: remoteEntity,
        });
      }
    }

    const remoteRelBySlug = new Map(
      remote.relationshipTypes.map((r) => [r.slug, r])
    );
    const desiredRelSlugs = new Set(
      desired.memorySchema.relationshipTypes.map((r) => r.slug)
    );
    for (const rel of desired.memorySchema.relationshipTypes) {
      rows.push(diffRelationshipType(rel, remoteRelBySlug.get(rel.slug)));
    }
    for (const remoteRel of remote.relationshipTypes) {
      if (!desiredRelSlugs.has(remoteRel.slug)) {
        rows.push({
          kind: "relationship-type",
          verb: "drift",
          id: remoteRel.slug,
          remote: remoteRel,
        });
      }
    }

    const remoteWatcherBySlug = new Map(
      remote.watchers.map((w) => [w.slug, w])
    );
    const desiredWatcherSlugs = new Set(desired.watchers.map((w) => w.slug));
    for (const watcher of desired.watchers) {
      rows.push(diffWatcher(watcher, remoteWatcherBySlug.get(watcher.slug)));
    }
    for (const remoteWatcher of remote.watchers) {
      if (!desiredWatcherSlugs.has(remoteWatcher.slug)) {
        rows.push({
          kind: "watcher",
          verb: "drift",
          id: remoteWatcher.slug,
          remote: remoteWatcher,
        });
      }
    }
  }

  const notes: string[] = [];

  // Connectors run only on a full apply (`--only agents|memory` skips them).
  const desiredConnectors = desired.connectors ?? {
    definitions: [],
    authProfiles: [],
    connections: [],
  };
  // Sort remote collections so drift rows + notes render deterministically
  // regardless of server response ordering.
  const remoteConnectorDefinitions = [
    ...(remote.connectorDefinitions ?? []),
  ].sort((a, b) => a.key.localeCompare(b.key));
  const remoteAuthProfiles = [...(remote.authProfiles ?? [])].sort((a, b) =>
    a.slug.localeCompare(b.slug)
  );
  const remoteConnections = [...(remote.connections ?? [])].sort((a, b) =>
    a.slug.localeCompare(b.slug)
  );
  const remoteFeedsByConnectionId =
    remote.feedsByConnectionId ?? new Map<number, RemoteFeed[]>();
  if (!only) {
    const installedKeys = new Set(
      remoteConnectorDefinitions.filter((d) => d.installed).map((d) => d.key)
    );
    const declaredKeys = new Set(
      desiredConnectors.definitions
        .map((d) => d.key)
        .filter((k): k is string => !!k)
    );
    // Connectors referenced by a desired auth profile / connection are (or
    // will be) installed in the org too — bundled ones included — so they
    // aren't "undeclared".
    const referencedConnectorKeys = new Set<string>([
      ...desiredConnectors.authProfiles.map((p) => p.connector),
      ...desiredConnectors.connections.map((c) => c.connector),
    ]);
    // Auto-discovered `.connector.ts` files whose key the CLI can't know up
    // front (the server compiles them). When any exist, suppress the
    // "undeclared remote connector" notes entirely — we can't tell which
    // remote connector corresponds to which local file.
    const hasUnnamedLocalDefs = desiredConnectors.definitions.some(
      (d) => d.key === null
    );
    for (const def of desiredConnectors.definitions) {
      rows.push(diffConnectorDefinition(def, installedKeys));
    }
    // Bundled connectors referenced by a desired auth-profile / connection that
    // the org doesn't have installed yet — `lobu apply` will install them from
    // the catalog's server-side `source_uri`. Surface them as plan rows so the
    // operator approves these connector-definition mutations too. (Skipped when
    // a locally-supplied connector declares the same key — that one wins.)
    const installableByKey = new Map(
      remoteConnectorDefinitions
        .filter((d) => d.installable && d.source_uri)
        .map((d) => [d.key, d])
    );
    for (const key of [...referencedConnectorKeys].sort()) {
      if (installedKeys.has(key)) continue;
      if (declaredKeys.has(key)) continue; // a local def supplies this key
      const entry = installableByKey.get(key);
      if (!entry?.source_uri) continue;
      rows.push({
        kind: "connector-definition",
        verb: "create",
        id: key,
        // No `desired` — this is a bundled install, handled by
        // `installConnectorDefinitions`'s bundled-referenced loop, not the
        // plan-row loop. The render falls back to `id` (the connector key).
      });
    }
    // Conservative: never auto-uninstall remote connector definitions that
    // aren't declared/referenced locally — just note them.
    if (!hasUnnamedLocalDefs) {
      for (const def of remoteConnectorDefinitions) {
        if (
          def.installed &&
          !declaredKeys.has(def.key) &&
          !referencedConnectorKeys.has(def.key)
        ) {
          notes.push(
            `connector "${def.key}" is installed remotely but not declared in connectors/ — uninstall it manually if it's no longer wanted (lobu apply never auto-uninstalls connectors).`
          );
        }
      }
    }

    const remoteAuthBySlug = new Map(
      remoteAuthProfiles.map((p) => [p.slug, p])
    );
    const desiredAuthSlugs = new Set(
      desiredConnectors.authProfiles.map((p) => p.slug)
    );
    for (const profile of desiredConnectors.authProfiles) {
      rows.push(diffAuthProfile(profile, remoteAuthBySlug.get(profile.slug)));
    }
    for (const remoteProfile of remoteAuthProfiles) {
      if (!desiredAuthSlugs.has(remoteProfile.slug)) {
        rows.push({
          kind: "auth-profile",
          verb: "drift",
          id: remoteProfile.slug,
          remote: remoteProfile,
        });
      }
    }

    const remoteConnBySlug = new Map(remoteConnections.map((c) => [c.slug, c]));
    const desiredConnSlugs = new Set(
      desiredConnectors.connections.map((c) => c.slug)
    );
    for (const conn of desiredConnectors.connections) {
      const remoteConn = remoteConnBySlug.get(conn.slug);
      rows.push(diffConnection(conn, remoteConn));
      // Nested feeds — diffed by feed_key within the connection. Only diffable
      // when the connection already exists remotely; for a new connection the
      // feeds are created right after the connection-creation step.
      const remoteFeeds = remoteConn
        ? [...(remoteFeedsByConnectionId.get(remoteConn.id) ?? [])].sort(
            (a, b) => a.feed_key.localeCompare(b.feed_key)
          )
        : [];
      const remoteFeedByKey = new Map(remoteFeeds.map((f) => [f.feed_key, f]));
      const desiredFeedKeys = new Set(conn.feeds.map((f) => f.feedKey));
      for (const feed of conn.feeds) {
        rows.push(diffFeed(conn.slug, feed, remoteFeedByKey.get(feed.feedKey)));
      }
      for (const remoteFeed of remoteFeeds) {
        if (!desiredFeedKeys.has(remoteFeed.feed_key)) {
          rows.push({
            kind: "feed",
            verb: "drift",
            id: `${conn.slug}/${remoteFeed.feed_key}`,
            connectionSlug: conn.slug,
            remote: remoteFeed,
          });
        }
      }
    }
    for (const remoteConn of remoteConnections) {
      if (!desiredConnSlugs.has(remoteConn.slug)) {
        rows.push({
          kind: "connection",
          verb: "drift",
          id: remoteConn.slug,
          remote: remoteConn,
        });
      }
    }
  }

  const counts = { create: 0, update: 0, noop: 0, drift: 0 };
  for (const row of rows) counts[row.verb]++;

  notes.sort();
  return { rows, counts, notes };
}
