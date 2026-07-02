import type { AgentSettings } from "@lobu/core";
import type {
  InferenceCapabilityBlock,
  InferenceModality,
} from "../../../config/define.js";
import { ValidationError } from "../../memory/_lib/errors.js";
import type {
  RemoteAgent,
  RemoteAuthProfile,
  RemoteConnection,
  RemoteConnectorDefinition,
  RemoteEntityType,
  RemoteFeed,
  RemoteInferenceProvider,
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
  DesiredOrgProvider,
  DesiredPlatform,
  DesiredRelationshipType,
  DesiredState,
  DesiredWatcher,
} from "./desired-state.js";
import { declaredConnectorKeys, referencedConnectorKeys } from "./shared.js";

// ── Diff verbs ──────────────────────────────────────────────────────────────

type DiffVerb = "create" | "update" | "noop" | "drift" | "delete";

interface BaseRow {
  verb: DiffVerb;
  /** Stable identifier for matching messages and UI. */
  id: string;
}

/**
 * The desired/remote/changed-fields triple shared by every per-resource row
 * kind. `changedFields` carries field-level changes when verb === "update".
 */
interface ResourceRow<D, R> extends BaseRow {
  desired?: D;
  remote?: R;
  changedFields?: string[];
}

export interface AgentDiffRow
  extends ResourceRow<DesiredAgent["metadata"], RemoteAgent> {
  kind: "agent";
}

export interface SettingsDiffRow extends BaseRow {
  kind: "settings";
  desired?: Partial<AgentSettings>;
  changedFields?: string[];
}

export interface PlatformDiffRow
  extends ResourceRow<DesiredPlatform, RemotePlatform> {
  kind: "platform";
  agentId: string;
  /** True when an update will restart the live worker — surfaced in the plan. */
  willRestart?: boolean;
}

export interface EntityTypeDiffRow
  extends ResourceRow<DesiredEntityType, RemoteEntityType> {
  kind: "entity-type";
}

export interface RelationshipTypeDiffRow
  extends ResourceRow<DesiredRelationshipType, RemoteRelationshipType> {
  kind: "relationship-type";
}

export interface WatcherDiffRow
  extends ResourceRow<DesiredWatcher, RemoteWatcher> {
  kind: "watcher";
  /**
   * Field names that require a `create_version` + `upgrade` (vs a plain
   * `update`). Apply uses this to route writes to the right admin action.
   */
  versionBoundFields?: string[];
  /**
   * True when the desired watcher declares a `reaction_script` — server stores
   * it write-only, so the diff can't tell whether it changed; apply always
   * re-pushes (idempotent). Matches the auth-profile credentials pattern.
   */
  reactionScriptDeclared?: boolean;
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

export interface AuthProfileDiffRow
  extends ResourceRow<DesiredAuthProfile, RemoteAuthProfile> {
  kind: "auth-profile";
  /** True for `oauth_account` / `browser_session` profiles not yet `active`. */
  needsAuth?: boolean;
}

export interface ConnectionDiffRow
  extends ResourceRow<DesiredConnection, RemoteConnection> {
  kind: "connection";
}

export interface FeedDiffRow extends ResourceRow<DesiredFeed, RemoteFeed> {
  kind: "feed";
  /** Owning connection slug. */
  connectionSlug: string;
}

export interface InferenceProviderDiffRow
  extends ResourceRow<DesiredOrgProvider, RemoteInferenceProvider> {
  kind: "inference-provider";
  /**
   * True when the desired provider declares an API key — the server stores it
   * write-only (can't be read back), so the diff can't tell whether it changed;
   * apply always re-pushes (idempotent). Matches the auth-profile credentials /
   * watcher reaction-script pattern.
   */
  keyDeclared?: boolean;
  /**
   * Modalities whose capability block differs from remote (or is new). Apply
   * PUTs each. On a create, every declared modality is listed.
   */
  capabilityModalities?: InferenceModality[];
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
  | FeedDiffRow
  | InferenceProviderDiffRow;

export interface DiffPlan {
  rows: DiffRow[];
  /** Aggregate counters for the summary line. */
  counts: {
    create: number;
    update: number;
    noop: number;
    drift: number;
    /**
     * Definitions absent from the config that apply will delete. Always 0
     * unless the config declares prune (`computeDiff({ prune: true })`);
     * otherwise those remote-only definitions are reported as `drift`.
     */
    delete: number;
  };
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
 * Compare an OPTIONAL display name. When the config omits it (undefined/empty),
 * the operator has no opinion — the server keeps its derived/stored name (e.g.
 * a feed `display_name` defaulted from the feed key), so an omitted name must
 * NOT churn the plan into a perpetual "name changed" update. Only a name the
 * operator explicitly set, and that differs, is a real change.
 */
function optionalNameChanged(
  desired: string | null | undefined,
  remote: string | null | undefined
): boolean {
  if (desired == null || desired === "") return false;
  return stringChanged(desired, remote);
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
 * Field set: limited to the keys lobu.config.ts can express today. Settings that
 * only the UI mutates (e.g. `installedProviders[].installedAt`) are
 * excluded so unrelated UI activity doesn't show up as drift in the plan.
 */
const SETTINGS_FIELDS: Array<keyof AgentSettings> = [
  "networkConfig",
  "nixConfig",
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

/**
 * A platform-config value the CLI can't read back, so it must not drive a diff:
 *   - the server redacts secrets in the GET response (`***`-suffixed), and
 *   - it rewrites a `$VAR` placeholder into an internal `secret://…` reference.
 * Either form is opaque — the cleartext never round-trips.
 */
function isOpaqueRemoteConfigValue(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith("***") || value.startsWith("secret://"))
  );
}

/**
 * Compare a desired platform config against the remote one for drift.
 *
 * Two adjustments keep an unchanged platform a noop instead of restarting it on
 * every apply:
 *   - the route handler stores `platform` inside `config` for stable-id
 *     matching, so the GET round-trip carries an extra `platform` key the CLI
 *     never wrote — strip it before diffing;
 *   - secret-bearing keys (`botToken`, app secrets, …) come back redacted or as
 *     a `secret://` reference, never the cleartext the CLI sent as `$VAR`. When
 *     the desired value is a `$VAR` placeholder and the remote value is opaque,
 *     treat them as equal (the credential write path is idempotent and re-pushes
 *     rotated secrets on its own, mirroring the auth-profile credentials rule).
 */
function platformConfigChanged(
  desired: Record<string, unknown>,
  remote: Record<string, unknown> | undefined
): boolean {
  const remoteConfig: Record<string, unknown> = { ...(remote ?? {}) };
  delete remoteConfig.platform;
  const desiredConfig: Record<string, unknown> = { ...desired };
  delete desiredConfig.platform;

  const keys = new Set([
    ...Object.keys(desiredConfig),
    ...Object.keys(remoteConfig),
  ]);
  for (const key of keys) {
    const d = desiredConfig[key];
    const r = remoteConfig[key];
    if (isOpaqueRemoteConfigValue(r)) {
      // Opaque remote (redacted `***` or a `secret://` ref): the resolved
      // cleartext the CLI sent can never round-trip-match, so we can't tell a
      // rotation from a no-op here. Treat as unchanged ONLY while the key is
      // still declared — apply re-pushes every desired platform idempotently
      // (like provider keys), so a rotated secret still reaches the server
      // without a false "config changed" plan row. A key ABSENT from desired
      // is a real removal → changed.
      if (!(key in desiredConfig)) return true;
      continue;
    }
    if (!deepEqual(d, r)) return true;
  }
  return false;
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
        changed: (d, r) => platformConfigChanged(d.config, r.config),
      },
    ],
    updateExtras: (changed) => ({
      willRestart: changed.includes("config") || changed.includes("type"),
    }),
  }) as unknown as PlatformDiffRow;
}

function diffEntityType(
  desired: DesiredEntityType,
  remote: RemoteEntityType | undefined,
  prune: boolean
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
      {
        // Derived types store metadata_schema verbatim (no inferred superset),
        // so a plain properties + backing diff is exact and idempotent.
        name: "backing",
        changed: (d, r) => !deepEqual(d.backing, r.backing),
      },
      {
        // metrics_config round-trips verbatim; both sides omit it for a
        // non-metric type, so deepEqual(undefined, undefined) ⇒ no churn.
        name: "metrics",
        changed: (d, r) => !deepEqual(d.metrics, r.metrics),
      },
      {
        // event_kinds — prune-aware, like viewTemplate. event_kinds can be
        // authored out-of-band via manage_entity_schema (a connector feed, the
        // UI, an agent), so a config that simply doesn't declare them must NOT
        // wipe them. Declared: diff and set on change. Omitted + prune: a
        // present remote set is a removal (apply clears it). Omitted + no prune:
        // unmanaged, never churns — the out-of-band kinds are left alone.
        name: "eventKinds",
        changed: (d, r) =>
          d.eventKinds !== undefined
            ? !deepEqual(d.eventKinds, r.eventKinds)
            : prune && r.eventKinds !== undefined,
      },
      {
        // View template — prune-aware. Declared: diff against the remote current
        // default (apply sets on change). Omitted + prune: a present remote
        // template is a removal (apply clears it). Omitted + no prune: unmanaged
        // (never churns), so a UI-authored template is left alone.
        name: "viewTemplate",
        changed: (d, r) =>
          d.viewTemplate !== undefined
            ? !deepEqual(d.viewTemplate, r.viewTemplate)
            : prune && r.viewTemplate !== undefined,
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
 * Watcher drift fields split into two routing categories:
 *   - **scalar** lives on the `watchers` row → `manage_watchers update`.
 *   - **version-bound** lives on the `watcher_versions` row → must go through
 *     `create_version` + `upgrade` (server-side bumps `current_version_id`).
 * The diff returns both lists; apply-cmd routes accordingly.
 *
 * Reaction scripts aren't returned by `list_watchers` (write-only on the row),
 * so we can't compare them — apply always re-pushes when declared (idempotent).
 * Remote watchers without a desired model are reported as drift, never deleted.
 */
function diffWatcher(
  desired: DesiredWatcher,
  remote: RemoteWatcher | undefined
): WatcherDiffRow {
  const reactionScriptDeclared = desired.reactionScript !== undefined;
  if (!remote) {
    return {
      kind: "watcher",
      verb: "create",
      id: desired.slug,
      desired,
      ...(reactionScriptDeclared ? { reactionScriptDeclared: true } : {}),
    };
  }

  const scalar: string[] = [];
  if ((desired.schedule ?? null) !== (remote.schedule ?? null)) {
    scalar.push("schedule");
  }
  if (desired.agent !== (remote.agent_id ?? "")) {
    scalar.push("agent_id");
  }
  if (
    desired.deviceWorkerId !== undefined &&
    desired.deviceWorkerId !== (remote.device_worker_id ?? undefined)
  ) {
    scalar.push("device_worker_id");
  }
  if (
    desired.schedulerClientId !== undefined &&
    desired.schedulerClientId !== (remote.scheduler_client_id ?? undefined)
  ) {
    scalar.push("scheduler_client_id");
  }
  if (
    desired.notificationChannel !== undefined &&
    desired.notificationChannel !== (remote.notification_channel ?? undefined)
  ) {
    scalar.push("notification_channel");
  }
  if (
    desired.notificationPriority !== undefined &&
    desired.notificationPriority !== (remote.notification_priority ?? undefined)
  ) {
    scalar.push("notification_priority");
  }
  if (
    desired.minCooldownSeconds !== undefined &&
    desired.minCooldownSeconds !== (remote.min_cooldown_seconds ?? undefined)
  ) {
    scalar.push("min_cooldown_seconds");
  }
  if (
    desired.tags !== undefined &&
    !deepEqual(desired.tags, remote.tags ?? [])
  ) {
    scalar.push("tags");
  }
  if (
    desired.agentKind !== undefined &&
    desired.agentKind !== (remote.agent_kind ?? undefined)
  ) {
    scalar.push("agent_kind");
  }

  const versionBound: string[] = [];
  if (desired.prompt !== (remote.prompt ?? "")) {
    versionBound.push("prompt");
  }
  // Sources live on the watchers row but are written as part of create_version
  // when changed (server copies them to the version's per-assignment scope).
  // Diff against `remote.sources` (also from the row) and route through
  // create_version so the version chain stays consistent.
  if (
    desired.sources !== undefined &&
    !deepEqual(desired.sources, remote.sources ?? [])
  ) {
    versionBound.push("sources");
  }
  if (
    desired.reactionsGuidance !== undefined &&
    desired.reactionsGuidance !== (remote.reactions_guidance ?? "")
  ) {
    versionBound.push("reactions_guidance");
  }
  if (
    desired.keyingConfig !== undefined &&
    !deepEqual(desired.keyingConfig, remote.keying_config ?? {})
  ) {
    versionBound.push("keying_config");
  }
  if (
    desired.classifiers !== undefined &&
    !deepEqual(desired.classifiers, remote.classifiers ?? [])
  ) {
    versionBound.push("classifiers");
  }
  const changed = [...scalar, ...versionBound];
  if (reactionScriptDeclared) changed.push("reaction_script");
  if (changed.length === 0) {
    return { kind: "watcher", verb: "noop", id: desired.slug, desired, remote };
  }
  return {
    kind: "watcher",
    verb: "update",
    id: desired.slug,
    desired,
    remote,
    changedFields: changed,
    ...(versionBound.length > 0 ? { versionBoundFields: versionBound } : {}),
    ...(reactionScriptDeclared ? { reactionScriptDeclared: true } : {}),
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
        changed: (d, r) => optionalNameChanged(d.name, r.display_name),
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
      {
        name: "device_worker_id",
        changed: (d, r) =>
          (d.deviceWorkerId ?? null) !== (r.device_worker_id ?? null),
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
        changed: (d, r) => optionalNameChanged(d.name, r.display_name),
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

/**
 * Diff one org inference provider. The API key is write-only (never read back),
 * so a declared key always marks the row for a re-push (idempotent PUT) — this
 * alone escalates a create, and on an existing provider is folded into whether
 * the row counts as an update. Capability blocks are compared per-modality; any
 * modality that is new or differs is listed in `capabilityModalities` for apply
 * to PUT. `kind`/`displayName` changes also count as an update.
 */
function diffInferenceProvider(
  desired: DesiredOrgProvider,
  remote: RemoteInferenceProvider | undefined
): InferenceProviderDiffRow {
  const keyDeclared = desired.apiKey.length > 0;

  if (!remote) {
    return {
      kind: "inference-provider",
      verb: "create",
      id: desired.slug,
      desired,
      keyDeclared,
      capabilityModalities: Object.keys(
        desired.capabilities
      ) as InferenceModality[],
    };
  }

  // `kind` and `displayName` are immutable after create: the server exposes no
  // update path for them (only per-modality capabilities + key rotation). Diffing
  // them here would push a change `executePlan` can't persist, so the drift would
  // resurface on every apply. `kind` is load-bearing (provider type ↔ credential),
  // so a mismatch is a hard error; `displayName` is cosmetic and simply not diffed.
  if (desired.kind !== remote.kind) {
    throw new ValidationError(
      `Inference provider "${desired.slug}" has kind "${desired.kind}" but the server has "${remote.kind}". ` +
        `A provider's kind is immutable — delete and recreate it under a new slug to change the type.`
    );
  }

  const changed: string[] = [];

  // Per-modality capability comparison. Only modalities the config declares are
  // considered — an omitted modality means "no opinion" and never churns.
  const capabilityModalities: InferenceModality[] = [];
  for (const [modality, block] of Object.entries(desired.capabilities) as [
    InferenceModality,
    InferenceCapabilityBlock,
  ][]) {
    if (!deepEqual(block, remote.capabilities?.[modality] ?? {})) {
      capabilityModalities.push(modality);
    }
  }
  if (capabilityModalities.length > 0) changed.push("capabilities");

  // A write-only key can't be diffed, so a declared key always warrants a
  // re-push — surface that as an update so the plan isn't a silent noop.
  const verb: DiffVerb = changed.length > 0 || keyDeclared ? "update" : "noop";

  return {
    kind: "inference-provider",
    verb,
    id: desired.slug,
    desired,
    remote,
    ...(changed.length > 0 ? { changedFields: changed } : {}),
    keyDeclared,
    ...(capabilityModalities.length > 0 ? { capabilityModalities } : {}),
  };
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
  /** Org-owned inference providers (from `GET /inference-providers`). */
  inferenceProviders: RemoteInferenceProvider[];
}

/**
 * The subset of {@link DesiredState} the diff consumes — everything except the
 * apply-only knobs (prune flag, org metadata, requiredSecrets).
 */
type DesiredStateForDiff = Pick<
  DesiredState,
  "agents" | "memorySchema" | "watchers" | "connectors" | "providers"
>;

interface ComputeDiffOptions {
  /** Limit the diff to a subset of resource kinds. */
  only?: "agents" | "memory";
  /**
   * When true, the config declares `prune: true`: it's the source of truth for
   * *definitions*, so a remote definition (entity type, relationship type,
   * watcher, connector definition) absent from desired is emitted as a `delete`
   * row instead of an ignored `drift` — INCLUDING definitions created via the
   * dashboard/API. Data (entity/relationship instances), connections, auth
   * profiles, feeds, agents, and platforms are never pruned. Default (false)
   * reports those remote-only definitions as `drift`.
   */
  prune?: boolean;
  /**
   * Target org id. The entity/relationship-type list endpoints also return
   * *public* definitions owned by OTHER orgs, which this org neither manages
   * nor can delete — so a remote type whose `organization_id` differs is
   * excluded from drift/delete entirely. Omit to disable the filter (tests).
   */
  orgId?: string;
}

export function computeDiff(
  desired: DesiredStateForDiff,
  remote: RemoteSnapshot,
  opts: ComputeDiffOptions = {}
): DiffPlan {
  const rows: DiffRow[] = [];
  const only = opts.only;
  const prune = opts.prune ?? false;
  // A remote entity/relationship type is this org's to manage (drift/prune)
  // only when it's org-owned. The list endpoints also surface public types
  // from other orgs (`organization_id` differs) — never drift or delete those.
  const orgId = opts.orgId;
  const ownsDefinition = (definitionOrgId: string | undefined): boolean =>
    orgId === undefined ||
    definitionOrgId === undefined ||
    definitionOrgId === orgId;
  // `$`-prefixed definitions (e.g. the per-org `$member` entity type) are
  // SYSTEM-managed — the server provisions them and rejects `$` slugs in
  // create, so they can never appear in a user's config. They must NEVER be
  // pruned (deleting `$member` corrupts the org; and because the delete is
  // refused while member rows exist, an un-exempted prune HALTS every apply).
  // They only ever surface as ignorable drift, in both prune and non-prune.
  const isSystemSlug = (slug: string): boolean => slug.startsWith("$");

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
    // Restrict entity/relationship types to the ones THIS org owns, for both
    // matching and prune. The list endpoints also return public types from
    // other orgs; the server returns them after the org's own rows, so a naive
    // slug→row Map would let a foreign public type shadow the org's own
    // definition (false noop/update) — and prune must never touch them.
    const ownedEntityTypes = remote.entityTypes.filter((e) =>
      ownsDefinition(e.organization_id)
    );
    const remoteEntityBySlug = new Map(
      ownedEntityTypes.map((e) => [e.slug, e])
    );
    const desiredEntitySlugs = new Set(
      desired.memorySchema.entityTypes.map((e) => e.slug)
    );
    for (const entity of desired.memorySchema.entityTypes) {
      rows.push(
        diffEntityType(entity, remoteEntityBySlug.get(entity.slug), prune)
      );
    }
    for (const remoteEntity of ownedEntityTypes) {
      if (!desiredEntitySlugs.has(remoteEntity.slug)) {
        // Code-managed: delete. The server refuses an entity-type delete while
        // instances exist (the data is exempt), surfacing a clear error.
        // System (`$`) types are never user-declared → never pruned.
        rows.push({
          kind: "entity-type",
          verb: prune && !isSystemSlug(remoteEntity.slug) ? "delete" : "drift",
          id: remoteEntity.slug,
          remote: remoteEntity,
        });
      }
    }

    const ownedRelTypes = remote.relationshipTypes.filter((r) =>
      ownsDefinition(r.organization_id)
    );
    const remoteRelBySlug = new Map(ownedRelTypes.map((r) => [r.slug, r]));
    const desiredRelSlugs = new Set(
      desired.memorySchema.relationshipTypes.map((r) => r.slug)
    );
    for (const rel of desired.memorySchema.relationshipTypes) {
      rows.push(diffRelationshipType(rel, remoteRelBySlug.get(rel.slug)));
    }
    for (const remoteRel of ownedRelTypes) {
      if (!desiredRelSlugs.has(remoteRel.slug)) {
        rows.push({
          kind: "relationship-type",
          verb: prune && !isSystemSlug(remoteRel.slug) ? "delete" : "drift",
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
          verb: prune && !isSystemSlug(remoteWatcher.slug) ? "delete" : "drift",
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
    const declaredKeys = declaredConnectorKeys(desiredConnectors.definitions);
    // Connectors referenced by a desired auth profile / connection are (or
    // will be) installed in the org too — bundled ones included — so they
    // aren't "undeclared".
    const referencedKeys = referencedConnectorKeys(desiredConnectors);
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
    for (const key of [...referencedKeys].sort()) {
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
    // Connector keys still wired to a surviving remote connection / auth profile.
    // Those are exempt from prune, so their connector must not be deleted —
    // uninstalling it would orphan the connection.
    const liveConnectorKeys = new Set<string>([
      ...remoteConnections.map((c) => c.connector_key),
      ...remoteAuthProfiles.map((p) => p.connector_key),
    ]);
    // Remote connector definitions not declared/referenced locally. Code-managed
    // orgs delete them; UI-managed orgs just get a note (never auto-uninstall).
    // Suppressed entirely when any local `*.connector.ts` has an unresolved key
    // (`null`) — we can't tell which remote def corresponds to which local file.
    if (!hasUnnamedLocalDefs) {
      for (const def of remoteConnectorDefinitions) {
        if (!def.installed) continue;
        if (declaredKeys.has(def.key) || referencedKeys.has(def.key)) {
          continue;
        }
        if (prune && !liveConnectorKeys.has(def.key)) {
          rows.push({
            kind: "connector-definition",
            verb: "delete",
            id: def.key,
          });
        } else {
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

  // Org-owned inference providers. Full-apply only (org-scoped, neither
  // "agents" nor "memory"). A provider in the config but not remote → create; a
  // matching one whose capabilities/kind/displayName differ (or that declares a
  // key, which is write-only and always re-pushed) → update; a remote provider
  // absent from the config → drift (NEVER delete: an org credential is
  // destructive to remove, so drop it in the UI/API, not via apply).
  if (only === undefined) {
    // `?? []` mirrors the `desired.connectors ?? {…}` defensive default above —
    // test literals build a partial DesiredStateForDiff.
    const desiredProviders = desired.providers ?? [];
    const remoteProviders = remote.inferenceProviders ?? [];
    const remoteProviderBySlug = new Map(
      remoteProviders.map((p) => [p.slug, p])
    );
    const desiredProviderSlugs = new Set(desiredProviders.map((p) => p.slug));
    for (const provider of desiredProviders) {
      rows.push(
        diffInferenceProvider(provider, remoteProviderBySlug.get(provider.slug))
      );
    }
    for (const remoteProvider of remoteProviders) {
      if (!desiredProviderSlugs.has(remoteProvider.slug)) {
        rows.push({
          kind: "inference-provider",
          verb: "drift",
          id: remoteProvider.slug,
          remote: remoteProvider,
        });
      }
    }
  }

  const counts = { create: 0, update: 0, noop: 0, drift: 0, delete: 0 };
  for (const row of rows) counts[row.verb]++;

  notes.sort();
  return { rows, counts, notes };
}
