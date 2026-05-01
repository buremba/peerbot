import { describe, expect, it } from 'vitest';
import { getMcpInstallTargets } from '../../../../web/src/lib/mcp-install-targets';

describe('getMcpInstallTargets', () => {
  const mcpUrl = 'http://localhost:4821/mcp/public-owletto';

  it('returns all first-class MCP targets', () => {
    const targets = getMcpInstallTargets(mcpUrl);

    expect(targets.map((target) => target.id)).toEqual([
      'codex',
      'chatgpt',
      'claude-desktop',
      'claude-code',
      'gemini-cli',
      'cursor',
      'openclaw',
    ]);
  });

  it('uses the runtime mcpUrl in generated commands', () => {
    const targets = getMcpInstallTargets(mcpUrl);
    const codex = targets.find((target) => target.id === 'codex');
    const openclaw = targets.find((target) => target.id === 'openclaw');

    expect(codex?.actions).toContainEqual({
      type: 'command',
      label: 'Add MCP server',
      value: `codex mcp add owletto --url ${mcpUrl}`,
    });

    expect(openclaw?.actions).toContainEqual({
      type: 'command',
      label: 'Install plugin',
      value: 'openclaw plugins install @lobu/openclaw-plugin',
    });
    expect(openclaw?.actions).toContainEqual({
      type: 'command',
      label: 'Log in to Lobu',
      value: 'lobu login',
    });
    expect(openclaw?.actions).toContainEqual({
      type: 'command',
      label: 'Write plugin config',
      value: `lobu memory configure --url ${mcpUrl}`,
    });
    expect(openclaw?.actions).toContainEqual({
      type: 'command',
      label: 'Verify connectivity',
      value: `lobu memory health --url ${mcpUrl}`,
    });
  });

  it('encodes the runtime mcpUrl into the Cursor install link', () => {
    const targets = getMcpInstallTargets(mcpUrl);
    const cursor = targets.find((target) => target.id === 'cursor');
    const link = cursor?.actions.find((action) => action.type === 'link');

    expect(link?.type).toBe('link');

    const href = new URL((link as { href: string }).href);
    expect(href.searchParams.get('name')).toBe('owletto');

    const encodedConfig = href.searchParams.get('config');
    expect(encodedConfig).toBeTruthy();

    const configJson = Buffer.from(encodedConfig!, 'base64').toString('utf-8');
    expect(JSON.parse(configJson)).toEqual({ url: mcpUrl });
  });
});
