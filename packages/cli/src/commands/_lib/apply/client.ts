import type { AgentSettings } from "@lobu/core";
import { ApiError, ValidationError } from "../../memory/_lib/errors.js";
import {
  getSessionForOrg,
  getUsableToken,
  mcpUrlForOrg,
  orgFromMcpUrl,
  resolveOrg,
  resolveServerUrl,
} from "../../memory/_lib/openclaw-auth.js";

// ── Wire types ─────────────────────────────────────────────────────────────

export interface RemoteAgent {
  agentId: string;
  name: string;
  description?: string;
}

export interface RemoteAgentDetail extends RemoteAgent {
  settings?: AgentSettings | null;
}

export interface RemoteConnection {
  id: string;
  platform: string;
  templateAgentId?: string;
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

export interface UpsertConnectionResult {
  /** Server reports `noop: true` when the desired config matches what's stored. */
  noop?: boolean;
  /** When the config materially changed, the live worker is restarted. */
  willRestart?: boolean;
  updated?: boolean;
  created?: boolean;
  connection?: RemoteConnection;
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

// ── Auth resolver — same shape as seed-cmd.ts (PR #459) ────────────────────

async function resolveAuth(
  urlFlag?: string,
  orgFlag?: string,
  storePath?: string
): Promise<{ token: string; mcpUrl: string; orgSlug: string }> {
  const org = resolveOrg(orgFlag);
  if (org) {
    const orgSession = getSessionForOrg(org, storePath);
    if (orgSession) {
      const result = await getUsableToken(orgSession.key, storePath);
      if (result) {
        return { token: result.token, mcpUrl: orgSession.key, orgSlug: org };
      }
    }
    const serverUrl = resolveServerUrl(urlFlag, storePath);
    if (serverUrl) {
      const orgUrl = mcpUrlForOrg(serverUrl, org);
      const result = await getUsableToken(orgUrl, storePath);
      if (result) {
        return { token: result.token, mcpUrl: orgUrl, orgSlug: org };
      }
    }
    throw new ValidationError("Not logged in. Run: lobu login");
  }

  const serverUrl = resolveServerUrl(urlFlag, storePath);
  const result = await getUsableToken(serverUrl || undefined, storePath);
  if (!result) {
    throw new ValidationError("Not logged in. Run: lobu login");
  }
  const resolvedOrg =
    orgFromMcpUrl(result.session.mcpUrl) || result.session.org;
  if (!resolvedOrg) {
    throw new ValidationError(
      "Cannot determine org. Use --org or set LOBU_MEMORY_ORG."
    );
  }
  return {
    token: result.token,
    mcpUrl: result.session.mcpUrl,
    orgSlug: resolvedOrg,
  };
}

/** Strip the path off an MCP URL to reach the API root. */
export function deriveApiBaseUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
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
      `/api/${this.orgSlug}/agents/`,
      agent,
      [200, 201]
    );
    return body;
  }

  async getAgentSettings(agentId: string): Promise<AgentSettings | null> {
    try {
      const { body } = await this.request<AgentSettings>(
        "GET",
        `/api/${this.orgSlug}/agents/${agentId}/config`
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
      `/api/${this.orgSlug}/agents/${agentId}/config`,
      settings
    );
  }

  // ── Connections ───────────────────────────────────────────────────────────

  async listConnections(agentId: string): Promise<RemoteConnection[]> {
    const { body } = await this.request<{ connections?: RemoteConnection[] }>(
      "GET",
      `/api/${this.orgSlug}/agents/${agentId}/connections`
    );
    return body.connections ?? [];
  }

  /**
   * Stable-ID upsert (PR-2 introduces this route).
   *
   * Server contract:
   *   PUT /:agentId/connections/by-stable-id/:stableId
   *   body: { platform, name?, config }
   *   response when unchanged: { noop: true, connection }
   *   response when changed:   { updated: true, willRestart: true, connection }
   *   response on first write: { created: true, connection }
   */
  async upsertConnection(
    agentId: string,
    stableId: string,
    payload: { platform: string; name?: string; config: Record<string, string> }
  ): Promise<UpsertConnectionResult> {
    const { body } = await this.request<UpsertConnectionResult>(
      "PUT",
      `/api/${this.orgSlug}/agents/${agentId}/connections/by-stable-id/${encodeURIComponent(stableId)}`,
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
  mcpUrl: string;
}

export async function resolveApplyClient(opts: {
  url?: string;
  org?: string;
  storePath?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedClient> {
  const { token, mcpUrl, orgSlug } = await resolveAuth(
    opts.url,
    opts.org,
    opts.storePath
  );
  const apiBaseUrl = deriveApiBaseUrl(mcpUrl);
  const client = new ApplyClient(
    { apiBaseUrl, orgSlug, token },
    opts.fetchImpl
  );
  return { client, apiBaseUrl, orgSlug, mcpUrl };
}
