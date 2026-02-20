export interface McpSearchResult {
  id: string;
  canonicalId: string;
  name: string;
  description: string;
  source: string;
}

export interface McpDetails extends McpSearchResult {
  prefillMcpServer: {
    id: string;
    name?: string;
    url?: string;
    type?: "sse" | "stdio";
  };
}

export interface McpInstallResult {
  mcp: McpDetails;
  url: string;
  expiresAt: string;
}

export interface McpDiscoveryClient {
  search(query: string, limit?: number): Promise<McpSearchResult[]>;
  getById(mcpId: string): Promise<McpDetails>;
  install(mcpId: string, reason?: string): Promise<McpInstallResult>;
}

export function createMcpDiscoveryClient(
  gatewayUrl: string,
  workerToken: string
): McpDiscoveryClient {
  const headers = { Authorization: `Bearer ${workerToken}` };

  async function search(query: string, limit = 5): Promise<McpSearchResult[]> {
    const response = await fetch(
      `${gatewayUrl}/internal/mcp/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { headers }
    );

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({ error: response.statusText }))) as {
        error?: string;
      };
      throw new Error(errorData.error || "Failed to search MCP registry");
    }

    const data = (await response.json()) as { results: McpSearchResult[] };
    return data.results;
  }

  async function getById(mcpId: string): Promise<McpDetails> {
    const response = await fetch(
      `${gatewayUrl}/internal/mcp/registry/${encodeURIComponent(mcpId)}`,
      { headers }
    );

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({ error: response.statusText }))) as {
        error?: string;
      };
      throw new Error(errorData.error || "Failed to load MCP details");
    }

    const data = (await response.json()) as { mcp: McpDetails };
    return data.mcp;
  }

  async function install(
    mcpId: string,
    reason?: string
  ): Promise<McpInstallResult> {
    const mcp = await getById(mcpId);
    const installReason =
      reason ||
      `Install MCP server "${mcp.name}" so it can be used in this agent`;

    const response = await fetch(`${gatewayUrl}/internal/settings-link`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reason: installReason,
        prefillMcpServers: [mcp.prefillMcpServer],
      }),
    });

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({ error: response.statusText }))) as {
        error?: string;
      };
      throw new Error(errorData.error || "Failed to generate install link");
    }

    const result = (await response.json()) as {
      url: string;
      expiresAt: string;
    };
    return { mcp, ...result };
  }

  return { search, getById, install };
}

export function formatSearchResults(results: McpSearchResult[]): string {
  return results
    .slice(0, 5)
    .map(
      (item, index) =>
        `${index + 1}. ${item.name} (${item.id})\n   ${item.description || "No description"}\n   source: ${item.source}`
    )
    .join("\n\n");
}
