import type { AgentSettings } from "@lobu/core";
import { resolveApiClient } from "../../../internal/index.js";
import { ApiError } from "../../memory/_lib/errors.js";

// ── Wire types ─────────────────────────────────────────────────────────────

export interface RemoteAgent {
  agentId: string;
  name: string;
  description?: string;
}

export interface RemotePlatform {
  id: string;
  platform: string;
  agentId?: string;
  config?: Record<string, unknown>;
  status?: string;
}

export interface RemoteEntityType {
  slug: string;
  name?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  /** Present only for derived types (mirrors {@link DesiredEntityType.backing}). */
  backing?: {
    sql: string;
    connection?: string;
  };
  /**
   * Owning org id. The list endpoint also returns *public* types from OTHER
   * orgs (`o.visibility = 'public'`), so prune must compare this against the
   * target org and never delete a type this org doesn't own.
   */
  organization_id?: string;
}

export interface RemoteRelationshipType {
  slug: string;
  name?: string;
  description?: string;
  rules?: Array<{ source: string; target: string }>;
  /** Owning org id — see RemoteEntityType.organization_id (public-type guard). */
  organization_id?: string;
}

export interface RemoteOrg {
  id: string;
  slug: string;
  name?: string;
}

export interface RemoteWatcher {
  slug: string;
  name?: string;
  watcher_id?: string;
  agent_id?: string | null;
  schedule?: string | null;
  device_worker_id?: string | null;
  goal_id?: number | null;
  scheduler_client_id?: string | null;
  agent_kind?: string | null;
  notification_channel?: string | null;
  notification_priority?: string | null;
  min_cooldown_seconds?: number | null;
  tags?: string[] | null;
  sources?: Array<{ name: string; query: string }> | null;
  // include_details=true → version-bound fields
  description?: string | null;
  prompt?: string | null;
  extraction_schema?: Record<string, unknown> | null;
  classifiers?: unknown[] | null;
  json_template?: unknown;
  keying_config?: Record<string, unknown> | null;
  condensation_prompt?: string | null;
  condensation_window_count?: number | null;
  reactions_guidance?: string | null;
  // NB: reaction_script is NOT in list_watchers — push always (idempotent).
}

export interface UpsertPlatformResult {
  /** Server reports `noop: true` when the desired config matches what's stored. */
  noop?: boolean;
  /** When the config materially changed, the live worker is restarted. */
  willRestart?: boolean;
  updated?: boolean;
  created?: boolean;
  platform?: RemotePlatform;
}

export interface UpsertEntityTypeResult {
  created?: boolean;
  updated?: boolean;
  noop?: boolean;
}

// ── Connectors / auth profiles / connections wire types ────────────────────

export interface RemoteConnectorDefinition {
  key: string;
  name?: string;
  version?: string;
  options_schema?: Record<string, unknown> | null;
  feeds_schema?: Record<string, unknown> | null;
  auth_schema?: Record<string, unknown> | null;
  installed?: boolean;
  installable?: boolean;
  catalog_origin?: string;
  /** `file://` URI of the bundled source on the server host (catalog entries). */
  source_uri?: string | null;
}

export interface RemoteAuthProfile {
  id?: number;
  slug: string;
  display_name?: string;
  connector_key: string;
  profile_kind: string;
  status: string;
}

export interface RemoteConnection {
  id: number;
  slug: string;
  connector_key: string;
  display_name?: string;
  status: string;
  auth_profile_slug?: string | null;
  app_auth_profile_slug?: string | null;
  config?: Record<string, unknown> | null;
  device_worker_id?: string | null;
}

export interface RemoteFeed {
  id: number;
  connection_id: number;
  feed_key: string;
  display_name?: string;
  status: string;
  schedule?: string | null;
  config?: Record<string, unknown> | null;
}

export interface InstallConnectorResult {
  connectorKey: string;
  updated: boolean;
  version?: string;
}

/**
 * Result of ensuring an auth profile exists. For interactive kinds
 * (`oauth_account` / `browser_session`) `connectUrl` carries the URL the
 * operator must open to complete auth; `status` is the state the server
 * reports (`pending_auth` until auth completes).
 */
export interface EnsureAuthProfileResult {
  created: boolean;
  updated: boolean;
  status?: string;
  connectUrl?: string;
}

// ── Shape predicates ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the first array-valued key from a response body. Endpoints that may
 * return either a snake_case or camelCase collection key go through this so the
 * `body.snake ?? body.camel ?? []` triple isn't repeated at every call site.
 */
function pickArray<T>(body: Record<string, unknown>, ...keys: string[]): T[] {
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

/**
 * The server stores entity-type per-field config as a single `metadata_schema`
 * JSON Schema. The diff compares the desired config's flat `properties`/
 * `required` against the remote snapshot, so hoist them out of the returned
 * `metadata_schema` to the row's top level. Mirrors `upsertEntityType`, which
 * folds the flat fields back into `metadata_schema` when writing.
 */
function hoistEntityTypeSchema(
  row: RemoteEntityType & {
    metadata_schema?: unknown;
    backing_sql?: string | null;
    backing_source?: string | null;
  }
): RemoteEntityType {
  const schema = row.metadata_schema;
  const out: RemoteEntityType = {
    slug: row.slug,
    ...(row.name !== undefined ? { name: row.name } : {}),
    ...(row.description !== undefined ? { description: row.description } : {}),
    // Preserve owning org so prune can skip public types from other orgs.
    ...(row.organization_id !== undefined
      ? { organization_id: row.organization_id }
      : {}),
  };
  if (isRecord(schema)) {
    if (isRecord(schema.properties)) out.properties = schema.properties;
    if (Array.isArray(schema.required)) {
      out.required = schema.required.filter(
        (v): v is string => typeof v === "string"
      );
    }
  }
  // A type is derived iff it has view SQL; stored types carry no backing, so it
  // compares equal to the desired side without churn. `backing_source` (a
  // connection slug) is hoisted to `backing.connection` only when set, so an
  // internal-backed view stays `{ sql }` and never churns.
  if (typeof row.backing_sql === "string") {
    out.backing = {
      sql: row.backing_sql,
      ...(typeof row.backing_source === "string" && row.backing_source
        ? { connection: row.backing_source }
        : {}),
    };
  }
  return out;
}

function extractApiError(
  parsed: Record<string, unknown>,
  status: number,
  statusText: string
): { message: string; code?: string } {
  if (typeof parsed.error === "string") {
    return { message: parsed.error };
  }
  if (isRecord(parsed.error)) {
    const message =
      typeof parsed.error.message === "string"
        ? parsed.error.message
        : `HTTP ${status} ${statusText}`;
    const code =
      typeof parsed.error.code === "string" ? parsed.error.code : undefined;
    return code ? { message, code } : { message };
  }
  return { message: `HTTP ${status} ${statusText}` };
}

async function parseResponseBody(
  res: Response,
  url: string
): Promise<Record<string, unknown>> {
  const raw = await res.text();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    throw new ApiError(`Invalid JSON from ${url}: ${raw.slice(0, 500)}`);
  }
}

// ── Client ─────────────────────────────────────────────────────────────────

export interface ApplyClientConfig {
  apiBaseUrl: string;
  orgSlug: string;
  token: string;
}

/**
 * Typed wrappers for the existing server endpoints `lobu apply` calls.
 *
 * The class is open over an injectable `fetchImpl` so tests can stub the
 * network without monkey-patching globals. Real callers leave `fetchImpl`
 * unset and pick up `globalThis.fetch`.
 */
export class ApplyClient {
  private readonly apiBaseUrl: string;
  private readonly orgSlug: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: ApplyClientConfig, fetchImpl: typeof fetch = fetch) {
    this.apiBaseUrl = cfg.apiBaseUrl;
    this.orgSlug = cfg.orgSlug;
    this.token = cfg.token;
    this.fetchImpl = fetchImpl;
  }

  // ── HTTP shape (mirrors openclaw-cmd.ts:postJson, locally scoped) ────────

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    okStatuses: number[] = [200, 201, 204]
  ): Promise<{ status: number; body: T }> {
    const url = `${this.apiBaseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(url, init);
    const parsed = await parseResponseBody(res, url);

    if (!okStatuses.includes(res.status) && !res.ok) {
      const { message, code } = extractApiError(
        parsed,
        res.status,
        res.statusText
      );
      throw new ApiError(
        `${method} ${path} failed: ${message}${code ? ` [${code}]` : ""}`,
        res.status
      );
    }

    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      throw new ApiError(
        `${method} ${path} returned error: ${parsed.error}`,
        res.status
      );
    }

    return { status: res.status, body: parsed as T };
  }

  // ── Organization ──────────────────────────────────────────────────────────

  /**
   * Orgs the authenticated user belongs to, read from the OAuth userinfo
   * endpoint — the same source `lobu org list` uses. Used to check whether the
   * `[memory].org` slug already resolves to one of the operator's orgs. Does
   * not depend on `this.orgSlug`. (`lobu apply` can't create an org headlessly
   * — that needs a logged-in browser session — so there is no `createOrg`.)
   */
  async listOrgs(): Promise<RemoteOrg[]> {
    const { body } = await this.request<{ organizations?: unknown }>(
      "GET",
      `/oauth/userinfo`
    );
    const orgs = Array.isArray(body.organizations) ? body.organizations : [];
    const out: RemoteOrg[] = [];
    for (const entry of orgs) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === "string" ? entry.id : "";
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      if (!id || !slug) continue;
      out.push({
        id,
        slug,
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      });
    }
    return out;
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async listAgents(): Promise<RemoteAgent[]> {
    const { body } = await this.request<{ agents?: RemoteAgent[] }>(
      "GET",
      `/api/${this.orgSlug}/agents`
    );
    return body.agents ?? [];
  }

  /**
   * Idempotent create: PR-2 makes `POST /` return 200 with the existing
   * payload when an agent of the same ID already exists in the same org.
   * Cross-org collision still surfaces as 409 with a clear `error.code` —
   * we re-throw verbatim so `lobu apply` can show the operator the link
   * to the org-scoped IDs issue.
   */
  async upsertAgent(agent: {
    agentId: string;
    name: string;
    description?: string;
  }): Promise<RemoteAgent> {
    const { body } = await this.request<RemoteAgent>(
      "POST",
      // No trailing slash — Hono matches `routes.post('/', ...)` mounted at
      // `/api/:orgSlug/agents` against `/api/dev/agents`, not `/api/dev/agents/`.
      `/api/${this.orgSlug}/agents`,
      agent,
      [200, 201]
    );
    return body;
  }

  async patchAgentMetadata(
    agentId: string,
    agent: { name?: string; description?: string }
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}`,
      agent
    );
  }

  async getAgentSettings(agentId: string): Promise<AgentSettings | null> {
    try {
      const { body } = await this.request<AgentSettings>(
        "GET",
        `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}/config`
      );
      return body;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async patchAgentSettings(
    agentId: string,
    settings: Partial<AgentSettings>
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}/config`,
      settings
    );
  }

  /**
   * Set (or rotate) the org-shared API key for a provider. Idempotent.
   * Lands in `agent_secrets` under `provider:<id>:apiKey`, scoped to the org.
   */
  async setProviderApiKey(
    agentId: string,
    providerId: string,
    value: string
  ): Promise<void> {
    await this.request(
      "PUT",
      `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}/providers/${encodeURIComponent(providerId)}/api-key`,
      { value }
    );
  }

  // ── Platforms ─────────────────────────────────────────────────────────────

  async listPlatforms(agentId: string): Promise<RemotePlatform[]> {
    const { body } = await this.request<{ platforms?: RemotePlatform[] }>(
      "GET",
      `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}/platforms`
    );
    return body.platforms ?? [];
  }

  /**
   * Stable-ID upsert.
   *
   * Server contract:
   *   PUT /:agentId/platforms/by-stable-id/:stableId
   *   body: { platform, name?, config }
   *   response when unchanged: { noop: true, platform }
   *   response when changed:   { updated: true, willRestart: true, platform }
   *   response on first write: { created: true, platform }
   */
  async upsertPlatform(
    agentId: string,
    stableId: string,
    payload: { platform: string; name?: string; config: Record<string, string> }
  ): Promise<UpsertPlatformResult> {
    const { body } = await this.request<UpsertPlatformResult>(
      "PUT",
      `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}/platforms/by-stable-id/${encodeURIComponent(stableId)}`,
      payload
    );
    return body;
  }

  /**
   * Reconcile a platform's declarative channel bindings.
   *
   * Server contract:
   *   POST /:agentId/platforms/:platformId/sync-channels
   *   body: { channels: string[] }   // each "<teamId>/<channelId>"
   *   response: { bound: string[], removed: string[] }
   */
  async syncPlatformChannels(
    agentId: string,
    platformId: string,
    channels: string[]
  ): Promise<{ bound: string[]; removed: string[] }> {
    const { body } = await this.request<{
      bound?: string[];
      removed?: string[];
    }>(
      "POST",
      `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}/platforms/${encodeURIComponent(platformId)}/sync-channels`,
      { channels }
    );
    return { bound: body.bound ?? [], removed: body.removed ?? [] };
  }

  // ── Memory schema ─────────────────────────────────────────────────────────

  async listEntityTypes(): Promise<RemoteEntityType[]> {
    type RawEntityTypeRow = RemoteEntityType & {
      metadata_schema?: unknown;
      backing_sql?: string | null;
    };
    const { body } = await this.request<{
      entity_types?: RawEntityTypeRow[];
      entityTypes?: RawEntityTypeRow[];
    }>("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "entity_type",
      action: "list",
    });
    // The server returns the type's fields inside a single `metadata_schema`
    // JSON Schema (+ typed backing_* columns). Surface `properties`/`required`
    // and normalize `backing` at top level so the diff compares them against the
    // desired config (which carries them flat).
    return pickArray<RawEntityTypeRow>(body, "entity_types", "entityTypes").map(
      hoistEntityTypeSchema
    );
  }

  /**
   * The `manage_entity_schema` admin tool exposes separate `create` / `update`
   * actions and surfaces duplicates as a coded 409 (`[entity_type_exists]` /
   * `[relationship_type_exists]`). Probe with `create`; on that explicit
   * duplicate signal retry with `update`. Any other error (e.g. a 422
   * `[invalid_schema]` validation failure) propagates verbatim — retrying it
   * as an update used to mask the real message behind "Entity type not
   * found" (issue #1177).
   */
  private async upsertSchemaResource(
    schemaType: "entity_type" | "relationship_type",
    payload: Record<string, unknown>
  ): Promise<UpsertEntityTypeResult> {
    const url = `/api/${this.orgSlug}/manage_entity_schema`;
    try {
      await this.request("POST", url, {
        schema_type: schemaType,
        action: "create",
        ...payload,
      });
      return { created: true };
    } catch (err) {
      if (err instanceof ApiError && isDuplicateError(err)) {
        await this.request("POST", url, {
          schema_type: schemaType,
          action: "update",
          ...payload,
        });
        return { updated: true };
      }
      throw err;
    }
  }

  async upsertEntityType(entity: {
    slug: string;
    name?: string;
    description?: string;
    required?: string[];
    properties?: Record<string, unknown>;
    backing?: {
      sql: string;
      connection?: string;
    };
  }): Promise<UpsertEntityTypeResult> {
    // The server stores per-type fields as a single `metadata_schema` JSON
    // Schema (`{ type, properties, required }`) — it does NOT read top-level
    // `properties`/`required`. Fold them into `metadata_schema` so the schema
    // actually persists (otherwise every apply re-reports a `properties`
    // update because the stored schema stays empty).
    const { slug, name, description, required, properties, backing } = entity;
    const payload: Record<string, unknown> = { slug };
    if (name !== undefined) payload.name = name;
    if (description !== undefined) payload.description = description;
    if (properties !== undefined || required !== undefined) {
      payload.metadata_schema = {
        type: "object",
        properties: properties ?? {},
        ...(required && required.length > 0 ? { required } : {}),
      };
    }
    // Backing is sent on every upsert so it is deterministic: `{ sql }` makes
    // the type derived; `null` makes it stored (and reverts a previously-derived
    // type). `connection` (a slug) is forwarded so the server can bind the view
    // to an external database; the server resolves slug → connection at read time.
    payload.backing = backing
      ? {
          sql: backing.sql,
          ...(backing.connection ? { connection: backing.connection } : {}),
        }
      : null;
    return this.upsertSchemaResource("entity_type", payload);
  }

  async listRelationshipTypes(): Promise<RemoteRelationshipType[]> {
    const { body } = await this.request<{
      relationship_types?: RemoteRelationshipType[];
      relationshipTypes?: RemoteRelationshipType[];
    }>("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "relationship_type",
      action: "list",
    });
    return pickArray(body, "relationship_types", "relationshipTypes");
  }

  /**
   * Fetch a relationship type's rules (the `list` action omits them, so the
   * apply diff can't otherwise see remote rules and would churn a perpetual
   * "rules changed" update). Maps the server's `*_entity_type_slug` columns to
   * `{ source, target }`; `id` is carried for reconcile (remove_rule by id).
   */
  async listRelationshipTypeRules(
    slug: string
  ): Promise<Array<{ id: number; source: string; target: string }>> {
    const { body } = await this.request<{
      rules?: Array<{
        id?: number;
        source_entity_type_slug?: string;
        target_entity_type_slug?: string;
      }>;
    }>("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "relationship_type",
      action: "list_rules",
      slug,
    });
    return (body.rules ?? [])
      .filter(
        (r) =>
          r.id != null && r.source_entity_type_slug && r.target_entity_type_slug
      )
      .map((r) => ({
        id: r.id as number,
        source: r.source_entity_type_slug as string,
        target: r.target_entity_type_slug as string,
      }));
  }

  async upsertRelationshipType(rel: {
    slug: string;
    name?: string;
    description?: string;
    rules?: Array<{ source: string; target: string }>;
  }): Promise<UpsertEntityTypeResult> {
    const { rules, ...payload } = rel;
    const result = await this.upsertSchemaResource(
      "relationship_type",
      payload
    );

    // Reconcile rules to exactly the desired set so config is the source of
    // truth (declarative). Without removing extras, dropping a rule from config
    // would never take effect AND would churn a perpetual "rules changed"
    // update on every apply. add_rule is idempotent; remove_rule takes a id.
    const desired = rules ?? [];
    const ruleKey = (r: { source: string; target: string }) =>
      `${r.source}	${r.target}`;
    const desiredKeys = new Set(desired.map(ruleKey));
    const remote = await this.listRelationshipTypeRules(rel.slug);
    const remoteKeys = new Set(remote.map(ruleKey));

    for (const rule of desired) {
      if (remoteKeys.has(ruleKey(rule))) continue;
      try {
        await this.request(
          "POST",
          `/api/${this.orgSlug}/manage_entity_schema`,
          {
            schema_type: "relationship_type",
            action: "add_rule",
            slug: rel.slug,
            source_entity_type_slug: rule.source,
            target_entity_type_slug: rule.target,
          }
        );
      } catch (err) {
        if (err instanceof ApiError && isDuplicateError(err)) continue;
        throw err;
      }
    }
    for (const rule of remote) {
      if (desiredKeys.has(ruleKey(rule))) continue;
      await this.request("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
        schema_type: "relationship_type",
        action: "remove_rule",
        slug: rel.slug,
        rule_id: rule.id,
      });
    }
    return result;
  }

  /**
   * Delete an entity type (code-managed prune). The server soft-deletes and
   * REFUSES if instances of the type still exist — the data is exempt from
   * prune, so that surfaces as a clear error rather than cascading.
   */
  async deleteEntityType(slug: string): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "entity_type",
      action: "delete",
      slug,
    });
  }

  /** Delete a relationship type (code-managed prune). */
  async deleteRelationshipType(slug: string): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "relationship_type",
      action: "delete",
      slug,
    });
  }

  // ── Watchers ──────────────────────────────────────────────────────────────

  /**
   * Fetch a single watcher's full payload — `getWatcher` server-side, which
   * returns reaction_script (not in the list response). Used by
   * `lobu init --from-org` to round-trip reaction scripts back to sibling
   * `.ts` files.
   */
  async getWatcherDetail(watcherId: string): Promise<{
    reaction_script?: string | null;
    description?: string | null;
  } | null> {
    try {
      const { body } = await this.request<{
        watcher?: {
          reaction_script?: string | null;
          description?: string | null;
        };
      }>(
        "GET",
        `/api/${this.orgSlug}/watchers?watcher_id=${encodeURIComponent(watcherId)}`
      );
      return body.watcher ?? null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async listWatchers(): Promise<RemoteWatcher[]> {
    // `include_details=true` pulls the version-bound fields (prompt,
    // extraction_schema, classifiers, json_template, keying_config,
    // condensation_*, reactions_guidance) too. Apply diffs against these to
    // detect drift on the prompt / schema / sources / etc.
    const { body } = await this.request<{ watchers?: RemoteWatcher[] }>(
      "GET",
      `/api/${this.orgSlug}/watchers?include_details=true`
    );
    return body.watchers ?? [];
  }

  /**
   * Create a watcher owned by `agentId`. `extraction_schema` is sent as a JSON
   * object — the `manage_watchers` tool accepts `Type.Any()` there and
   * normalizes string-or-object internally. Duplicate-slug surfaces as a
   * structured error the caller swallows for idempotency.
   */
  async createWatcher(payload: {
    slug: string;
    agentId: string;
    name?: string;
    description?: string;
    prompt: string;
    extraction_schema: Record<string, unknown>;
    schedule?: string;
    sources?: Array<{ name: string; query: string }>;
    reactions_guidance?: string;
    device_worker_id?: string;
    scheduler_client_id?: string;
    notification_channel?: "canvas" | "notification" | "both";
    notification_priority?: "low" | "normal" | "high";
    min_cooldown_seconds?: number;
    tags?: string[];
    agent_kind?: string;
    json_template?: unknown;
    keying_config?: Record<string, unknown>;
    classifiers?: unknown[];
    condensation_prompt?: string;
    condensation_window_count?: number;
  }): Promise<{ watcher_id?: string }> {
    const { body } = await this.request<{ watcher_id?: string }>(
      "POST",
      `/api/${this.orgSlug}/manage_watchers`,
      {
        action: "create",
        slug: payload.slug,
        agent_id: payload.agentId,
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.description ? { description: payload.description } : {}),
        prompt: payload.prompt,
        extraction_schema: payload.extraction_schema,
        ...(payload.schedule ? { schedule: payload.schedule } : {}),
        ...(payload.sources?.length ? { sources: payload.sources } : {}),
        ...(payload.reactions_guidance !== undefined
          ? { reactions_guidance: payload.reactions_guidance }
          : {}),
        ...(payload.device_worker_id !== undefined
          ? { device_worker_id: payload.device_worker_id }
          : {}),
        ...(payload.scheduler_client_id !== undefined
          ? { scheduler_client_id: payload.scheduler_client_id }
          : {}),
        ...(payload.notification_channel !== undefined
          ? { notification_channel: payload.notification_channel }
          : {}),
        ...(payload.notification_priority !== undefined
          ? { notification_priority: payload.notification_priority }
          : {}),
        ...(payload.min_cooldown_seconds !== undefined
          ? { min_cooldown_seconds: payload.min_cooldown_seconds }
          : {}),
        ...(payload.tags?.length ? { tags: payload.tags } : {}),
        ...(payload.agent_kind !== undefined
          ? { agent_kind: payload.agent_kind }
          : {}),
        ...(payload.json_template !== undefined
          ? { json_template: payload.json_template }
          : {}),
        ...(payload.keying_config !== undefined
          ? { keying_config: payload.keying_config }
          : {}),
        ...(payload.classifiers !== undefined
          ? { classifiers: payload.classifiers }
          : {}),
        ...(payload.condensation_prompt !== undefined
          ? { condensation_prompt: payload.condensation_prompt }
          : {}),
        ...(payload.condensation_window_count !== undefined
          ? { condensation_window_count: payload.condensation_window_count }
          : {}),
      }
    );
    return { ...(body.watcher_id ? { watcher_id: body.watcher_id } : {}) };
  }

  /**
   * Update the **scalar** fields on the `watchers` row — these don't require
   * a new version. Version-bound fields (prompt / extraction_schema / sources
   * / reactions_guidance / json_template / keying_config / classifiers /
   * condensation_*) require `createWatcherVersion` instead.
   *
   * `null` clears nullable fields (device_worker_id, scheduler_client_id,
   * agent_kind) per the server contract.
   */
  async updateWatcher(payload: {
    watcher_id: string;
    schedule?: string | null;
    agent_id?: string;
    device_worker_id?: string | null;
    scheduler_client_id?: string | null;
    notification_channel?: "canvas" | "notification" | "both";
    notification_priority?: "low" | "normal" | "high";
    min_cooldown_seconds?: number;
    tags?: string[];
    agent_kind?: string | null;
  }): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_watchers`, {
      action: "update",
      watcher_id: payload.watcher_id,
      ...(payload.schedule !== undefined ? { schedule: payload.schedule } : {}),
      ...(payload.agent_id !== undefined ? { agent_id: payload.agent_id } : {}),
      ...(payload.device_worker_id !== undefined
        ? { device_worker_id: payload.device_worker_id }
        : {}),
      ...(payload.scheduler_client_id !== undefined
        ? { scheduler_client_id: payload.scheduler_client_id }
        : {}),
      ...(payload.notification_channel !== undefined
        ? { notification_channel: payload.notification_channel }
        : {}),
      ...(payload.notification_priority !== undefined
        ? { notification_priority: payload.notification_priority }
        : {}),
      ...(payload.min_cooldown_seconds !== undefined
        ? { min_cooldown_seconds: payload.min_cooldown_seconds }
        : {}),
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      ...(payload.agent_kind !== undefined
        ? { agent_kind: payload.agent_kind }
        : {}),
    });
  }

  /**
   * Create a new watcher_versions row carrying the version-bound fields, then
   * upgrade the watcher's `current_version_id` to that new version. Server
   * inherits unset fields from the previous version row.
   */
  async createWatcherVersion(payload: {
    watcher_id: string;
    prompt?: string;
    extraction_schema?: Record<string, unknown>;
    sources?: Array<{ name: string; query: string }>;
    json_template?: unknown;
    keying_config?: Record<string, unknown>;
    classifiers?: unknown[];
    reactions_guidance?: string;
    condensation_prompt?: string;
    condensation_window_count?: number;
    change_notes?: string;
  }): Promise<{ version?: number }> {
    const { body } = await this.request<{ version?: number }>(
      "POST",
      `/api/${this.orgSlug}/manage_watchers`,
      {
        action: "create_version",
        watcher_id: payload.watcher_id,
        set_as_current: true,
        ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
        ...(payload.extraction_schema !== undefined
          ? { extraction_schema: payload.extraction_schema }
          : {}),
        ...(payload.sources !== undefined ? { sources: payload.sources } : {}),
        ...(payload.json_template !== undefined
          ? { json_template: payload.json_template }
          : {}),
        ...(payload.keying_config !== undefined
          ? { keying_config: payload.keying_config }
          : {}),
        ...(payload.classifiers !== undefined
          ? { classifiers: payload.classifiers }
          : {}),
        ...(payload.reactions_guidance !== undefined
          ? { reactions_guidance: payload.reactions_guidance }
          : {}),
        ...(payload.condensation_prompt !== undefined
          ? { condensation_prompt: payload.condensation_prompt }
          : {}),
        ...(payload.condensation_window_count !== undefined
          ? { condensation_window_count: payload.condensation_window_count }
          : {}),
        ...(payload.change_notes
          ? { change_notes: payload.change_notes }
          : { change_notes: "lobu apply" }),
      }
    );
    return body.version !== undefined ? { version: body.version } : {};
  }

  /**
   * Attach (or clear) a reaction script. Pass an empty string to remove it —
   * matches the admin tool contract.
   */
  async setReactionScript(
    watcherId: string,
    reactionScript: string
  ): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_watchers`, {
      action: "set_reaction_script",
      watcher_id: watcherId,
      reaction_script: reactionScript,
    });
  }

  /**
   * Delete a watcher by its numeric `watcher_id` (code-managed prune). The
   * admin tool takes an array; we delete one slug's watcher at a time so a
   * failure is attributable.
   */
  async deleteWatcher(watcherId: string): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_watchers`, {
      action: "delete",
      watcher_ids: [watcherId],
    });
  }

  // ── Connector definitions ─────────────────────────────────────────────────

  private async connectionsTool<T>(body: Record<string, unknown>): Promise<T> {
    const { body: parsed } = await this.request<T>(
      "POST",
      `/api/${this.orgSlug}/manage_connections`,
      body
    );
    return parsed;
  }

  private async feedsTool<T>(body: Record<string, unknown>): Promise<T> {
    const { body: parsed } = await this.request<T>(
      "POST",
      `/api/${this.orgSlug}/manage_feeds`,
      body
    );
    return parsed;
  }

  private async authProfilesTool<T>(body: Record<string, unknown>): Promise<T> {
    const { body: parsed } = await this.request<T>(
      "POST",
      `/api/${this.orgSlug}/manage_auth_profiles`,
      body
    );
    return parsed;
  }

  /** Installed org connectors + (with `includeInstallable`) the bundled catalog. */
  async listConnectorDefinitions(
    includeInstallable = true
  ): Promise<RemoteConnectorDefinition[]> {
    const body = await this.connectionsTool<{
      connector_definitions?: RemoteConnectorDefinition[];
    }>({
      action: "list_connector_definitions",
      include_installable: includeInstallable,
    });
    return body.connector_definitions ?? [];
  }

  /**
   * Idempotent connector install. The CLI passes raw TypeScript source
   * (`compiled: false`) or a `source_url`; the server compiles + extracts
   * metadata and returns the resolved `connectorKey` plus `updated` (false
   * when the installed code is byte-identical).
   */
  async installConnector(payload: {
    sourceCode?: string;
    sourceUrl?: string;
    /** `file://` URI of a bundled connector source on the server host. */
    sourceUri?: string;
    /** `sourceCode` is already a compiled bundle (CLI-side compile) — skip server compile. */
    compiled?: boolean;
  }): Promise<InstallConnectorResult> {
    const body = await this.connectionsTool<{
      installed?: boolean;
      connector_key?: string;
      version?: string;
      updated?: boolean;
    }>({
      action: "install_connector",
      ...(payload.sourceCode !== undefined
        ? {
            source_code: payload.sourceCode,
            compiled: payload.compiled ?? false,
          }
        : {}),
      ...(payload.sourceUrl ? { source_url: payload.sourceUrl } : {}),
      ...(payload.sourceUri ? { source_uri: payload.sourceUri } : {}),
    });
    return {
      connectorKey: body.connector_key ?? "",
      updated: body.updated ?? false,
      ...(body.version ? { version: body.version } : {}),
    };
  }

  async uninstallConnector(connectorKey: string): Promise<void> {
    await this.connectionsTool({
      action: "uninstall_connector",
      connector_key: connectorKey,
    });
  }

  // ── Auth profiles ─────────────────────────────────────────────────────────

  async listAuthProfiles(): Promise<RemoteAuthProfile[]> {
    const body = await this.authProfilesTool<{
      auth_profiles?: RemoteAuthProfile[];
    }>({ action: "list_auth_profiles" });
    return body.auth_profiles ?? [];
  }

  async getAuthProfileBySlug(slug: string): Promise<RemoteAuthProfile | null> {
    try {
      const body = await this.authProfilesTool<{
        auth_profile?: RemoteAuthProfile;
      }>({ action: "get_auth_profile", auth_profile_slug: slug });
      return body.auth_profile ?? null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createAuthProfile(payload: {
    slug: string;
    connector: string;
    kind: string;
    name?: string;
    credentials?: Record<string, string>;
  }): Promise<EnsureAuthProfileResult> {
    const body = await this.authProfilesTool<{
      auth_profile?: { status?: string };
      connect_url?: string;
    }>({
      action: "create_auth_profile",
      connector_key: payload.connector,
      profile_kind: payload.kind,
      display_name: payload.name ?? payload.slug,
      slug: payload.slug,
      ...(payload.credentials && Object.keys(payload.credentials).length > 0
        ? { credentials: payload.credentials }
        : {}),
    });
    return {
      created: true,
      updated: false,
      ...(body.auth_profile?.status
        ? { status: body.auth_profile.status }
        : {}),
      ...(body.connect_url ? { connectUrl: body.connect_url } : {}),
    };
  }

  async updateAuthProfile(payload: {
    slug: string;
    name?: string;
    credentials?: Record<string, string>;
  }): Promise<EnsureAuthProfileResult> {
    const body = await this.authProfilesTool<{
      auth_profile?: { status?: string };
      connect_url?: string;
    }>({
      action: "update_auth_profile",
      auth_profile_slug: payload.slug,
      ...(payload.name ? { display_name: payload.name } : {}),
      ...(payload.credentials && Object.keys(payload.credentials).length > 0
        ? { credentials: payload.credentials }
        : {}),
    });
    return {
      created: false,
      updated: true,
      ...(body.auth_profile?.status
        ? { status: body.auth_profile.status }
        : {}),
      ...(body.connect_url ? { connectUrl: body.connect_url } : {}),
    };
  }

  /** Re-issue a connect token for an existing interactive-auth profile. */
  async reconnectAuthProfile(slug: string): Promise<string | undefined> {
    const body = await this.authProfilesTool<{ connect_url?: string }>({
      action: "update_auth_profile",
      auth_profile_slug: slug,
      reconnect: true,
    });
    return body.connect_url;
  }

  // ── Connections ───────────────────────────────────────────────────────────

  async listConnections(): Promise<RemoteConnection[]> {
    const body = await this.connectionsTool<{
      connections?: RemoteConnection[];
    }>({ action: "list", limit: 500 });
    return body.connections ?? [];
  }

  async createConnection(payload: {
    slug: string;
    connector: string;
    name?: string;
    authProfileSlug?: string;
    appAuthProfileSlug?: string;
    config?: Record<string, unknown>;
    deviceWorkerId?: string;
  }): Promise<RemoteConnection> {
    const body = await this.connectionsTool<{ connection?: RemoteConnection }>({
      action: "create",
      connector_key: payload.connector,
      slug: payload.slug,
      ...(payload.name ? { display_name: payload.name } : {}),
      ...(payload.authProfileSlug
        ? { auth_profile_slug: payload.authProfileSlug }
        : {}),
      ...(payload.appAuthProfileSlug
        ? { app_auth_profile_slug: payload.appAuthProfileSlug }
        : {}),
      ...(payload.config ? { config: payload.config } : {}),
      ...(payload.deviceWorkerId
        ? { device_worker_id: payload.deviceWorkerId }
        : {}),
    });
    if (!body.connection) {
      throw new ApiError(
        `create connection "${payload.slug}" returned no connection payload`
      );
    }
    return body.connection;
  }

  async updateConnection(
    connectionId: number,
    payload: {
      name?: string;
      authProfileSlug?: string | null;
      appAuthProfileSlug?: string | null;
      config?: Record<string, unknown>;
      deviceWorkerId?: string | null;
    }
  ): Promise<RemoteConnection> {
    const body = await this.connectionsTool<{ connection?: RemoteConnection }>({
      action: "update",
      connection_id: connectionId,
      ...(payload.name !== undefined ? { display_name: payload.name } : {}),
      ...(payload.authProfileSlug !== undefined
        ? { auth_profile_slug: payload.authProfileSlug }
        : {}),
      ...(payload.appAuthProfileSlug !== undefined
        ? { app_auth_profile_slug: payload.appAuthProfileSlug }
        : {}),
      // `lobu apply` is declarative — replace, don't merge, so removed
      // manifest keys disappear remotely (server defaults to merge).
      ...(payload.config !== undefined
        ? { config: payload.config, replace_config: true }
        : {}),
      ...(payload.deviceWorkerId !== undefined
        ? { device_worker_id: payload.deviceWorkerId }
        : {}),
    });
    if (!body.connection) {
      throw new ApiError(
        `update connection #${connectionId} returned no connection payload`
      );
    }
    return body.connection;
  }

  // ── Feeds (managed per-connection) ────────────────────────────────────────

  async listFeeds(connectionId: number): Promise<RemoteFeed[]> {
    const body = await this.feedsTool<{ feeds?: RemoteFeed[] }>({
      action: "list_feeds",
      connection_id: connectionId,
      limit: 500,
    });
    return body.feeds ?? [];
  }

  async createFeed(payload: {
    connectionId: number;
    feedKey: string;
    name?: string;
    schedule?: string;
    config?: Record<string, unknown>;
  }): Promise<RemoteFeed> {
    const body = await this.feedsTool<{ feed?: RemoteFeed }>({
      action: "create_feed",
      connection_id: payload.connectionId,
      feed_key: payload.feedKey,
      ...(payload.name ? { display_name: payload.name } : {}),
      ...(payload.schedule ? { schedule: payload.schedule } : {}),
      ...(payload.config ? { config: payload.config } : {}),
    });
    if (!body.feed) {
      throw new ApiError(
        `create feed "${payload.feedKey}" returned no feed payload`
      );
    }
    return body.feed;
  }

  async updateFeed(
    feedId: number,
    payload: {
      name?: string;
      schedule?: string;
      config?: Record<string, unknown>;
    }
  ): Promise<RemoteFeed> {
    const body = await this.feedsTool<{ feed?: RemoteFeed }>({
      action: "update_feed",
      feed_id: feedId,
      ...(payload.name !== undefined ? { display_name: payload.name } : {}),
      ...(payload.schedule !== undefined ? { schedule: payload.schedule } : {}),
      ...(payload.config !== undefined
        ? { config: payload.config, replace_config: true }
        : {}),
    });
    if (!body.feed) {
      throw new ApiError(`update feed #${feedId} returned no feed payload`);
    }
    return body.feed;
  }
}

/**
 * Recognise duplicate-name errors from the admin tools without substring
 * matching the user-facing message. The server stamps a bracketed code into
 * the error message of every duplicate path `apply` upserts through
 * (`manage_entity_schema` create / add_rule → `[entity_type_exists]`,
 * `[relationship_type_exists]`, `[already_exists]`, all httpStatus 409).
 *
 * Anything else is NOT a duplicate. In particular a 422 schema-validation
 * error (`[invalid_schema]`, e.g. ">4 x-table-column fields") must surface
 * verbatim — the old status-only fallback treated any 4xx as "already
 * exists", retried with `action: update`, and buried the real message under
 * a misleading "Entity type not found" (issue #1177). The 409 fallback stays
 * as a belt-and-braces signal for duplicate paths that predate the codes.
 */
export function isDuplicateError(err: ApiError): boolean {
  if (typeof err.status !== "number") return false;
  const message = err.message.toLowerCase();
  if (
    message.includes("[entity_type_exists]") ||
    message.includes("[relationship_type_exists]") ||
    message.includes("[already_exists]")
  ) {
    return true;
  }
  return err.status === 409;
}

// ── Top-level resolver ─────────────────────────────────────────────────────

export interface ResolvedClient {
  client: ApplyClient;
  apiBaseUrl: string;
  orgSlug: string;
}

export async function resolveApplyClient(opts: {
  url?: string;
  org?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedClient> {
  const { token, apiBaseUrl, orgSlug } = await resolveApiClient({
    org: opts.org,
    apiUrl: opts.url,
    fetchImpl: opts.fetchImpl,
  });
  const client = new ApplyClient(
    { apiBaseUrl, orgSlug, token },
    opts.fetchImpl
  );
  return { client, apiBaseUrl, orgSlug };
}
