import {
  findContextByUrl,
  getActiveOrg,
  resolveContext,
  type ResolvedContext,
} from "./context.js";
import { getToken, loadCredentials } from "./credentials.js";

interface ApiClientOptions {
  context?: string;
  org?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ResolvedApiClient {
  client: ApiClient;
  contextName: string;
  apiBaseUrl: string;
  orgSlug: string;
  token: string;
}

interface OrganizationInfo {
  slug: string;
  name?: string;
}

class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export class ApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    options: { okStatuses?: number[] } = {}
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    const parsed = await parseResponse(response, url);
    const okStatuses = options.okStatuses ?? [200, 201, 204];
    if (!response.ok || !okStatuses.includes(response.status)) {
      const { message, code } = extractError(parsed, response);
      throw new ApiClientError(
        `${method} ${path} failed: ${message}`,
        response.status,
        code
      );
    }
    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path, undefined, {
      okStatuses: [200, 204],
    });
  }
}

export async function resolveApiClient(
  options: ApiClientOptions = {}
): Promise<ResolvedApiClient> {
  const target = await resolveApiTarget(options);
  const apiBaseUrl = apiBaseFromContextUrl(target.url);
  const token = process.env.LOBU_API_TOKEN || (await getToken(target.name));

  if (!token) {
    throw new ApiClientError(
      `Not logged in to context "${target.name}". Run \`lobu login${options.context ? ` --context ${target.name}` : ""}\` first.`,
      401
    );
  }

  const orgSlug = await resolveOrgSlug({
    ...options,
    contextName: target.name,
    token,
    apiBaseUrl,
    useStoredUserInfoEndpoint: target.useStoredUserInfoEndpoint,
  });

  return {
    client: new ApiClient(apiBaseUrl, token, options.fetchImpl),
    contextName: target.name,
    apiBaseUrl,
    orgSlug,
    token,
  };
}

export async function listOrganizations(
  options: Pick<ApiClientOptions, "context" | "apiUrl" | "fetchImpl"> = {}
): Promise<OrganizationInfo[]> {
  const target = await resolveApiTarget(options);
  const token = process.env.LOBU_API_TOKEN || (await getToken(target.name));
  if (!token) {
    throw new ApiClientError(
      `Not logged in to context "${target.name}". Run \`lobu login${options.context ? ` --context ${target.name}` : ""}\` first.`,
      401
    );
  }
  return getOrganizationsFromUserInfo(
    target.name,
    token,
    apiBaseFromContextUrl(target.url),
    options.fetchImpl,
    { useStoredUserInfoEndpoint: target.useStoredUserInfoEndpoint }
  );
}

interface ResolvedApiTarget extends ResolvedContext {
  useStoredUserInfoEndpoint: boolean;
}

async function resolveApiTarget(
  options: Pick<ApiClientOptions, "context" | "apiUrl">
): Promise<ResolvedApiTarget> {
  const requested = await resolveContext(options.context);
  if (!options.apiUrl) {
    return { ...requested, useStoredUserInfoEndpoint: true };
  }

  const matched = await findContextByUrl(options.apiUrl);
  if (matched) {
    return { ...matched, useStoredUserInfoEndpoint: true };
  }

  const apiBaseUrl = apiBaseFromContextUrl(options.apiUrl);
  const contextApiBaseUrl = apiBaseFromContextUrl(requested.url);
  if (!process.env.LOBU_API_TOKEN && apiBaseUrl !== contextApiBaseUrl) {
    throw new ApiClientError(
      `Refusing to send stored context credentials for "${requested.name}" to ${apiBaseUrl}. Add a context for that URL or set LOBU_API_TOKEN explicitly.`
    );
  }

  return {
    ...requested,
    url: options.apiUrl,
    useStoredUserInfoEndpoint: apiBaseUrl === contextApiBaseUrl,
  };
}

export function apiBaseFromContextUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function resolveOrgSlug(
  options: ApiClientOptions & {
    contextName: string;
    token: string;
    apiBaseUrl: string;
    useStoredUserInfoEndpoint: boolean;
  }
): Promise<string> {
  const explicit = options.org?.trim() || process.env.LOBU_ORG?.trim();
  if (explicit) return validateOrgSlug(explicit);

  const active = await getActiveOrg(options.contextName);
  if (active) return validateOrgSlug(active);

  const organizations = await getOrganizationsFromUserInfo(
    options.contextName,
    options.token,
    options.apiBaseUrl,
    options.fetchImpl,
    { useStoredUserInfoEndpoint: options.useStoredUserInfoEndpoint }
  ).catch(() => []);

  if (organizations.length === 1) {
    return validateOrgSlug(organizations[0]!.slug);
  }

  if (organizations.length > 1) {
    throw new ApiClientError(
      `Multiple organizations are available (${organizations.map((org) => org.slug).join(", ")}). Run \`lobu org set <slug>\` or pass \`--org <slug>\`.`
    );
  }

  throw new ApiClientError(
    "No organization selected. Run `lobu org set <slug>` or pass `--org <slug>`."
  );
}

async function getOrganizationsFromUserInfo(
  contextName: string,
  token: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: { useStoredUserInfoEndpoint?: boolean } = {}
): Promise<OrganizationInfo[]> {
  const creds =
    options.useStoredUserInfoEndpoint === false
      ? null
      : await loadCredentials(contextName);
  const endpoint =
    creds?.oauth?.userinfoEndpoint ?? `${apiBaseUrl}/oauth/userinfo`;
  const response = await fetchImpl(endpoint, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!data) return [];
  const orgs = Array.isArray(data.organizations) ? data.organizations : [];
  const result: OrganizationInfo[] = [];
  for (const entry of orgs) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const slug = typeof value.slug === "string" ? value.slug : "";
    if (!slug) continue;
    result.push({
      slug,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
    });
  }
  return result;
}

async function parseResponse(
  response: Response,
  url: string
): Promise<unknown> {
  if (response.status === 204) return undefined;
  const raw = await response.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (!response.ok) return { error: raw };
    throw new ApiClientError(
      `Invalid JSON from ${url}: ${raw.slice(0, 500)}`,
      response.status
    );
  }
}

function extractError(
  parsed: unknown,
  response: Response
): { message: string; code?: string } {
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (typeof record.error === "string") {
      return {
        message:
          pickString(record, "error_description") ??
          pickString(record, "message") ??
          record.error,
        code: pickString(record, "code") ?? record.error,
      };
    }
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      return {
        message:
          pickString(error, "message") ??
          `HTTP ${response.status} ${response.statusText}`,
        code: pickString(error, "code"),
      };
    }
    if (typeof record.message === "string") {
      return { message: record.message, code: pickString(record, "code") };
    }
    if (typeof record.error_description === "string") {
      return {
        message: record.error_description,
        code: pickString(record, "error"),
      };
    }
  }
  return { message: `HTTP ${response.status} ${response.statusText}` };
}

function pickString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function validateOrgSlug(slug: string): string {
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(slug)) {
    throw new ApiClientError(
      `Invalid organization slug "${slug}". Slugs may only contain alphanumeric characters, hyphens, and underscores.`
    );
  }
  return slug;
}
