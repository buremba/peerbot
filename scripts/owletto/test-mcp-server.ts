/**
 * Minimal MCP server for testing the proxy pipeline.
 * Exposes a single tool: echo(message) → returns the message.
 * Runs on port 8799.
 */
import { randomUUID } from 'node:crypto';

const PORT = 8799;
const sessions = new Map<string, boolean>();

function jsonRpcResponse(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const _server = Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', name: 'test-mcp-server' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = (await req.json()) as any;
    const sessionId = req.headers.get('mcp-session-id');

    switch (body.method) {
      case 'initialize': {
        const newSessionId = randomUUID();
        sessions.set(newSessionId, true);
        return new Response(
          jsonRpcResponse(body.id, {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
            instructions:
              'This is a test MCP server for proxy testing. Use the echo tool to echo messages.',
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Mcp-Session-Id': newSessionId,
            },
          }
        );
      }

      case 'notifications/initialized':
        return new Response('', { status: 204 });

      case 'tools/list':
        return new Response(
          jsonRpcResponse(body.id, {
            tools: [
              {
                name: 'echo',
                description: 'Echo a message back. Useful for testing MCP proxy connectivity.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', description: 'The message to echo' },
                  },
                  required: ['message'],
                },
              },
              {
                name: 'server_info',
                description: 'Get test server info and current time.',
                inputSchema: {
                  type: 'object',
                  properties: {},
                },
              },
            ],
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              ...(sessionId && { 'Mcp-Session-Id': sessionId }),
            },
          }
        );

      case 'tools/call': {
        const { name, arguments: args } = body.params;
        let content;

        if (name === 'echo') {
          content = [{ type: 'text', text: `Echo: ${args?.message || '(empty)'}` }];
        } else if (name === 'server_info') {
          content = [
            {
              type: 'text',
              text: `Test MCP Server v1.0.0 | Time: ${new Date().toISOString()} | Proxy pipeline working!`,
            },
          ];
        } else {
          return new Response(jsonRpcError(body.id, -32601, `Unknown tool: ${name}`), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(jsonRpcResponse(body.id, { content }), {
          headers: {
            'Content-Type': 'application/json',
            ...(sessionId && { 'Mcp-Session-Id': sessionId }),
          },
        });
      }

      default:
        return new Response(
          jsonRpcError(body.id ?? null, -32601, `Unknown method: ${body.method}`),
          { headers: { 'Content-Type': 'application/json' } }
        );
    }
  },
});

console.log(`Test MCP server running on http://localhost:${PORT}`);
