import type { SkillConfig } from "@lobu/core";
import type Redis from "ioredis";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store";
import type { GrantStore } from "../permissions/grant-store";

const CONFIG_REQUEST_KEY_PREFIX = "pending-config:";

export interface PendingConfigSkill {
  repo: string;
  name?: string;
  description?: string;
  mcpServers?: Array<{
    id: string;
    name?: string;
    url?: string;
    type?: string;
    command?: string;
    args?: string[];
  }>;
  nixPackages?: string[];
  permissions?: string[];
  providers?: string[];
}

export interface PendingConfigRequest {
  agentId: string;
  reason: string;
  message?: string;
  skills?: PendingConfigSkill[];
  mcpServers?: Array<{
    id: string;
    name?: string;
    url?: string;
    type?: string;
    command?: string;
    args?: string[];
  }>;
  nixPackages?: string[];
  grants?: string[];
  providers?: string[];
}

export async function getPendingConfigRequest(
  redis: Redis,
  requestId: string
): Promise<PendingConfigRequest | null> {
  const raw = await redis.get(`${CONFIG_REQUEST_KEY_PREFIX}${requestId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingConfigRequest;
  } catch {
    return null;
  }
}

export async function deletePendingConfigRequest(
  redis: Redis,
  requestId: string
): Promise<void> {
  await redis.del(`${CONFIG_REQUEST_KEY_PREFIX}${requestId}`);
}

export function buildConfigRequestText(request: PendingConfigRequest): string {
  const lines = ["Configuration Change Request", `Reason: ${request.reason}`];

  if (request.message?.trim()) {
    lines.push(`Note: ${request.message.trim()}`);
  }

  if (request.skills?.length) {
    const names = request.skills.map((skill) => skill.name || skill.repo);
    lines.push(`Skills: ${names.join(", ")}`);
  }

  if (request.mcpServers?.length) {
    const ids = request.mcpServers.map((mcp) => mcp.name || mcp.id);
    lines.push(`MCP servers: ${ids.join(", ")}`);
  }

  if (request.nixPackages?.length) {
    lines.push(`Packages: ${request.nixPackages.join(", ")}`);
  }

  if (request.grants?.length) {
    lines.push(`Permissions: ${request.grants.join(", ")}`);
  }

  if (request.providers?.length) {
    lines.push(
      `Required providers (not changed by this approval): ${request.providers.join(", ")}`
    );
  }

  return lines.join("\n");
}

function mergeSkill(
  existingSkills: SkillConfig[],
  skill: PendingConfigSkill
): void {
  const nextSkill: SkillConfig = {
    repo: skill.repo,
    name: skill.name || skill.repo,
    description: skill.description || "",
    enabled: true,
    mcpServers: skill.mcpServers as SkillConfig["mcpServers"],
    nixPackages: skill.nixPackages,
    permissions: skill.permissions,
    providers: skill.providers,
  };

  const existingIndex = existingSkills.findIndex(
    (entry) => entry.repo === skill.repo
  );

  if (existingIndex >= 0 && existingSkills[existingIndex]) {
    existingSkills[existingIndex] = {
      ...existingSkills[existingIndex],
      ...nextSkill,
      enabled: true,
    };
    return;
  }

  existingSkills.push(nextSkill);
}

function mergeMcpServers(
  current: Record<string, Record<string, unknown>>,
  mcpServers: NonNullable<PendingConfigRequest["mcpServers"]>
): Record<string, Record<string, unknown>> {
  const merged = { ...current };

  for (const mcp of mcpServers) {
    const existing = merged[mcp.id] || {};
    merged[mcp.id] = {
      ...existing,
      enabled: true,
      ...(mcp.url ? { url: mcp.url } : {}),
      ...(mcp.type ? { type: mcp.type } : {}),
      ...(mcp.command ? { command: mcp.command } : {}),
      ...(mcp.args?.length ? { args: mcp.args } : {}),
      ...(mcp.name ? { name: mcp.name } : {}),
    };
  }

  return merged;
}

export async function applyPendingConfigRequest(
  agentSettingsStore: AgentSettingsStore,
  grantStore: GrantStore | undefined,
  request: PendingConfigRequest
): Promise<void> {
  const settings = await agentSettingsStore.getSettings(request.agentId);
  const nextSkills = [...(settings?.skillsConfig?.skills || [])];

  for (const skill of request.skills || []) {
    mergeSkill(nextSkills, skill);
  }

  const nextMcpServers = mergeMcpServers(
    (settings?.mcpServers || {}) as Record<string, Record<string, unknown>>,
    request.mcpServers || []
  );

  const existingPackages = settings?.nixConfig?.packages || [];
  const nextPackages = Array.from(
    new Set([...(existingPackages || []), ...(request.nixPackages || [])])
  );

  const updates: Record<string, unknown> = {};
  if (request.skills?.length) {
    updates.skillsConfig = { skills: nextSkills };
  }
  if (request.mcpServers?.length) {
    updates.mcpServers = nextMcpServers;
  }
  if (request.nixPackages?.length) {
    updates.nixConfig = {
      ...(settings?.nixConfig || {}),
      packages: nextPackages,
    };
  }

  if (Object.keys(updates).length > 0) {
    await agentSettingsStore.updateSettings(
      request.agentId,
      updates as Record<string, any>
    );
  }

  if (grantStore && request.grants?.length) {
    for (const pattern of request.grants) {
      await grantStore.grant(request.agentId, pattern, null);
    }
  }
}
