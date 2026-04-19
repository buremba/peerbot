import { describe, expect, it } from 'vitest';
import { resolveMcpEndpoint } from '../../../../packages/cli/src/commands/mcp';

describe('CLI MCP endpoint resolution', () => {
  it('prefers an explicit scoped mcpUrl from the active context', () => {
    expect(
      resolveMcpEndpoint({
        mcpUrl: 'https://example.com/mcp/public-owletto',
        apiUrl: 'https://example.com',
      })
    ).toBe('https://example.com/mcp/public-owletto');
  });

  it('derives /mcp from apiUrl when no explicit mcpUrl exists', () => {
    expect(
      resolveMcpEndpoint({
        apiUrl: 'https://example.com',
      })
    ).toBe('https://example.com/mcp');
  });
});
