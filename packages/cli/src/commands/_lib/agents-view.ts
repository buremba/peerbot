import { resolveApiClient } from "../../internal/index.js";

/**
 * Shape returned by `GET /api/<org>/agents`. Superset of the fields the
 * `status` and `agent list` views render — both commands fetch the same
 * endpoint, so the type and fetch live here once.
 */
export interface AgentSummary {
  agentId: string;
  name: string;
  description?: string;
  connectionCount?: number;
  activeConnectionCount?: number;
  clientCount?: number;
  status?: string;
}

export interface FetchedAgents {
  agents: AgentSummary[];
  orgSlug: string;
  apiBaseUrl: string;
}

/** Resolve the API client + org and fetch the org's agents. */
export async function fetchAgents(
  options: { context?: string; org?: string } = {}
): Promise<FetchedAgents> {
  const { client, orgSlug, apiBaseUrl } = await resolveApiClient(options);
  const data = await client.get<{ agents?: AgentSummary[] }>(
    `/api/${orgSlug}/agents`
  );
  return { agents: data.agents ?? [], orgSlug, apiBaseUrl };
}

/** The `connections:X active:Y clients:Z` counts fragment shared by both views. */
export function agentCountsText(agent: AgentSummary): string {
  return `connections:${agent.connectionCount ?? 0} active:${agent.activeConnectionCount ?? 0} clients:${agent.clientCount ?? 0}`;
}
