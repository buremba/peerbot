type JsonRpcResponse<T = unknown> = {
  result?: T;
  error?: { code: number; message: string };
};

export class McpJsonClient {
  constructor(
    private readonly mcpUrl: string,
    private readonly token?: string
  ) {}

  private async fetch(body: Record<string, unknown>, sessionId?: string): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const response = await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  private async initialize(): Promise<string> {
    const initializeResponse = await this.fetch({
      jsonrpc: '2.0',
      id: '__init__',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'owletto-memory-benchmark', version: '1.0.0' },
      },
    });

    const sessionId = initializeResponse.headers.get('mcp-session-id');
    if (!sessionId) {
      throw new Error('MCP initialize did not return mcp-session-id');
    }

    const initializeJson = (await initializeResponse.json()) as JsonRpcResponse;
    if (initializeJson.error) {
      throw new Error(`MCP initialize error: ${initializeJson.error.message}`);
    }

    await this.fetch(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      sessionId
    );

    return sessionId;
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const sessionId = await this.initialize();
    const response = await this.fetch(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      sessionId
    );

    const json = (await response.json()) as {
      error?: { code: number; message: string };
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
    };

    if (json.error) {
      throw new Error(`MCP error [${json.error.code}]: ${json.error.message}`);
    }

    if (json.result?.isError) {
      throw new Error(json.result.content?.[0]?.text ?? 'MCP tool execution failed');
    }

    const text = json.result?.content?.[0]?.text;
    if (!text) {
      return json.result as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
}
