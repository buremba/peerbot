import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This test pulls a helper out of the `packages/owletto` git submodule. On fresh
// clones (or forks without the deploy key) the submodule isn't initialized,
// so the import path doesn't exist. Detect that and skip the suite instead
// of failing the whole vitest run.
const targetsModulePath = fileURLToPath(
  new URL('../../../../owletto/src/lib/mcp-install-targets.ts', import.meta.url),
);
const submoduleAvailable = existsSync(targetsModulePath);

const getMcpInstallTargets = submoduleAvailable
  ? (await import('../../../../owletto/src/lib/mcp-install-targets')).getMcpInstallTargets
  : (() => {
      throw new Error('packages/owletto submodule not initialized');
    });

const describeIfSubmodule = submoduleAvailable ? describe : describe.skip;

describeIfSubmodule('getMcpInstallTargets', () => {
  const mcpUrl = 'http://localhost:4821/mcp/public-lobu';

  it('returns all first-class MCP targets', () => {
    const targets = getMcpInstallTargets(mcpUrl);

    expect(targets.map((target) => target.id)).toEqual([
      'skills',
      'codex',
      'chatgpt',
      'claude-desktop',
      'claude-code',
      'gemini-cli',
      'cursor',
      'lobu-cli',
    ]);
  });

  it('uses the runtime mcpUrl in generated commands', () => {
    const targets = getMcpInstallTargets(mcpUrl);
    const codex = targets.find((target) => target.id === 'codex');

    expect(codex?.actions).toContainEqual({
      type: 'command',
      label: 'Add MCP server',
      value: `codex mcp add lobu --url ${mcpUrl}`,
    });
  });

  it('encodes the runtime mcpUrl into the Cursor install link', () => {
    const targets = getMcpInstallTargets(mcpUrl);
    const cursor = targets.find((target) => target.id === 'cursor');
    const link = cursor?.actions.find(
      (action: { type: string }) => action.type === 'link'
    );

    expect(link?.type).toBe('link');

    const href = new URL((link as { href: string }).href);
    expect(href.searchParams.get('name')).toBe('lobu');

    const encodedConfig = href.searchParams.get('config');
    expect(encodedConfig).toBeTruthy();

    const configJson = Buffer.from(encodedConfig!, 'base64').toString('utf-8');
    expect(JSON.parse(configJson)).toEqual({ url: mcpUrl });
  });
});
