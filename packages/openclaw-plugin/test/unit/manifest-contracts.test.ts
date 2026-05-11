import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_MCP_TOOL_NAMES, LOGIN_TOOL_NAMES } from '../../src/index.js';
import { MEMORY_WIKI_COMPAT_TOOL_NAMES } from '../../src/memory-wiki-compat.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(
  readFileSync(resolve(packageRoot, 'openclaw.plugin.json'), 'utf-8')
) as { contracts?: { tools?: unknown } };

// Every tool the plugin can register at runtime, derived from the same constants
// the runtime uses, so the manifest can't silently drift away from the code.
const expectedTools = [
  ...LOGIN_TOOL_NAMES,
  ...[...KNOWN_MCP_TOOL_NAMES].map((name) => `lobu_${name}`),
  ...MEMORY_WIKI_COMPAT_TOOL_NAMES,
];

describe('openclaw.plugin.json contracts.tools', () => {
  it('declares contracts.tools (OpenClaw 2026.5.x rejects registerTool without it)', () => {
    expect(Array.isArray(manifest.contracts?.tools)).toBe(true);
    expect((manifest.contracts!.tools as string[]).length).toBeGreaterThan(0);
  });

  it('matches exactly the set of tools the plugin registers', () => {
    const declared = (manifest.contracts!.tools as string[]).slice().sort();
    expect(declared).toEqual([...expectedTools].sort());
  });

  it('has no duplicate entries', () => {
    const declared = manifest.contracts!.tools as string[];
    expect(new Set(declared).size).toBe(declared.length);
  });
});
