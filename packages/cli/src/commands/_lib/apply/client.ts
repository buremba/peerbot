import type { AgentSettings } from "@lobu/core";
import { resolveApiClient } from "../../../internal/index.js";
import { ApiError } from "../../memory/_lib/errors.js";

// ── Wire types ─────────────────────────────────────────────────────────────

export interface RemoteAgent {
  agentId: string;
  name: string;
  description?: string;
}

export interface RemoteAgentDetail extends RemoteAgent {
  settings?: AgentSettings | null;
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
}

export interface RemoteRelationshipType {
  slug: string;
  name?: string;
  description?: string;
  rules?: Array<{ source: string; target: string }>;
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

// ── Shape predicates ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  // ── Memory schema ─────────────────────────────────────────────────────────

  async listEntityTypes(): Promise<RemoteEntityType[]> {
    const { body } = await this.request<{
      entity_types?: RemoteEntityType[];
      entityTypes?: RemoteEntityType[];
    }>("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "entity_type",
      action: "list",
    });
    return body.entity_types ?? body.entityTypes ?? [];
  }

  async upsertEntityType(entity: {
    slug: string;
    name?: string;
    description?: string;
    required?: string[];
    properties?: Record<string, unknown>;
  }): Promise<UpsertEntityTypeResult> {
    // The admin tool exposes separate `create` / `update` actions and surfaces
    // duplicates as a structured error code rather than a 4xx. Probe with
    // `create`; on a duplicate-named-resource code, retry with `update`.
    try {
      await this.request("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
        schema_type: "entity_type",
        action: "create",
        ...entity,
      });
      return { created: true };
    } catch (err) {
      if (err instanceof ApiError && isDuplicateError(err)) {
        await this.request(
          "POST",
          `/api/${this.orgSlug}/manage_entity_schema`,
          { schema_type: "entity_type", action: "update", ...entity }
        );
        return { updated: true };
      }
      throw err;
    }
  }

  async listRelationshipTypes(): Promise<RemoteRelationshipType[]> {
    const { body } = await this.request<{
      relationship_types?: RemoteRelationshipType[];
      relationshipTypes?: RemoteRelationshipType[];
    }>("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "relationship_type",
      action: "list",
    });
    return body.relationship_types ?? body.relationshipTypes ?? [];
  }

  async upsertRelationshipType(rel: {
    slug: string;
    name?: string;
    description?: string;
    rules?: Array<{ source: string; target: string }>;
  }): Promise<UpsertEntityTypeResult> {
    const { rules, ...payload } = rel;
    let result: UpsertEntityTypeResult;
    try {
      await this.request("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
        schema_type: "relationship_type",
        action: "create",
        ...payload,
      });
      result = { created: true };
    } catch (err) {
      if (err instanceof ApiError && isDuplicateError(err)) {
        await this.request(
          "POST",
          `/api/${this.orgSlug}/manage_entity_schema`,
          { schema_type: "relationship_type", action: "update", ...payload }
        );
        result = { updated: true };
      } else {
        throw err;
      }
    }

    // Register rules separately via add_rule. Backend treats add_rule as
    // idempotent; duplicate-add surfaces a structured error we can swallow.
    if (rules?.length) {
      for (const rule of rules) {
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
    }
    return result;
  }
}

/**
 * Recognise duplicate-name errors from the admin tools without substring
 * matching the user-facing message. The server emits a structured code in
 * `error.code` (e.g. `entity_type_exists`, `already_exists`) that the
 * proxy surfaces in the error payload. This helper centralises that check
 * so we can extend the code list as the server grows.
 *
 * Tradeoff: the existing `manage_entity_schema` handler doesn't currently
 * stamp a stable code for every duplicate path. Until it does, we accept
 * structured codes when present and fall back to the http status alone
 * (any 4xx for a `create` action is treated as duplicate-or-bad-payload;
 * the subsequent `update` will fail noisily on the latter).
 */
function isDuplicateError(err: ApiError): boolean {
  if (typeof err.status === "number" && err.status >= 400 && err.status < 500) {
    const message = err.message.toLowerCase();
    if (
      message.includes("[entity_type_exists]") ||
      message.includes("[relationship_type_exists]") ||
      message.includes("[already_exists]")
    ) {
      return true;
    }
    // Fall back to status-only when no code is stamped. This is loose; we
    // accept the loss because the v1 plan explicitly limits us to
    // server endpoints whose error shape we don't control.
    return err.status === 409 || err.status === 422 || err.status === 400;
  }
  return false;
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
