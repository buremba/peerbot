import type { Connection, McpConfig, Skill } from "./types";

function apiUrl(agentId: string, path: string): string {
  return `/api/v1/agents/${encodeURIComponent(agentId)}${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonPost(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jsonPatch(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseJson(resp: Response): Promise<any> {
  return resp.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseJsonSafe(resp: Response): Promise<any> {
  return resp.json().catch(() => ({}));
}

// ─── Agent Management ──────────────────────────────────────────────────────

export async function switchAgent(
  agentId: string,
  platform: string,
  channelId: string,
  teamId?: string
): Promise<void> {
  const resp = await jsonPost(apiUrl(agentId, "/channels"), {
    platform,
    channelId,
    teamId,
  });
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to switch agent");
  }
}

export async function createAgent(
  agentId: string,
  name: string,
  channelId?: string
): Promise<void> {
  const resp = await jsonPost("/api/v1/agents", {
    agentId,
    name,
    channelId,
  });
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to create agent");
  }
}

export async function updateAgentIdentity(
  agentId: string,
  body: Record<string, string>
): Promise<void> {
  const resp = await jsonPatch(
    `/api/v1/agents/${encodeURIComponent(agentId)}`,
    body
  );
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to update");
  }
}

export async function deleteAgent(agentId: string): Promise<void> {
  const resp = await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to delete agent");
  }
}

// ─── Settings ──────────────────────────────────────────────────────────────

export async function saveSettings(
  agentId: string,
  settings: Record<string, unknown>
): Promise<void> {
  const resp = await jsonPatch(apiUrl(agentId, "/config"), settings);
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to save settings");
  }
}

export async function promoteSandboxSettings(agentId: string): Promise<{
  success: boolean;
  sourceAgentId: string;
  targetAgentId: string;
}> {
  const resp = await jsonPost(apiUrl(agentId, "/config/promote"), {});
  const data = await parseJsonSafe(resp);
  if (!resp.ok) {
    throw new Error(data.error || "Failed to promote sandbox settings");
  }
  return data;
}

export async function checkProviders(agentId: string): Promise<
  Record<
    string,
    {
      connected: boolean;
      userConnected: boolean;
      systemConnected: boolean;
      activeAuthType?: string;
      authMethods?: string[];
    }
  >
> {
  const resp = await fetch(apiUrl(agentId, "/config"));
  const data = await parseJson(resp);
  return data.providers || {};
}

// ─── Provider Install/Uninstall ────────────────────────────────────────────

export async function installProvider(
  agentId: string,
  providerId: string
): Promise<void> {
  const url = apiUrl(
    agentId,
    `/config/providers/${encodeURIComponent(providerId)}`
  );
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const resp = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      if (resp.ok) return;

      const data = await parseJsonSafe(resp);
      const message =
        data.error || `Failed to install provider (HTTP ${resp.status})`;

      // Retry transient server failures to survive short gateway restarts.
      if (resp.status >= 500 && attempt < maxAttempts) {
        await sleep(attempt * 500);
        continue;
      }

      throw new Error(message);
    } catch (error) {
      // Retry transient network errors to survive short gateway restarts.
      if (attempt < maxAttempts) {
        await sleep(attempt * 500);
        continue;
      }
      throw error;
    }
  }
}

export async function uninstallProvider(
  agentId: string,
  providerId: string
): Promise<void> {
  const resp = await fetch(
    apiUrl(agentId, `/config/providers/${encodeURIComponent(providerId)}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }
  );
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to remove provider");
  }
}

export async function reorderProviders(
  agentId: string,
  providerIds: string[]
): Promise<void> {
  await jsonPatch(apiUrl(agentId, "/config/providers/reorder"), {
    providerIds,
  });
}

// ─── Provider Auth ─────────────────────────────────────────────────────────

export async function submitOAuthCode(
  providerId: string,
  code: string
): Promise<void> {
  const resp = await jsonPost(`/api/v1/auth/${providerId}/code`, { code });
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to verify code");
  }
}

export async function submitApiKey(
  providerId: string,
  apiKey: string,
  agentId: string
): Promise<void> {
  const resp = await jsonPost(`/api/v1/auth/${providerId}/save-key`, {
    agentId,
    apiKey,
  });
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to save API key");
  }
}

export async function startDeviceCode(
  providerId: string,
  agentId: string
): Promise<{
  userCode: string;
  verificationUrl: string;
  deviceAuthId: string;
  interval: number;
}> {
  const resp = await jsonPost(`/api/v1/auth/${providerId}/start`, {
    agentId,
  });
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to start auth");
  return data;
}

export async function pollDeviceCode(
  providerId: string,
  body: {
    deviceAuthId: string;
    userCode: string;
    agentId: string;
  }
): Promise<{ status: string; error?: string }> {
  const resp = await jsonPost(`/api/v1/auth/${providerId}/poll`, body);
  return parseJson(resp);
}

export async function disconnectProvider(
  providerId: string,
  agentId: string,
  profileId?: string
): Promise<void> {
  const body: Record<string, string> = { agentId };
  if (profileId) body.profileId = profileId;

  await jsonPost(`/api/v1/auth/${providerId}/logout`, body);
}

// ─── Install Callback ─────────────────────────────────────────────────────

export async function notifySkillInstalled(
  agentId: string,
  payload: {
    platform: string;
    channelId: string;
    conversationId: string;
    connectionId?: string;
    skills: string[];
  }
): Promise<void> {
  await jsonPost(apiUrl(agentId, "/install-callback"), payload);
}

// ─── Integrations ──────────────────────────────────────────────────────────

export async function fetchIntegrationsRegistry(query?: string): Promise<{
  mcps: Array<{ id: string; name: string; description: string }>;
}> {
  const url = query
    ? `/api/v1/integrations/registry?q=${encodeURIComponent(query)}`
    : "/api/v1/integrations/registry";
  const resp = await fetch(url);
  return parseJson(resp);
}

export async function fetchSkillContent(repo: string): Promise<{
  repo: string;
  name: string;
  description: string;
  content: string;
  fetchedAt: number;
  integrations?: Array<{
    id: string;
    label?: string;
    authType?: "oauth" | "api-key";
    scopes?: string[];
    apiDomains?: string[];
  }>;
  mcpServers?: Array<{
    id: string;
    name?: string;
    url?: string;
    type?: "sse" | "stdio";
    command?: string;
    args?: string[];
  }>;
  nixPackages?: string[];
  permissions?: string[];
  providers?: string[];
}> {
  const resp = await jsonPost("/api/v1/integrations/skills/fetch", { repo });
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to fetch skill");
  return data;
}

export async function saveSkills(
  agentId: string,
  skills: Skill[]
): Promise<void> {
  const resp = await jsonPatch(apiUrl(agentId, "/config"), {
    skillsConfig: { skills },
  });
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to save skills");
  }
}

export async function saveMcpServers(
  agentId: string,
  mcpServers: Record<string, McpConfig>
): Promise<void> {
  const resp = await jsonPatch(apiUrl(agentId, "/config"), { mcpServers });
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to save MCP servers");
  }
}

// ─── Schedules ─────────────────────────────────────────────────────────────

export async function fetchSchedules(agentId: string): Promise<
  Array<{
    scheduleId: string;
    task: string;
    scheduledFor: string;
    status: string;
    isRecurring?: boolean;
    cron?: string;
    iteration?: number;
    maxIterations?: number;
  }>
> {
  const resp = await fetch(apiUrl(agentId, "/schedules"));
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to load schedules");
  return data.schedules || [];
}

export async function cancelSchedule(
  agentId: string,
  scheduleId: string
): Promise<void> {
  const resp = await fetch(
    `/api/v1/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
    { method: "DELETE" }
  );
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to cancel reminder");
  }
}

// ─── Permissions ───────────────────────────────────────────────────────────

export async function fetchGrants(agentId: string): Promise<
  Array<{
    pattern: string;
    expiresAt: number | null;
    grantedAt?: number;
    denied?: boolean;
  }>
> {
  const resp = await fetch(apiUrl(agentId, "/config/grants"));
  if (!resp.ok) return [];
  return parseJson(resp);
}

export async function addGrant(
  agentId: string,
  pattern: string,
  expiresAt: number | null,
  denied?: boolean
): Promise<void> {
  await jsonPost(apiUrl(agentId, "/config/grants"), {
    pattern,
    expiresAt,
    denied: denied || undefined,
  });
}

export async function removeGrant(
  agentId: string,
  pattern: string
): Promise<void> {
  await fetch(
    apiUrl(agentId, `/config/grants/${encodeURIComponent(pattern)}`),
    { method: "DELETE" }
  );
}

// ─── Nix Packages ──────────────────────────────────────────────────────────

export async function searchNixPackages(
  agentId: string,
  query: string
): Promise<Array<{ name: string; pname?: string; description?: string }>> {
  const resp = await fetch(
    apiUrl(agentId, `/config/packages/search?q=${encodeURIComponent(query)}`)
  );
  const data = await parseJsonSafe(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to search packages");
  return Array.isArray(data.packages) ? data.packages : [];
}

// ─── Connections ────────────────────────────────────────────────────────────

export async function listConnections(agentId?: string): Promise<Connection[]> {
  const url = agentId
    ? `/api/v1/connections?templateAgentId=${encodeURIComponent(agentId)}`
    : "/api/v1/connections";
  const resp = await fetch(url);
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to load connections");
  return data.connections || [];
}

export async function createConnection(body: {
  platform: string;
  templateAgentId?: string;
  config: Record<string, any>;
  settings?: {
    allowFrom?: string[];
    allowGroups?: boolean;
    userConfigScopes?: string[];
  };
}): Promise<Connection> {
  const resp = await jsonPost("/api/v1/connections", body);
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to create connection");
  return data;
}

export async function updateConnection(
  id: string,
  body: {
    templateAgentId?: string | null;
    config?: Record<string, any>;
    settings?: {
      allowFrom?: string[];
      allowGroups?: boolean;
      userConfigScopes?: string[];
    };
  }
): Promise<Connection> {
  const resp = await jsonPatch(
    `/api/v1/connections/${encodeURIComponent(id)}`,
    body
  );
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to update connection");
  return data;
}

export async function deleteConnection(id: string): Promise<void> {
  const resp = await fetch(`/api/v1/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    const data = await parseJsonSafe(resp);
    throw new Error(data.error || "Failed to delete connection");
  }
}

export async function restartConnection(id: string): Promise<Connection> {
  const resp = await jsonPost(
    `/api/v1/connections/${encodeURIComponent(id)}/restart`,
    {}
  );
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to restart connection");
  return data;
}

export async function stopConnection(id: string): Promise<Connection> {
  const resp = await jsonPost(
    `/api/v1/connections/${encodeURIComponent(id)}/stop`,
    {}
  );
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to stop connection");
  return data;
}

// ─── Admin Agents ────────────────────────────────────────────────────────────

export interface AdminAgentEntry {
  agentId: string;
  name: string;
  description: string;
  owner: { platform: string; userId: string };
  parentConnectionId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export async function listAdminAgents(): Promise<AdminAgentEntry[]> {
  const resp = await fetch("/api/v1/admin/agents");
  if (!resp.ok) return [];
  const data = await parseJson(resp);
  return data.agents || [];
}

// ─── System Env Vars ──────────────────────────────────────────────────────────

export interface EnvVarEntry {
  key: string;
  /** Section ID: provider:<id>, integration:<id>, mcp:<name>, connections, gateway */
  section: string;
  label: string;
  isSet: boolean;
  maskedValue: string | null;
}

export async function listEnvVars(): Promise<EnvVarEntry[]> {
  const resp = await fetch("/api/v1/admin/env");
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to list env vars");
  return data.vars || [];
}

export async function setEnvVar(
  key: string,
  value: string
): Promise<{ success: boolean; maskedValue: string }> {
  const resp = await fetch(`/api/v1/admin/env/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to set env var");
  return data;
}

export async function deleteEnvVar(
  key: string
): Promise<{ success: boolean; isSet: boolean; maskedValue: string | null }> {
  const resp = await fetch(`/api/v1/admin/env/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  const data = await parseJson(resp);
  if (!resp.ok) throw new Error(data.error || "Failed to clear env var");
  return data;
}
